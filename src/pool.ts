import { AsyncLocalStorage } from "node:async_hooks";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { requestAuthorization, checkRequestAuthorization } from "./request-authorization.js";

/**
 * PiProcessPool — un process `pi --mode rpc` par conversation active (I3 : unique point de spawn).
 * Spawn paresseux, recyclage idle, plafond avec éviction du plus vieux non-streaming.
 */

export interface PiClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: unknown) => void): () => void;
  getState(): Promise<{ sessionFile?: string; isStreaming?: boolean; isCompacting?: boolean; model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }>;
  getAvailableModels(): Promise<Array<{ provider: string; id: string }>>;
  getAvailableThinkingLevels(): Promise<ThinkingLevel[]>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  prompt(message: string, images?: unknown[], streamingBehavior?: "steer" | "followUp"): Promise<unknown>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<unknown>;
}

export interface PiClientFactoryOptions {
  cwd: string;
  args: string[];
  /** Variables d'environnement passées au process pi (transport du MCP du preset) */
  env?: Record<string, string>;
}

export type PiClientFactory = (opts: PiClientFactoryOptions) => PiClientLike;

export type PoolStatus = "spawning" | "active" | "idle" | "dead";

export class PoolError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

interface Handle {
  convId: string;
  client: PiClientLike;
  lastActivityAt: number;
  dead: boolean;
  active: boolean;
  queue: Array<{ text: string; run: () => Promise<unknown> }>;
  pending?: () => Promise<void>;
  cancelPending?: () => void;
}

export interface PoolCallbacks {
  onEvent?: (convId: string, event: unknown) => void;
  onStatus?: (convId: string, status: PoolStatus) => void;
}

/** Bornes par défaut du pool (surchargeables par PoolOptions). */
const DEFAULT_MAX_PROCESSES = 8;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 15 * 60_000;

export interface PoolOptions {
  factory: PiClientFactory;
  callbacks?: PoolCallbacks;
  /** Plafond de process simultanés (défaut 8) */
  max?: number;
  /** Délai de recyclage idle en ms (défaut 10 min) */
  idleMs?: number;
}

export class PiPool {
  private handles = new Map<string, Handle>();
  private eventListeners = new Set<(convId: string, event: unknown) => void>();

  private locks = new Map<string, Promise<unknown>>();
  private lockContext = new AsyncLocalStorage<{ id: string; active: boolean }>();

  constructor(private opts: PoolOptions) {}

