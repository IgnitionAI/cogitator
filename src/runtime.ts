/**
 * Point de composition explicite des runtimes de conversation (Plan 0002 §6,
 * I3 amendé) : UNE seule fabrique décide, selon `runtime_kind` figé à la
 * création, d'acheminer vers le runtime classic (processus pi gérés par le
 * pool) ou le runtime durable (harnais Durable du contrôleur, bail OS).
 * Aucune autre partie du produit ne compose de runtime et aucune feature ne
 * crée de processus ou de harnais non gérés.
 */

import type { SubmissionId } from "@earendil-works/pi-durable";
import type { ConversationRow } from "./conversations.js";
import { DurableRuntimeManager } from "./durable/manager.js";
import { PiPool } from "./pool.js";
import type { Spawner } from "./spawner.js";

export type RuntimeKind = "classic" | "durable";

/** runtime_kind figé à la création ; toute valeur historique/absente reste classic. */
export function runtimeKindOf(conv: ConversationRow): RuntimeKind {
  return conv.runtime_kind === "durable" ? "durable" : "classic";
}

export interface AcceptedSubmission {
  requestId: string;
  /** Présent si l'input a été dispatché au SDK (absent s'il est retenu en file). */
  submissionId?: SubmissionId;
  /** true quand ce requestId était déjà accepté : aucun travail dupliqué. */
  duplicate: boolean;
  /** true quand l'envoi est accepté durablement mais retenu en file visible (queued/budget_paused). */
  queued?: boolean;
}

export interface PromptAck {
  /** Présent en mode durable : accusé renvoyé après acceptation durable. */
  accepted?: AcceptedSubmission;
}

export interface ConversationRuntime {
  readonly kind: RuntimeKind;
  /** Garantit le mécanisme d'exécution actif (classic : processus pi du pool). */
  ensure(conv: ConversationRow): Promise<{ sessionFile?: string }>;
  /** Soumet un texte ; en mode durable exige un requestId et accuse après acceptation. */
  prompt(conv: ConversationRow, text: string, requestId?: string, images?: unknown[]): Promise<PromptAck>;
  abort(conv: ConversationRow): Promise<void>;
  /** Libère le mécanisme d'exécution (le stockage/historique survit). */
  evict(conv: ConversationRow): Promise<void>;
  isLive(conv: ConversationRow): boolean;
  /** Branche les événements commités (durable) ; unsubscribe retourné. */
  attachEvents(conv: ConversationRow, send: (event: unknown) => void): Promise<() => void>;
}

export interface RuntimeCompositionDeps {
  pool: PiPool;
  spawner: Spawner;
  durable: DurableRuntimeManager;
}

class ClassicRuntime implements ConversationRuntime {
  readonly kind = "classic" as const;
  constructor(private deps: RuntimeCompositionDeps) {}

  async ensure(conv: ConversationRow): Promise<{ sessionFile?: string }> {
    return this.deps.spawner.ensure(conv);
  }

  async prompt(conv: ConversationRow, text: string, _requestId?: string, images?: unknown[]): Promise<PromptAck> {
    await this.deps.pool.prompt(conv.id, text, images);
    return {};
  }

  async abort(conv: ConversationRow): Promise<void> {
    await this.deps.pool.abort(conv.id);
  }

  async evict(conv: ConversationRow): Promise<void> {
    await this.deps.pool.evict(conv.id);
  }

  isLive(conv: ConversationRow): boolean {
    return this.deps.pool.isLive(conv.id);
  }

  async attachEvents(): Promise<() => void> {
    // Le fan-out classic se fait déjà au niveau serveur via pool.onEvent.
    return () => {};
  }
}

class DurableConversationRuntime implements ConversationRuntime {
  readonly kind = "durable" as const;
  constructor(private deps: RuntimeCompositionDeps) {}

  async ensure(): Promise<{ sessionFile?: string }> {
    // Aucun processus pi : la runtime durable vit dans le contrôleur (gérée, avec bail).
    return {};
  }

  async prompt(conv: ConversationRow, text: string, requestId?: string): Promise<PromptAck> {
    if (!requestId) throw new Error("requestId requis pour une conversation durable");
    const runtime = await this.deps.durable.get(conv);
    const accepted = await runtime.submit(text, requestId);
    return { accepted: { requestId, ...accepted } };
  }

  async abort(conv: ConversationRow): Promise<void> {
    const runtime = this.deps.durable.getIfOpen(conv.id);
    if (runtime) await runtime.abort();
  }

  async evict(conv: ConversationRow): Promise<void> {
    await this.deps.durable.release(conv.id);
  }

  isLive(conv: ConversationRow): boolean {
    return this.deps.durable.getIfOpen(conv.id) !== undefined;
  }

  async attachEvents(conv: ConversationRow, send: (event: unknown) => void): Promise<() => void> {
    const runtime = await this.deps.durable.get(conv);
    return runtime.onCommitted((events) => {
      for (const event of events) send(event);
    });
  }
}

/**
 * Fabrique unique de runtimes (I3 amendé) : la sélection se fait une fois par
 * conversation selon son runtime_kind figé, puis la même instance est réutilisée.
 */
export function composeRuntime(deps: RuntimeCompositionDeps): (conv: ConversationRow) => ConversationRuntime {
  const classic = new ClassicRuntime(deps);
  const durable = new DurableConversationRuntime(deps);
  const byConversation = new Map<string, ConversationRuntime>();
  return (conv) => {
    const cached = byConversation.get(conv.id);
    if (cached) return cached;
    const runtime = runtimeKindOf(conv) === "durable" ? durable : classic;
    byConversation.set(conv.id, runtime);
    return runtime;
  };
}
