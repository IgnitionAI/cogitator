import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { PiPool } from "./pool.js";

/**
 * Files durables (pi-openbot lot 2, prototype Q1). Module ajouté AU-DESSUS du pool :
 * il n'utilise que l'API publique de PiPool (prompt, waitForSettled) et un `ensure`
 * fourni par l'appelant (Spawner.ensure en production). pool.ts n'est pas modifié.
 *
 * Invariant : un élément `delivering` trouvé au démarrage devient `interrupted`
 * et n'est JAMAIS rejoué (architecture.md §échecs, invariant 2).
 */

export const DEFAULT_HOP_LIMIT = 4;

export type QueueStatus = "queued" | "delivering" | "done" | "failed" | "interrupted" | "cancelled";

export type QueueErrorCode = "hop_limit" | "not_found" | "conflict";

export interface QueueItemRow {
  id: string;
  lane_id: string;
  seq: number;
  body: string;
  from_agent_id: string | null;
  chain_id: string | null;
  hop: number;
  status: QueueStatus;
  idempotency_key: string | null;
  error: string | null;
}

export class QueueError extends Error {
  constructor(message: string, readonly code: QueueErrorCode) { super(message); }
}

export function ensureLane(db: Db, conversationId: string, kind = "chat"): string {
  const found = db.prepare("SELECT id FROM lane WHERE conversation_id = ? AND kind = ?").get(conversationId, kind) as { id: string } | undefined;
  if (found) return found.id;
  const id = randomUUID();
  db.prepare("INSERT INTO lane (id, conversation_id, kind) VALUES (?, ?, ?)").run(id, conversationId, kind);
  return id;
}

export interface EnqueueInput {
  conversationId: string;
  kind?: string;
  body: string;
  fromAgentId?: string | null;
  chainId?: string | null;
  hop?: number;
  idempotencyKey?: string | null;
  hopLimit?: number;
}

