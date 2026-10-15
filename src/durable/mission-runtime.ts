/**
 * Runtime de mission durable (Plan 0002 §5, ADR-008 D2/D3/D4/D6/D7) — la SEULE
 * implémentation d'exécution Durable du produit, atteinte par le point de
 * composition explicite `src/runtime.ts`. Aucun autre code ne doit ouvrir un
 * stockage Durable ou lancer un harnais : pas de processus non gérés.
 *
 * Garanties à l'ouverture (Plan 0002 §8.2) :
 * 1. bail d'exécution OS-acquis avant l'ouverture du stockage ; un second
 *    processus sort sans rien planifier ;
 * 2. stockage SQLite en `synchronous = FULL` (le défaut du SDK est NORMAL) ;
 * 3. profil de mission gelé vérifié (SDK pin, snapshot preset, toolchain) —
 *    toute divergence rejette l'ouverture (fail closed) ;
 * 4. workers orphelins classés (vivant → orphelin à observer/arrêter ; mort
 *    sans disposition → issue inconnue) avant d'activer la planification ;
 * 5. la planification Durable n'est activée qu'après ces vérifications.
 *
 * Admission (P3b, ticket #16) : les envois sont acceptés durablement, mais ne
 * sont dispatchés que si la mission est admise (budget + slot + claim
 * workspace). Sinon l'input reste dans une file durable et VISIBLE (queued /
 * budget_paused — jamais d'échec d'envoi ni de travail caché). Approbations et
 * receipts vivent ici (vérité Durable, D4) ; le dispatch d'un effet protégé
 * passe par `runProtectedEffect` (consommation de grant + association d'intent
 * atomiques, scope exact rechecké immédiatement avant l'effet).
 */

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  defineDoc,
  Harness,
  UsageDoc,
  watchEvents,
  type AgentEvent,
  type Conversation,
  type EntryRecord,
  type Extension,
  type Registry,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { acquireRuntimeLease, type RuntimeLease } from "./lease.js";
import { MissionProfile, freezeMissionProfile, assertProfileFrozen } from "./profile.js";
import { WorkerRecords, classifyWorkers, unresolvedWorkers, type WorkerClassification, type WorkerRecord } from "./workers.js";
import {
  MissionApprovals,
  GrantRejectedError,
  createPendingAction,
  decidePendingAction,
  findValidGrant,
  revokeGrant,
  type ApprovalDecisionResult,
  type EffectDescriptor,
  type EffectReceipt,
  type PendingAction,
} from "./approvals.js";
import {
  dailyUsage,
  evaluateBudget,
  rollDailyBaseline,
  type BudgetBinding,
  type BudgetPolicy,
  type UsageTotals,
} from "./admission.js";

/** requestId borné et stable (caractères sûrs, 1–128). Miroir de schemas.ts. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class NeedsAttentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsAttentionError";
  }
}

export { GrantRejectedError };

/** Toolchain classée approuvée, gelée dans le profil de mission. */
export interface ApprovedToolchain {
  commands: readonly string[];
  mcpServers: readonly string[];
}

/** Input accepté durablement mais pas encore dispatché (file visible). */
export type QueuedInput = {
  requestId: string;
  text: string;
  queuedAt: number;
}

type MissionQueueDoc = {
  inputs: QueuedInput[];
  /** Dénégation durable en vigueur : la mission exige une décision owner (UA1). */
  attention?: { reason: string; at: number };
}

const MissionQueue = defineDoc<MissionQueueDoc>({
  kind: "cogitator.mission-queue",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ inputs: [] }),
});

type MissionBudgetDoc = {
  policy: BudgetPolicy;
  /** Cumuls depuis le début de mission (dérivés de pi.usage, jamais reset). */
  missionCalls: number;
  missionTokens: number;
  /** Point de base du jour civil UTC courant (reset automatique à minuit UTC). */
  baseline: { day: string; calls: number; tokens: number };
  updatedAt: number;
}

const MissionBudget = defineDoc<MissionBudgetDoc>({
  kind: "cogitator.mission-budget",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ policy: {}, missionCalls: 0, missionTokens: 0, baseline: { day: "", calls: 0, tokens: 0 }, updatedAt: 0 }),
});

