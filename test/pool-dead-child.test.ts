import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { PiPool, PoolError } from "../src/pool.js";

function hang(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

async function until(pred: () => boolean | Promise<boolean>, label: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

class RpcLikeClient {
  process: ChildProcess;
  state = { sessionFile: "/fake/s.jsonl", isStreaming: false };
  /** When set, getState fails while the OS process is still alive (état inconnu). */
  unknownError: Error | null = null;
  stopped = false;
  private listeners = new Set<(e: unknown) => void>();

  constructor() {
    this.process = hang();
  }

  async start() {}
  async stop() {
    this.stopped = true;
    try { this.process.kill("SIGKILL"); } catch { /* déjà mort */ }
  }
  onEvent(l: (e: unknown) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  async getState() {
    if (this.unknownError) throw this.unknownError;
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      throw new Error(`Agent process exited (code=${this.process.exitCode} signal=${this.process.signalCode})`);
    }
    return this.state;
  }
  async getAvailableModels() { return []; }
  async getAvailableThinkingLevels() { return []; }
  async setThinkingLevel() {}
  async prompt() { return { disposition: "started" }; }
  async abort() {}
  async setModel() { return {}; }
}

function poolWith(clients: RpcLikeClient[], max?: number): PiPool {
  return new PiPool({
    max,
    factory: () => {
      const client = new RpcLikeClient();
      clients.push(client);
      return client;
    },
  });
}

test("pool : un enfant tué en SIGKILL libère son slot", async () => {
  const clients: RpcLikeClient[] = [];
  const pool = poolWith(clients, 1);
  try {
    await pool.ensure("a", { cwd: "/tmp", args: [] });
    assert.equal(pool.isLive("a"), true);
    assert.equal(pool.size, 1);
    const child = clients[0]!.process;
    assert.ok(child.pid);
    child.kill("SIGKILL");
    await until(() => !pool.isLive("a") && pool.size === 0, "slot libéré après SIGKILL");
    await pool.ensure("b", { cwd: "/tmp", args: [] });
    assert.equal(pool.isLive("b"), true);
    assert.equal(pool.isLive("a"), false);
  } finally {
    await pool.dispose();
  }
});

test("pool : un message en attente sur un enfant mort reçoit une erreur", async () => {
  const clients: RpcLikeClient[] = [];
  const pool = poolWith(clients);
  const errors: Array<{ type?: string; message?: string; error?: string }> = [];
  pool.onEvent((_id, event) => {
    const typed = event as { type?: string; message?: string; error?: string };
    if (typed.type === "queue_error") errors.push(typed);
  });
  try {
    await pool.ensure("a", { cwd: "/tmp", args: [] });
    clients[0]!.state.isStreaming = true;
    const queued = await pool.prompt("a", "bonjour");
    assert.equal((queued as { disposition?: string }).disposition, "queued");
    clients[0]!.process.kill("SIGKILL");
    await until(() => errors.length > 0, "queue_error pour le message en attente");
    assert.equal(errors[0]!.message, "bonjour");
    assert.ok(errors[0]!.error && errors[0]!.error.length > 0, "l'erreur ne doit pas être vide");
  } finally {
    await pool.dispose();
  }
});

test("pool : un enfant vivant dont l'état est inconnu n'est pas évincé", async () => {
  const clients: RpcLikeClient[] = [];
  const pool = poolWith(clients, 1);
  try {
    await pool.ensure("alive", { cwd: "/tmp", args: [] });
    clients[0]!.unknownError = new Error("rpc timeout");
    await assert.rejects(
      () => pool.ensure("other", { cwd: "/tmp", args: [] }),
      (e: Error) => e instanceof PoolError && e.code === "pool_full",
    );
    assert.equal(pool.isLive("alive"), true);
    assert.equal(clients[0]!.stopped, false);
    assert.equal(clients[0]!.process.exitCode, null);
  } finally {
    await pool.dispose();
  }
});

test("pool : huit morts successives ne laissent pas le pool en pool_full", async () => {
  const clients: RpcLikeClient[] = [];
  const pool = poolWith(clients, 8);
  const ids = Array.from({ length: 8 }, (_, i) => `dead-${i}`);
  try {
    for (const id of ids) await pool.ensure(id, { cwd: "/tmp", args: [] });
    assert.equal(pool.size, 8);
    for (const client of clients) client.process.kill("SIGKILL");
    await until(() => pool.size === 0 && ids.every((id) => !pool.isLive(id)), "huit slots libérés");
    await pool.ensure("ninth", { cwd: "/tmp", args: [] });
    assert.equal(pool.isLive("ninth"), true);
    assert.equal(pool.size, 1);
  } finally {
    await pool.dispose();
  }
});