/** Ajoute un élément en file. Même idempotency_key → même élément, aucun doublon. */
export function enqueue(db: Db, input: EnqueueInput): { id: string; laneId: string; created: boolean } {
  const hop = input.hop ?? 0;
  if (hop > (input.hopLimit ?? DEFAULT_HOP_LIMIT)) throw new QueueError(`hop ${hop} > limite`, "hop_limit");
  return db.transaction(() => {
    const laneId = ensureLane(db, input.conversationId, input.kind);
    if (input.idempotencyKey) {
      const dup = db.prepare("SELECT id, lane_id FROM queue_item WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string; lane_id: string } | undefined;
      if (dup) return { id: dup.id, laneId: dup.lane_id, created: false };
    }
    const { next } = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM queue_item WHERE lane_id = ?").get(laneId) as { next: number };
    const id = randomUUID();
    db.prepare(`INSERT INTO queue_item (id, lane_id, seq, body, from_agent_id, chain_id, hop, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, laneId, next, input.body, input.fromAgentId ?? null, input.chainId ?? null, hop, input.idempotencyKey ?? null);
    return { id, laneId, created: true };
  })();
}

/** À appeler une fois au démarrage de l'hôte, avant tout dispatch (comme recoverConfigurations). */
export function recoverInterrupted(db: Db): number {
  return db.prepare(`UPDATE queue_item SET status = 'interrupted', finished_at = datetime('now'),
    error = 'host restarted during delivery' WHERE status = 'delivering'`).run().changes;
}

export function setLanePaused(db: Db, laneId: string, paused: boolean): void {
  if (!db.prepare("UPDATE lane SET paused = ? WHERE id = ?").run(paused ? 1 : 0, laneId).changes) throw new QueueError("lane inconnue", "not_found");
}

export function cancelItem(db: Db, itemId: string): void {
  if (!db.prepare("UPDATE queue_item SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'queued'").run(itemId).changes)
    throw new QueueError("élément absent ou plus en file", "conflict");
}

export function listItems(db: Db, laneId: string): QueueItemRow[] {
  return db.prepare("SELECT * FROM queue_item WHERE lane_id = ? ORDER BY seq").all(laneId) as QueueItemRow[];
}

export function listQueuedLaneIds(db: Db): string[] {
  return (db.prepare("SELECT DISTINCT lane_id AS id FROM queue_item WHERE status = 'queued'").all() as Array<{ id: string }>).map((row) => row.id);
}

export function laneIsPaused(db: Db, laneId: string): boolean {
  const row = db.prepare("SELECT paused FROM lane WHERE id = ?").get(laneId) as { paused: number } | undefined;
  return Boolean(row?.paused);
}

export function laneIsDelivering(db: Db, laneId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM queue_item WHERE lane_id = ? AND status = 'delivering'").get(laneId));
}

export function kickQueuedLanes(db: Db, dispatcher: LaneDispatcher): void {
  for (const id of listQueuedLaneIds(db)) void dispatcher.kick(id);
}

export interface DispatcherOptions {
  db: Db;
  pool: Pick<PiPool, "prompt" | "waitForSettled">;
  /** Spawn paresseux de la conversation (Spawner.ensure en production). */
  ensure: (conversationId: string) => Promise<unknown>;
  settleTimeoutMs?: number;
}

/** Livre une lane élément par élément, dans l'ordre de seq. Une seule boucle par lane. */
export class LaneDispatcher {
  private running = new Map<string, Promise<void>>();
  private current = new Map<string, QueueItemRow>();
  private images = new Map<string, unknown[]>();
  private prompted = new Set<string>();
  private promptWaiters = new Map<string, Array<() => void>>();

  constructor(private opts: DispatcherOptions) {}

  /** Élément en cours de livraison pour une conversation (contexte hop/chain des outils team_*). */
  currentItem(conversationId: string): QueueItemRow | undefined { return this.current.get(conversationId); }

  attachImages(itemId: string, images: unknown[]): void {
    this.images.set(itemId, images);
  }

  waitUntilPrompted(itemId: string): Promise<void> {
    if (this.prompted.has(itemId)) return Promise.resolve();
    const row = this.opts.db.prepare("SELECT status FROM queue_item WHERE id = ?").get(itemId) as { status: QueueStatus } | undefined;
    if (row && row.status !== "queued" && row.status !== "delivering") {
      this.markPrompted(itemId);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const list = this.promptWaiters.get(itemId) ?? [];
      list.push(resolve);
      this.promptWaiters.set(itemId, list);
    });
  }

  kick(laneId: string): Promise<void> {
    const existing = this.running.get(laneId);
    if (existing) return existing.then(() => this.kick(laneId));
    const loop = this.loop(laneId).finally(() => this.running.delete(laneId));
    this.running.set(laneId, loop);
    return loop;
  }

  private markPrompted(itemId: string): void {
    this.prompted.add(itemId);
    this.images.delete(itemId);
    const waiters = this.promptWaiters.get(itemId);
    if (!waiters) return;
    this.promptWaiters.delete(itemId);
    for (const waiter of waiters) waiter();
  }

  private async loop(laneId: string): Promise<void> {
    const { db, pool } = this.opts;
    for (;;) {
      const lane = db.prepare("SELECT conversation_id, paused FROM lane WHERE id = ?").get(laneId) as { conversation_id: string; paused: number } | undefined;
      if (!lane || lane.paused) return;
      const item = db.prepare("SELECT * FROM queue_item WHERE lane_id = ? AND status = 'queued' ORDER BY seq LIMIT 1").get(laneId) as QueueItemRow | undefined;
      if (!item) return;
      const claimed = db.prepare("UPDATE queue_item SET status = 'delivering', started_at = datetime('now') WHERE id = ? AND status = 'queued'").run(item.id).changes;
      if (!claimed) continue;
      const convId = lane.conversation_id;
      this.current.set(convId, item);
      try {
        await this.opts.ensure(convId);
        const settled = pool.waitForSettled(convId, this.opts.settleTimeoutMs);
        const result = await pool.prompt(convId, item.body, this.images.get(item.id));
        this.markPrompted(item.id);
        await settled;
        // Le pool a mis le message dans sa file mémoire (tour UI en cours) : attendre le tour suivant.
        if ((result as { disposition?: string } | null)?.disposition === "queued") await pool.waitForSettled(convId, this.opts.settleTimeoutMs);
        db.prepare("UPDATE queue_item SET status = 'done', finished_at = datetime('now') WHERE id = ?").run(item.id);
      } catch (error) {
        db.prepare("UPDATE queue_item SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?").run(String(error), item.id);
      } finally {
        this.markPrompted(item.id);
        this.current.delete(convId);
      }
    }
  }
}

/**
 * Persiste un message dans `queue_item` puis lance le dispatcher.
 * Si la lane est libre, attend que `pool.prompt` ait été appelé (contrat HTTP historique).
 * Si une livraison est déjà en cours, retourne dès l'enqueue — plus de file mémoire du pool.
 */
export async function submitToLane(
  db: Db,
  dispatcher: LaneDispatcher,
  input: EnqueueInput,
  images?: unknown[],
): Promise<{ id: string; laneId: string; created: boolean }> {
  const result = enqueue(db, input);
  if (images?.length) dispatcher.attachImages(result.id, images);
  const paused = laneIsPaused(db, result.laneId);
  const busy = laneIsDelivering(db, result.laneId);
  const kicked = dispatcher.kick(result.laneId);
  if (result.created && !paused && !busy) await dispatcher.waitUntilPrompted(result.id);
  else void kicked.catch(() => undefined);
  return result;
}

export function hopContext(dispatcher: LaneDispatcher, fromConversationId: string | undefined): { hop: number; chainId: string | null } {
  const current = fromConversationId ? dispatcher.currentItem(fromConversationId) : undefined;
  if (!current) return { hop: 0, chainId: null };
  return { hop: current.hop + 1, chainId: current.chain_id ?? current.id };
}