export type MissionState = "idle" | "running" | "queued" | "waiting_approval" | "budget_paused" | "needs_attention";

export interface MissionStatusView {
  state: MissionState;
  /** Motif visible (limite liante, claim détenu par…, slots pleins, …). */
  reason?: string;
  queueLength: number;
  budget: {
    policy: BudgetPolicy;
    missionUsed: UsageTotals;
    dailyUsed: UsageTotals;
    binding?: BudgetBinding;
  };
  workspaceDir: string;
  workspaceClaimed: boolean;
  workspaceClaimedBy?: string;
}

/** Plan de contrôle fourni par le gestionnaire (slots partagés, claims, drain). */
export interface MissionControlPlane {
  readonly workspaceDir: string;
  /** Admission immédiate : budget (via runtime) + slot + claim. */
  tryAdmit(): { admitted: true } | { admitted: false; reason: string };
  /** Relâche slot + claim APRÈS arrêt des écritures, puis tente d'admettre la file. */
  release(): void;
  /** Détail du claim pour la projection de statut. */
  claimHolder(): string | undefined;
  /** Notifie un changement d'état de mission (fan-out SSE). */
  emit(state: MissionStatusView): void;
}

export interface DurableMissionOpenOptions {
  /** Dossier de stockage Durable propre à la conversation (créé au besoin). */
  dir: string;
  /** Workspace d'exécution (cwd de l'environnement de la mission). */
  cwd: string;
  /** Modèle figé de la conversation. */
  model: { provider: string; modelId: string };
  /** Digest du snapshot spawn figé à la création (O6). */
  presetDigest: string;
  /** Accès modèles : contrôleur (builtinModels, clés détenues par le contrôleur) ou faux en test. */
  models: Models;
  /** Registre d'extensions, installé avant l'ouverture. */
  registry: Registry;
  /** Extensions sélectionnées par l'agent à la création (gelées par nom). */
  agentExtensions: readonly Extension[];
  /** Commandes/serveurs MCP approuvés, gelés dans le profil. */
  toolchain: ApprovedToolchain;
  /** Plan de contrôle d'admission (slots/claims partagés + émission d'état).
   *  Défaut : plan permissif sans admission (usage direct hors serveur, ex.
   *  driver SIGKILL) — toujours admis, aucun claim, émission ignorée. */
  control?: MissionControlPlane;
}

/** Plan de contrôle par défaut : pas d'admission (dispatch immédiat). */
const PERMISSIVE_CONTROL: MissionControlPlane = {
  workspaceDir: "",
  tryAdmit: () => ({ admitted: true }),
  release: () => undefined,
  claimHolder: () => undefined,
  emit: () => undefined,
};

export interface MissionRecovery {
  /** Classification des workers enregistrés à l'ouverture. */
  workers: WorkerClassification[];
  /** true si un worker non résolu exige une décision (Plan 0002 §5.7). */
  needsAttention: boolean;
  reasons: string[];
}

export interface DispatchDecision {
  /** Identité de soumission acceptée (présente si dispatchée au SDK). */
  submissionId?: SubmissionId;
  /** true quand ce requestId était déjà accepté : aucun travail dupliqué. */
  duplicate: boolean;
  /** true quand l'input est accepté mais retenu en file visible (queued/budget_paused). */
  queued: boolean;
}

export class DurableMissionRuntime {
  /** Écritures en cours (turns dispatchés) : le claim se relâche à zéro. */
  private activeWrites = 0;
  private draining = false;
  private closed = false;

  private constructor(
    private readonly harness: Harness,
    private readonly root: Conversation,
    private readonly lease: RuntimeLease,
    private readonly registry: Registry,
    private readonly control: MissionControlPlane,
    /** État de récupération à l'ouverture (workers orphelins classés). */
    readonly recovery: MissionRecovery,
  ) {}