  async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const context = this.lockContext.getStore();
    if (context?.id === id && context.active) return action();
    const previous = this.locks.get(id) ?? Promise.resolve();
    const token = { id, active: true };
    const next = previous.catch(() => undefined).then(() => this.lockContext.run(token, action));
    this.locks.set(id, next);
    try { return await next; }
    finally { token.active = false; if (this.locks.get(id) === next) this.locks.delete(id); }
  }

  emit(id: string, event: unknown): void {
    this.opts.callbacks?.onEvent?.(id, event);
    for (const listener of this.eventListeners) listener(id, event);
  }

  client(id: string): PiClientLike { return this.live(id).client; }

  async configure(id: string, apply: () => Promise<void>, cancel?: () => void): Promise<boolean> {
    return this.serial(id, async () => {
      const h = this.live(id);
      if (h.pending) throw new PoolError("configuration outstanding", "conflict");
      const authorize = requestAuthorization.getStore();
      const work = () => requestAuthorization.run(authorize ?? (() => {}), apply);
      if (h.active || await this.streaming(h)) { h.pending = work; h.cancelPending = cancel; return false; }
      await work();
      return true;
    });
  }

  private async drain(h: Handle): Promise<void> {
    if (h.dead || h.active) return;
    const pending = h.pending;
    h.pending = undefined;
    h.cancelPending = undefined;
    if (pending) {
      try { await pending(); }
      catch (error) { this.emit(h.convId, { type: "configuration_error", error: String(error) }); }
    }
    while (!h.dead && !h.active && h.queue.length) {
      const next = h.queue.shift()!;
      this.queueChanged(h);
      try { await next.run(); }
      catch (error) { this.emit(h.convId, { type: "queue_error", error: String(error) }); }
    }
  }

  private queueChanged(h: Handle): void {
    this.emit(h.convId, { type: "queue_update", steering: [], followUp: h.queue.map(item => item.text) });
  }

  private clearQueue(h: Handle): void {
    const count = h.queue.length;
    const messages = h.queue.map(item => item.text);
    h.queue = [];
    if (count) this.queueChanged(h);
    if (count) this.emit(h.convId, { type: "queue_cleared", count, messages, reason: "stopped" });
  }

  /** Abonnement aux événements pi de toutes les conversations (fan-out SSE côté serveur). */
  onEvent(cb: (convId: string, event: unknown) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  get size(): number {
    return this.handles.size;
  }

  isLive(convId: string): boolean {
    const h = this.handles.get(convId);
    return Boolean(h && !h.dead);
  }

  async isStreaming(convId: string): Promise<boolean> {
    const handle = this.handles.get(convId);
    return handle && !handle.dead ? this.streaming(handle) : false;
  }

  private async streaming(h: Handle): Promise<boolean> {
    try {
      const state = await h.client.getState();
      return h.active || state.isStreaming === true || state.isCompacting === true;
    } catch {
      return true; // Unknown runtime state must never be evicted as idle.
    }
  }

  private status(convId: string, status: PoolStatus): void {
    this.opts.callbacks?.onStatus?.(convId, status);
  }

  /**
   * Assure qu'un process pi existe pour la conversation (spawn paresseux idempotent).
   * Réutilise un process vivant ; reprend la session `.jsonl` si connue.
   */
  async ensure(
    convId: string,
    spawn: PiClientFactoryOptions & { resumeSessionFile?: string | null; initialize?: (client: PiClientLike) => Promise<void> },
  ): Promise<{ sessionFile?: string }> {
    return this.serial(convId, async () => {
      const existing = this.handles.get(convId);
      if (existing && !existing.dead) {
        existing.lastActivityAt = Date.now();
        return {};
      }
      const handle = await this.serial("pool:admission", async () => {
        checkRequestAuthorization();
        await this.makeRoom();
        checkRequestAuthorization();
        const args = spawn.resumeSessionFile ? [...spawn.args, "--session", spawn.resumeSessionFile] : spawn.args;
        const client = this.opts.factory({ cwd: spawn.cwd, args, env: spawn.env });
        const handle: Handle = { convId, client, lastActivityAt: Date.now(), dead: false, active: false, queue: [] };
        this.handles.set(convId, handle);
        return handle;
      });
      const { client } = handle;
      this.status(convId, "spawning");
      try {
        await client.start();
        const state = await client.getState();
        client.onEvent((event) => {
          if (handle.dead) return;
          handle.lastActivityAt = Date.now();
          const type = (event as { type?: string })?.type;
          if (type === "agent_start") handle.active = true;
          if (type === "agent_settled") {
            handle.active = false;
            this.lockContext.exit(() => { void this.serial(convId, () => this.drain(handle)); });
          }
          this.emit(convId, event);
        });
        await spawn.initialize?.(client);
        this.status(convId, "active");
        return { sessionFile: state.sessionFile };
      } catch (err) {
        await client.stop().catch(() => undefined);
        handle.dead = true;
        this.handles.delete(convId);
        this.status(convId, "dead");
        throw err instanceof Error ? err : new Error(String(err));
      }
    });
  }

  /** Libère une place sous le plafond en évincant le plus vieux process non-streaming. */
  private async makeRoom(): Promise<void> {
    const max = this.opts.max ?? DEFAULT_MAX_PROCESSES;
    if (this.handles.size < max) return;
    const oldestFirst = [...this.handles.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    for (const h of oldestFirst) {
      if (this.locks.has(h.convId) || h.pending || await this.streaming(h)) continue; // jamais de kill d'un travail en cours
      checkRequestAuthorization();
      if (await this.evictIdle(h)) return;
    }
    throw new PoolError("pool plein : toutes les sessions sont actives", "pool_full");
  }

  private evictIdle(h: Handle): Promise<boolean> {
    return this.serial(h.convId, async () => {
      if (this.handles.get(h.convId) !== h || h.pending || await this.streaming(h)) return false;
      return this.evict(h.convId);
    });
  }

  private live(convId: string): Handle {
    const h = this.handles.get(convId);
    if (!h || h.dead) throw new PoolError("session non démarrée (pool)", "not_running");
    h.lastActivityAt = Date.now();
    return h;
  }

  async prompt(convId: string, text: string, images?: unknown[]): Promise<unknown> {
    const authorize = requestAuthorization.getStore();
    return this.serial(convId, async () => {
      const h = this.live(convId);
      const dispatch = async () => {
        authorize?.();
        h.active = true;
        try {
          const result = await h.client.prompt(text, images, "followUp");
          if ((result as { disposition?: string })?.disposition === "handled") h.active = (await h.client.getState()).isStreaming === true;
          return result;
        } catch (error) { await this.evict(convId); throw error; }
      };
      if (h.active || h.pending || await this.streaming(h)) {
        h.queue.push({ text, run: dispatch });
        this.queueChanged(h);
        return { disposition: "queued" };
      }
      return dispatch();
    });
  }

  async abort(convId: string): Promise<void> {
    return this.serial(convId, async () => {
      try {
        const h = this.live(convId);
        this.clearQueue(h);
        await h.client.abort();
      } catch {
        /* process déjà mort : abort est best-effort */
      }
    });
  }

  async evict(convId: string): Promise<boolean> {
    return this.serial(convId, async () => {
      const h = this.handles.get(convId);
      if (!h) return false;
      h.dead = true;
      h.cancelPending?.();
      h.pending = undefined;
      this.clearQueue(h);
      this.handles.delete(convId);
      try {
        await h.client.stop();
      } catch {
        /* stop best-effort */
      }
      this.status(convId, "idle");
      return true;
    });
  }

  /** Recyclage idle : les process sans activité depuis idleMs et non-streaming sont stoppés. */
  async sweep(now = Date.now()): Promise<void> {
    const idleMs = this.opts.idleMs ?? DEFAULT_IDLE_MS;
    for (const h of [...this.handles.values()]) {
      if (now - h.lastActivityAt < idleMs) continue;
      if (this.locks.has(h.convId) || h.pending || await this.streaming(h)) {
        h.lastActivityAt = now; // toujours en travail : on reporte
        continue;
      }
      await this.evictIdle(h);
    }
  }

  /** Attend l'événement `agent_settled` d'une conversation (suivi des runs cron). Rejette en timeout. */
  waitForSettled(convId: string, timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new PoolError(`timeout d'attente de fin d'agent (${timeoutMs}ms)`, "settle_timeout"));
      }, timeoutMs);
      const unsub = this.onEvent((id, event) => {
        if (id !== convId) return;
        const type = (event as { type?: string } | null)?.type;
        if (type === "agent_settled") {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
  }

  /** Test-only : backdate la dernière activité d'une conversation. */
  backdate(convId: string, at: number): void {
    const h = this.handles.get(convId);
    if (h) h.lastActivityAt = at;
  }

  async dispose(): Promise<void> {
    for (const id of [...this.handles.keys()]) await this.evict(id);
  }
}
