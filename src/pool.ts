/**
 * PiProcessPool — un process `pi --mode rpc` par conversation active (I3 : unique point de spawn).
 * Spawn paresseux, recyclage idle, plafond avec éviction du plus vieux non-streaming.
 */

export interface PiClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: unknown) => void): () => void;
  getState(): Promise<{ sessionFile?: string; isStreaming?: boolean }>;
  prompt(message: string, images?: unknown[]): Promise<unknown>;
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
}

export interface PoolCallbacks {
  onEvent?: (convId: string, event: unknown) => void;
  onStatus?: (convId: string, status: PoolStatus) => void;
}

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

  constructor(private opts: PoolOptions) {}

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

  private async streaming(h: Handle): Promise<boolean> {
    try {
      return (await h.client.getState()).isStreaming === true;
    } catch {
      return false; // process mort → considéré non-streaming, évincable
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
    spawn: PiClientFactoryOptions & { resumeSessionFile?: string | null },
  ): Promise<{ sessionFile?: string }> {
    const existing = this.handles.get(convId);
    if (existing && !existing.dead) {
      existing.lastActivityAt = Date.now();
      return {};
    }

    const max = this.opts.max ?? 8;
    if (this.handles.size >= max) {
      let evicted = false;
      const oldestFirst = [...this.handles.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      for (const h of oldestFirst) {
        if (await this.streaming(h)) continue; // jamais de kill d'un travail en cours
        await this.evict(h.convId);
        evicted = true;
        break;
      }
      if (!evicted) throw new PoolError("pool plein : toutes les sessions sont actives", "pool_full");
    }

    const args = spawn.resumeSessionFile ? [...spawn.args, "--session", spawn.resumeSessionFile] : spawn.args;
    const client = this.opts.factory({ cwd: spawn.cwd, args, env: spawn.env });
    const handle: Handle = { convId, client, lastActivityAt: Date.now(), dead: false };
    this.handles.set(convId, handle);
    this.status(convId, "spawning");
    try {
      await client.start();
      const state = await client.getState();
      client.onEvent((event) => {
        handle.lastActivityAt = Date.now();
        this.opts.callbacks?.onEvent?.(convId, event);
        for (const l of this.eventListeners) l(convId, event);
      });
      this.status(convId, "active");
      return { sessionFile: state.sessionFile };
    } catch (err) {
      handle.dead = true;
      this.handles.delete(convId);
      this.status(convId, "dead");
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private live(convId: string): Handle {
    const h = this.handles.get(convId);
    if (!h || h.dead) throw new PoolError("session non démarrée (pool)", "not_running");
    h.lastActivityAt = Date.now();
    return h;
  }

  async prompt(convId: string, text: string, images?: unknown[]): Promise<unknown> {
    const h = this.live(convId);
    try {
      return await h.client.prompt(text, images);
    } catch (err) {
      h.dead = true;
      this.status(convId, "dead");
      throw err;
    }
  }

  async abort(convId: string): Promise<void> {
    try {
      await this.live(convId).client.abort();
    } catch {
      /* process déjà mort : abort est best-effort */
    }
  }

  async setModel(convId: string, provider: string, modelId: string): Promise<void> {
    const h = this.live(convId);
    await h.client.setModel(provider, modelId);
    h.lastActivityAt = Date.now();
  }

  async evict(convId: string): Promise<boolean> {
    const h = this.handles.get(convId);
    if (!h) return false;
    this.handles.delete(convId);
    try {
      await h.client.stop();
    } catch {
      /* stop best-effort */
    }
    this.status(convId, "idle");
    return true;
  }

  /** Recyclage idle : les process sans activité depuis idleMs et non-streaming sont stoppés. */
  async sweep(now = Date.now()): Promise<void> {
    const idleMs = this.opts.idleMs ?? 10 * 60_000;
    for (const h of [...this.handles.values()]) {
      if (now - h.lastActivityAt < idleMs) continue;
      if (await this.streaming(h)) {
        h.lastActivityAt = now; // toujours en travail : on reporte
        continue;
      }
      await this.evict(h.convId);
    }
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