  static async open(opts: DurableMissionOpenOptions): Promise<DurableMissionRuntime> {
    const lease = acquireRuntimeLease(opts.dir);
    try {
      // FULL = durability exigée par le déploiement (constat P0 : le défaut est NORMAL).
      const database = await openNodeSqliteDatabase(join(opts.dir, "runtime.sqlite"));
      await database.exec("PRAGMA synchronous = FULL");
      const storage = await SqliteStorage.open(database);
      const installedExtensions = opts.registry.snapshot().installed().map((e) => e.name);
      const versions = freezeMissionProfile(opts.presetDigest, {
        commands: [...opts.toolchain.commands].sort(),
        mcpServers: [...opts.toolchain.mcpServers].sort(),
        extensions: [...installedExtensions].sort(),
      });
      const harness = await Harness.open(
        storage,
        {
          models: opts.models,
          registry: opts.registry,
          env: () => new NodeExecutionEnv({ cwd: opts.cwd }),
          // Profil figé du seam (constat P0) : pas de retry implicite — la politique
          // de retry budgétée des missions est une slice P3 ultérieure ; la compaction
          // n'a pas de politique de mission à ce stade.
          settings: { compaction: { enabled: false }, retry: { enabled: false } },
        },
        context,
      );
      const root = await harness.root(
        context,
        {
          agent: { extensions: opts.agentExtensions, model: opts.model },
          // Gel à la création uniquement : sur réouverture le document existe et n'est pas écrasé.
          init: async (tx, id) => {
            const doc = await tx.doc(MissionProfile, id);
            if (!doc.createdAt) Object.assign(doc, { ...versions, createdAt: Date.now() });
          },
        },
      );
      const runtime = new DurableMissionRuntime(harness, root, lease, opts.registry, opts.control ?? PERMISSIVE_CONTROL, {
        workers: [],
        needsAttention: false,
        reasons: [],
      });
      await runtime.verifyFrozenProfile(versions);
      await runtime.reconcileWorkers();
      // Planification activée seulement après vérification bail/versions/état ;
      // si un orphelin n'est pas classé, la readiness reste fausse (Plan 0002 §8.2).
      if (!runtime.recovery.needsAttention) harness.resume();
      // Reprise : les inputs retenus en file (slots/budget à l'ancienne session)
      // restent durables ; on retente l'admission maintenant que la runtime est ouverte.
      void runtime.tryDrainQueue();
      return runtime;
    } catch (err) {
      lease.release();
      throw err;
    }
  }

  /** Preflight fail-closed : profil gelé (stockage Durable) vs versions installées. */
  private async verifyFrozenProfile(expected: ReturnType<typeof freezeMissionProfile>): Promise<void> {
    const stored = await this.harness.snapshot(MissionProfile, this.root.id, context);
    const installed = this.registry.snapshot().installed().map((e) => e.name);
    assertProfileFrozen(stored ? { ...stored } : undefined, expected, installed);
  }

  /** Reclasse les workers persistés (§5.7) et expose le résultat de récupération. */
  private async reconcileWorkers(): Promise<void> {
    const doc = await this.harness.snapshot(WorkerRecords, this.root.id, context);
    const workers = classifyWorkers(doc?.workers ?? []);
    const unresolved = unresolvedWorkers(workers);
    this.recovery.workers = workers;
    this.recovery.needsAttention = unresolved.length > 0;
    this.recovery.reasons = unresolved.map(
      (u) => u.kind === "live-orphan"
        ? `worker ${u.record.id} (pid ${u.record.pid}) toujours vivant : observer/arrêter avant remplacement`
        : `worker ${u.record.id} (pid ${u.record.pid}) mort sans issue établie : réconciliation requise`,
    );
  }

  // ---------- File d'attente durable et admission ----------

  private async queuedInputs(): Promise<QueuedInput[]> {
    const doc = await this.harness.snapshot(MissionQueue, this.root.id, context);
    return doc?.inputs ?? [];
  }

