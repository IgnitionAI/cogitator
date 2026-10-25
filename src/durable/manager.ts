/**
 * Gestionnaire des runtimes durables (point de composition `src/runtime.ts`) :
 * une runtime ouverte par conversation durable, dans le processus contrôleur,
 * avec bail OS sur son stockage. Le catalogue ne garde que la référence (D4) ;
 * la vérité de mission (transcripts, checkpoints, profil gelé, approbations,
 * file d'admission, budget) vit dans le stockage Durable propre à la
 * conversation, sous `<home>/durable/<convId>/`.
 *
 * Le gestionnaire détient aussi le plan de contrôle d'admission PARTAGÉ
 * (ticket #16) : deux slots d'exécution (D7) et les claims workspace exclusifs
 * — une mission n'est dispatchée que si elle obtient les deux, sinon sa file
 * reste visible. Les états de mission sont re-projetés sur un EventEmitter que
 * le serveur branche sur le SSE de la conversation.
 */

import { EventEmitter } from "node:events";
import type { Models } from "@earendil-works/pi-ai";
import { piAiProviders } from "../host-pi.js";
import { createRegistry, type Extension, type Registry } from "@earendil-works/pi-durable";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationRow } from "../conversations.js";
import type { Paths } from "../paths.js";
import type { ToolchainRegistry } from "../execution/egress.js";
import { DurableMissionRuntime, type MissionStatusView } from "./mission-runtime.js";
import { MissionSlotPool, WorkspaceClaims } from "./admission.js";
import { digest } from "./profile.js";

export interface DurableManagerOptions {
  paths: Paths;
  /** Toolchain classée approuvée, gelée dans chaque profil de mission à la création. */
  toolchain: ToolchainRegistry;
  /** Accès modèles (défaut production : fournisseurs built-in, clés détenues par le contrôleur). */
  modelsFactory?: () => Models;
  /** Registre d'extensions (défaut : aucune — fail closed, voir docs/durable-compatibility.md). */
  registryFactory?: () => Registry;
  /** Extensions sélectionnables par les missions durables (défaut : aucune). */
  agentExtensions?: readonly Extension[];
  /** Nombre de missions exécutées en concurrence (D7 ; défaut : 2). */
  missionSlots?: number;
  /** Horloge injectable (tests des budgets UTC). */
  now?: () => number;
}

interface ManagedRuntime {
  runtime: DurableMissionRuntime;
  closed: boolean;
}

export class DurableRuntimeManager {
  private readonly open = new Map<string, ManagedRuntime>();
  private readonly slots: MissionSlotPool;
  private readonly claims = new WorkspaceClaims();
  private readonly emitter = new EventEmitter();
  private readonly now: () => number;
  /** Rappel UTC : à minuit, les gates quotidiens se délient et la file re-filtre. */
  private readonly utcTimer: NodeJS.Timeout;

  constructor(private readonly opts: DurableManagerOptions) {
    this.slots = new MissionSlotPool(opts.missionSlots ?? 2);
    this.now = opts.now ?? Date.now;
    this.utcTimer = setInterval(() => void this.requeueAll(), 60_000);
    this.utcTimer.unref();
  }

  private dirFor(convId: string): string {
    return join(this.opts.paths.home, "durable", convId);
  }

