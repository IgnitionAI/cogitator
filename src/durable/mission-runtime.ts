/**
 * Runtime de mission durable (Plan 0002 §5, ADR-008 D2/D3/D4) — la SEULE
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
 */

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  Harness,
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

/** requestId borné et stable (caractères sûrs, 1–128). Miroir de schemas.ts. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class NeedsAttentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsAttentionError";
  }
}

/** Toolchain classée approuvée, gelée dans le profil de mission. */
export interface ApprovedToolchain {
  commands: readonly string[];
  mcpServers: readonly string[];
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
}

export interface MissionRecovery {
  /** Classification des workers enregistrés à l'ouverture. */
  workers: WorkerClassification[];
  /** true si un worker non résolu exige une décision (Plan 0002 §5.7). */
  needsAttention: boolean;
  reasons: string[];
}

export class DurableMissionRuntime {
  private constructor(
    private readonly harness: Harness,
    private readonly root: Conversation,
    private readonly lease: RuntimeLease,
    private readonly registry: Registry,
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
      const runtime = new DurableMissionRuntime(harness, root, lease, opts.registry, {
        workers: [],
        needsAttention: false,
        reasons: [],
      });
      await runtime.verifyFrozenProfile(versions);
      await runtime.reconcileWorkers();
      // Planification activée seulement après vérification bail/versions/état ;
      // si un orphelin n'est pas classé, la readiness reste fausse (Plan 0002 §8.2).
      if (!runtime.recovery.needsAttention) harness.resume();
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

  /**
   * Soumet une entrée utilisateur avec un requestId stable et borné. L'accusé
   * n'est renvoyé qu'APRÈS l'acceptation durable (l'identité de soumission est
   * persistée). Un requestId déjà accepté ne duplique JAMAIS le travail : on
   * retourne l'identité acceptée sans re-soumettre (resoumission d'un requestId
   * live ou réglé : même résultat, Plan 0002 §5.6).
   */
  async submit(text: string, requestId: string): Promise<{ submissionId: SubmissionId; duplicate: boolean }> {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error(`requestId invalide (1–128, [A-Za-z0-9._-]): ${requestId}`);
    }
    const unresolved = unresolvedWorkers(this.recovery.workers);
    if (unresolved.length > 0) {
      // Pas de travail de remplacement tant qu'un worker orphelin n'est pas classé.
      throw new NeedsAttentionError(this.recovery.reasons.join("; "));
    }
    const prior = await this.root.commit((tx) => tx.submissionByRequest(this.root.id, requestId), context);
    if (prior) return { submissionId: prior.id, duplicate: true };
    // L'acceptation durable de root.submit est l'accusé : rien n'est ack avant ce point.
    const submission = await this.root.submit({ type: "input", content: text, requestId }, context);
    return { submissionId: submission.id, duplicate: false };
  }

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
    try {
      await this.harness.close(context);
    } finally {
      this.lease.release();
    }
  }
}