  /** État budget courant : cumuls re-lus depuis le transcript et pi.usage, base journalière roulée à UTC. */
  async budgetState(now = Date.now()): Promise<MissionStatusView["budget"]> {
    // Requêtes modèle = entrées d'assistant commitées (authoritative, indépendant
    // du reporting d'usage du provider) ; tokens depuis pi.usage quand le provider
    // les rapporte (sinon 0 — la limite tokens reste applicable dès qu'ils sont là).
    const entries = (await this.root.context(context)).entries;
    const calls = entries.filter((e) => e.kind === "pi.assistant").length;
    const usage = (await this.harness.snapshot(UsageDoc, this.root.id, context)) ?? { models: {}, tools: {} };
    let tokens = 0;
    for (const modelUsage of Object.values(usage.models)) {
      const u = modelUsage as { totalTokens?: number } | undefined;
      tokens += u?.totalTokens ?? 0;
    }
    const doc = await this.harness.snapshot(MissionBudget, this.root.id, context);
    const policy = doc?.policy ?? {};
    const missionUsed: UsageTotals = { calls, tokens };
    const baseline = rollDailyBaseline(doc?.baseline ?? { day: "", calls: 0, tokens: 0 }, missionUsed, now);
    if (doc && (doc.missionCalls !== calls || doc.missionTokens !== tokens || doc.baseline.day !== baseline.day)) {
      await this.root.commit(async (tx) => {
        const d = await tx.doc(MissionBudget, this.root.id);
        d.missionCalls = calls;
        d.missionTokens = tokens;
        d.baseline = baseline;
        d.updatedAt = now;
      }, context);
    }
    const dailyUsed = dailyUsage(baseline, missionUsed, now);
    const evaluated = evaluateBudget(policy, missionUsed, dailyUsed, now);
    return {
      policy,
      missionUsed,
      dailyUsed,
      ...(evaluated.status === "budget_paused" ? { binding: evaluated.binding } : {}),
    };
  }

  /** Change EXPLICITEMENT la politique de budget (owner) ; relance la file si déliée. */
  async setBudgetPolicy(policy: BudgetPolicy): Promise<void> {
    await this.root.commit(async (tx) => {
      const doc = await tx.doc(MissionBudget, this.root.id);
      doc.policy = policy;
      doc.updatedAt = Date.now();
    }, context);
    this.control.emit(await this.missionStatus());
    await this.tryDrainQueue();
  }

  /**
   * Projection de statut de mission (authoritative, dérivée des documents
   * durables : file, budget, approbations, workers). priorité :
   * needs_attention > budget_paused > waiting_approval > queued > running/idle.
   */
  async missionStatus(now = Date.now()): Promise<MissionStatusView> {
    const budget = await this.budgetState(now);
    const queue = await this.queuedInputs();
    const approvals = await this.approvalsView();
    const holder = this.control.claimHolder();
    const base = {
      queueLength: queue.length,
      budget,
      workspaceDir: this.control.workspaceDir,
      workspaceClaimed: holder !== undefined,
      workspaceClaimedBy: holder,
    };
    if (this.recovery.needsAttention) {
      return { state: "needs_attention", reason: this.recovery.reasons.join("; "), ...base };
    }
    const queueDoc = await this.harness.snapshot(MissionQueue, this.root.id, context);
    if (queueDoc?.attention) {
      return { state: "needs_attention", reason: queueDoc.attention.reason, ...base };
    }
    if (budget.binding) {
      return { state: "budget_paused", reason: `limite ${budget.binding.kind} atteinte (${budget.binding.used}/${budget.binding.limit})`, ...base };
    }
    if (approvals.pendingActions.some((p) => p.decision === "pending")) {
      return { state: "waiting_approval", reason: "action sensible en attente de décision owner", ...base };
    }
    if (queue.length > 0) {
      const admission = this.control.tryAdmit();
      return {
        state: "queued",
        ...(admission.admitted ? {} : { reason: admission.reason }),
        ...base,
      };
    }
    return { state: this.activeWrites > 0 ? "running" : "idle", ...base };
  }