  /** Ouvre (ou réouvre après fermeture) la runtime durable d'une conversation. */
  async get(conv: ConversationRow): Promise<DurableMissionRuntime> {
    const managed = this.open.get(conv.id);
    if (managed && !managed.closed) return managed.runtime;
    const spawn = JSON.parse(conv.spawn_args || "{}") as { provider?: string; model?: string };
    const workspaceDir = conv.workspace_dir ?? homedir();
    const slots = this.slots;
    const claims = this.claims;
    const emit = (state: MissionStatusView): void => {
      this.emitter.emit(conv.id, state);
    };
    const requeue = (): void => void this.requeueAll();
    const openRuntimes = this.open;
    const control = {
      workspaceDir,
      tryAdmit(): { admitted: true } | { admitted: false; reason: string } {
        const claim = claims.acquire(workspaceDir, conv.id);
        if (!claim.claimed) return { admitted: false, reason: `workspace_claimed_par:${claim.heldBy}` };
        const slot = slots.tryAcquire(conv.id);
        if (!slot.admitted) {
          claims.release(workspaceDir, conv.id);
          return { admitted: false, reason: slot.reason ?? "slots_missions_pleins" };
        }
        return { admitted: true };
      },
      release(): void {
        claims.release(workspaceDir, conv.id);
        const promoted = slots.release(conv.id);
        // La mission promue dispatche SA file immédiatement ; les autres en
        // file re-tentent ensuite leur admission (un slot vient de se libérer).
        if (promoted) {
          const managed = openRuntimes.get(promoted);
          if (managed && !managed.closed) void managed.runtime.tryDrainQueue();
        }
        requeue();
      },
      claimHolder(): string | undefined {
        return claims.holder(workspaceDir);
      },
      emit,
    };
    const runtime = await DurableMissionRuntime.open({
      dir: this.dirFor(conv.id),
      cwd: workspaceDir,
      model: { provider: spawn.provider ?? conv.provider, modelId: spawn.model ?? conv.model },
      presetDigest: digest(conv.spawn_args || "{}"),
      models: (this.opts.modelsFactory ?? (() => piAiProviders.builtinModels()))(),
      registry: (this.opts.registryFactory ?? (() => createRegistry()))(),
      agentExtensions: this.opts.agentExtensions ?? [],
      toolchain: {
        commands: [...this.opts.toolchain.approvedCommands],
        mcpServers: [...this.opts.toolchain.approvedMcpServers],
      },
      control,
    });
    const entry: ManagedRuntime = { runtime, closed: false };
    this.open.set(conv.id, entry);
    return runtime;
  }

  /** Projection de statut de mission (ouvre la runtime durable si besoin). */
  async missionStatus(conv: ConversationRow): Promise<MissionStatusView> {
    const runtime = await this.get(conv);
    return runtime.missionStatus(this.now());
  }

  /** Abonnement aux changements d'état d'une mission (fan-out SSE serveur). */
  onMissionState(convId: string, listener: (state: MissionStatusView) => void): () => void {
    this.emitter.on(convId, listener);
    return () => this.emitter.off(convId, listener);
  }

  /** Détail d'admission pour les tests et l'observabilité. */
  admissionSnapshot(): { running: readonly string[]; queued: readonly string[]; claims: Record<string, string> } {
    return {
      running: this.slots.running,
      queued: this.slots.queued,
      claims: this.claims.entries(),
    };
  }

  /**
   * Fait re-tenter l'admission à toutes les missions ayant une file (file
   * d'inputs, pas seulement la file de slots : une mission peut être retenue
   * par le claim workspace sans jamais avoir rejoint la file de slots).
   */
  private async requeueAll(): Promise<void> {
    // Les runtimes déjà fermées lâchent d'abord leur place éventuelle.
    for (const missionId of this.slots.queued) {
      const managed = this.open.get(missionId);
      if (!managed || managed.closed) this.slots.release(missionId);
    }
    for (const managed of this.open.values()) {
      if (!managed.closed) await managed.runtime.tryDrainQueue();
    }
  }

  /** Runtime déjà ouverte dans ce processus (sans ouvrir) — lecture SSE sans créer de mission. */
  getIfOpen(convId: string): DurableMissionRuntime | undefined {
    const managed = this.open.get(convId);
    return managed && !managed.closed ? managed.runtime : undefined;
  }

  /** Ferme la runtime d'une conversation (le stockage Durable, lui, survit). */
  async release(convId: string): Promise<void> {
    const managed = this.open.get(convId);
    this.open.delete(convId);
    if (managed && !managed.closed) {
      managed.closed = true;
      await managed.runtime.close();
    }
    // La fermeture relâche aussi slot et claim détenus (sinon fuite d'admission).
    this.claims.releaseByMission(convId);
    const promoted = this.slots.release(convId);
    if (promoted) {
      const next = this.open.get(promoted);
      if (next && !next.closed) void next.runtime.tryDrainQueue();
    }
    void this.requeueAll();
  }

  async dispose(): Promise<void> {
    clearInterval(this.utcTimer);
    for (const convId of [...this.open.keys()]) await this.release(convId);
  }
}