  /**
   * Retente la dispatch des inputs retenus : admission (budget → slot → claim),
   * puis soumission IN ORDER au SDK. Un seul drain à la fois ; les arrivées
   * pendant un drain se représentent au drain suivant.
   */
  async tryDrainQueue(): Promise<void> {
    if (this.draining || this.closed || this.recovery.needsAttention) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.closed) break;
        const queue = await this.queuedInputs();
        if (queue.length === 0) break;
        const budget = await this.budgetState();
        if (budget.binding) break; // budget_paused : la file reste visible, aucun dispatch
        const admission = this.control.tryAdmit();
        if (!admission.admitted) break;
        const input = queue[0]!;
        // Un échec de dispatch laisse l'input en tête de file : la tentative
        // suivante le reprend (jamais de perte ni de duplication).
        try {
          await this.dispatch(input.text, input.requestId);
        } catch {
          break;
        }
        await this.root.commit(async (tx) => {
          const doc = await tx.doc(MissionQueue, this.root.id);
          doc.inputs = doc.inputs.filter((i) => i.requestId !== input.requestId);
        }, context);
      }
    } catch (err) {
      // La file durable conserve l'input : l'erreur (fermeture concurrente ou
      // stockage) se représentera à la prochaine tentative ; un drain ne doit
      // jamais rejeter vers des appelants fire-and-forget.
      void err;
    } finally {
      this.draining = false;
      if (!this.closed) {
        const status = await this.missionStatus().catch(() => null);
        if (status) this.control.emit(status);
      }
    }
  }

  /** Soumet une entrée utilisateur avec un requestId stable et borné. L'accusé
   * n'est renvoyé qu'APRÈS l'acceptation durable. Un requestId déjà accepté ne
   * duplique JAMAIS le travail. Si la mission n'est pas admise (budget/slots/
   * claim), l'input est retenu dans la file durable et VISIBLE (l'envoi reste
   * accepté : jamais d'échec invitant à une duplication accidentelle). */
  async submit(text: string, requestId: string): Promise<DispatchDecision> {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error(`requestId invalide (1–128, [A-Za-z0-9._-]): ${requestId}`);
    }
    const unresolved = unresolvedWorkers(this.recovery.workers);
    if (unresolved.length > 0) {
      // Pas de travail de remplacement tant qu'un worker orphelin n'est pas classé.
      throw new NeedsAttentionError(this.recovery.reasons.join("; "));
    }
    const prior = await this.root.commit((tx) => tx.submissionByRequest(this.root.id, requestId), context);
    if (prior) return { submissionId: prior.id, duplicate: true, queued: false };
    const queued = await this.queuedInputs();
    if (queued.some((i) => i.requestId === requestId)) {
      return { duplicate: true, queued: true };
    }
    // Admission : budget d'abord (budget_paused nomme la limite liante), puis
    // slots + claim via le plan de contrôle. En écriture active, la mission
    // détient déjà slot et claim : dispatch direct.
    const budget = await this.budgetState();
    if (budget.binding || this.activeWrites === 0) {
      if (budget.binding || this.control.tryAdmit().admitted === false) {
        await this.root.commit(async (tx) => {
          const doc = await tx.doc(MissionQueue, this.root.id);
          doc.inputs.push({ requestId, text, queuedAt: Date.now() });
        }, context);
        this.control.emit(await this.missionStatus());
        void this.tryDrainQueue();
        return { duplicate: false, queued: true };
      }
    }
    const submissionId = await this.dispatch(text, requestId).catch((err) => {
      // Dispatch impossible : on ne garde pas le slot/claim acquis pour rien.
      this.control.release();
      throw err;
    });
    return { submissionId, duplicate: false, queued: false };
  }

  /** Soumission effective au SDK + suivi d'écritures (relâchement à l'idle). */
  private async dispatch(text: string, requestId: string): Promise<SubmissionId> {
    const submission = await this.root.submit({ type: "input", content: text, requestId }, context);
    // Un dispatch réussi lève toute condition de denégation antérieure.
    await this.root.commit(async (tx) => {
      const doc = await tx.doc(MissionQueue, this.root.id);
      if (doc.attention) delete doc.attention;
    }, context);
    this.trackWrites();
    return submission.id;
  }

  /** Compte l'activité : le slot et le claim ne se relâchent qu'à l'arrêt des écritures. */
  private trackWrites(): void {
    this.activeWrites += 1;
    void this.root.waitForIdle(context)
      .catch(() => undefined)
      .finally(() => {
        this.activeWrites -= 1;
        if (this.activeWrites === 0) {
          this.control.release();
          void this.tryDrainQueue();
        }
      });
  }

  // ---------- Approbations (owner) et effets protégés ----------

  /** Vue lectures des pending actions, grants et receipts (panneau owner). */
  async approvalsView(): Promise<{ pendingActions: PendingAction[]; grants: ApprovalGrantView[]; receipts: EffectReceipt[] }> {
    const doc = await this.harness.snapshot(MissionApprovals, this.root.id, context);
    return {
      pendingActions: doc?.pendingActions ?? [],
      grants: (doc?.grants ?? []).map((g) => ({
        ...g,
        valid: !("reason" in findValidGrant([g], g, Date.now())),
      })),
      receipts: doc?.receipts ?? [],
    };
  }

  /**
   * Crée côté SERVEUR une action en attente (immuables : opération, cible,
   * digests artefact/arguments, expiration, uses). Le client ne peut approuver
   * QUE ces actions-là. Une demande identique déjà pending/denied est réutilisée
   * (jamais re-demandée en boucle, UA1).
   */
  async requestPendingAction(
    input: EffectDescriptor & { consequence: string; expiresAt: number; allowedUses: number },
  ): Promise<PendingAction> {
    const action = await this.root.commit(async (tx) => {
      const doc = await tx.doc(MissionApprovals, this.root.id);
      return createPendingAction(doc, input, Date.now());
    }, context);
    this.control.emit(await this.missionStatus());
    return action;
  }

  /** Décision owner (approve/deny) sur une action serveur ; denial durable (UA1). */
  async decideApproval(
    pendingActionId: string,
    decision: "approved" | "denied",
    denialReason?: string,
  ): Promise<ApprovalDecisionResult> {
    const result = await this.root.commit(
      (tx) => tx.doc(MissionApprovals, this.root.id).then((doc) => decidePendingAction(doc, pendingActionId, decision, Date.now(), denialReason)),
      context,
    );
    if (result.kind === "decided" && decision === "denied") {
      // Dénégation durable : la mission passe en needs_attention (reason
      // action_denied) ; aucun effet ne court, rien n'est re-demandé (UA1).
      await this.root.commit(async (tx) => {
        const doc = await tx.doc(MissionQueue, this.root.id);
        doc.attention = { reason: `action_denied: ${denialReason ?? "refus owner"}`, at: Date.now() };
      }, context);
    }
    this.control.emit(await this.missionStatus());
    return result;
  }

  /** Révocation : bloque les FUTURES dispatches (n'annule pas un effet accepté). */
  async revokeGrant(grantId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await this.root.commit(
      (tx) => tx.doc(MissionApprovals, this.root.id).then((doc) => revokeGrant(doc, grantId)),
      context,
    );
    this.control.emit(await this.missionStatus());
    return result;
  }

  // ---------- Accès existants ----------

  /** Enregistre la disposition terminale d'un worker après observation/arrêt. */
  async resolveWorker(workerId: string, disposition: Exclude<WorkerRecord["disposition"], undefined>): Promise<void> {
    await this.root.commit(async (tx) => {
      const doc = await tx.doc(WorkerRecords, this.root.id);
      const record = doc.workers.find((w) => w.id === workerId);
      if (!record) throw new Error(`worker inconnu: ${workerId}`);
      record.disposition = disposition;
    }, context);
    await this.reconcileWorkers();
    // Tout orphelin classé : la runtime redevient prête.
    if (!this.recovery.needsAttention) this.harness.resume();
    this.control.emit(await this.missionStatus());
  }

  /** Transcript brut (vérité Durable — jamais recopié dans le catalogue, ADR-006 amendé). */
  async transcript(): Promise<readonly EntryRecord[]> {
    return (await this.root.context(context)).entries;
  }

  /** Abonnement aux événements commités (fan-out SSE). */
  async onCommitted(listener: (events: readonly AgentEvent[]) => void): Promise<() => void> {
    const stream = await watchEvents(this.harness, this.root.id, context);
    await stream.start(async (batch) => listener(batch));
    return () => {
      void stream.stop();
    };
  }

  async waitForIdle(): Promise<void> {
    await this.root.waitForIdle(context);
  }

  /** Arrêt : retire les entrées en file et marque les tâches vivantes. */
  async abort(): Promise<void> {
    await this.root.abort(context);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.harness.close(context);
    } finally {
      this.lease.release();
    }
  }
}

/** Grant enrichi d'un indicateur de validité à l'instant de la lecture. */
export interface ApprovalGrantView {
  operation: string;
  target: string;
  artifactDigest: string;
  argumentDigest: string;
  id: string;
  pendingActionId: string;
  expiresAt: number;
  remainingUses: number;
  revoked: boolean;
  decidedAt: number;
  valid: boolean;
}
