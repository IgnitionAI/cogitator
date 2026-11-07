import assert from "node:assert/strict";
import { test } from "node:test";
import { PiPool, PoolError } from "../src/pool.js";

class FakeClient {
  state = { sessionFile: "/fake/s.jsonl", isStreaming: false };
  stopped = false;
  private listeners = new Set<(e: unknown) => void>();
  async start() {}
  async stop() { this.stopped = true; }
  onEvent(l: (e: unknown) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  async getState() { return this.state; }
  async getAvailableModels() { return []; }
  async getAvailableThinkingLevels() { return []; }
  async setThinkingLevel() {}
  async prompt() { return { disposition: "started" }; }
  async abort() {}
  async setModel() { return {}; }
  emit(event: unknown) { for (const l of this.listeners) l(event); }
}

function detachedEnd(runId = "run-1") {
  return {
    type: "tool_execution_end",
    toolCallId: "call_sub_1",
    toolName: "subagent",
    result: {
      content: [{ type: "text", text: `Async: delegate [${runId}]\n\nDetached. Return control now.` }],
      details: { mode: "single", runId },
    },
  };
}

function widget(state: string, runId = "run-1") {
  return {
    type: "extension_ui_request",
    id: "w1",
    method: "setWidget",
    widgetKey: "subagent-async",
    widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: "pi-subagents.async-status-snapshot", version: 1, runs: [{ id: runId, state }] })}`],
  };
}

/** Laisse finir le drain déclenché par `agent_settled` (verrou serial), sinon sweep/makeRoom sont faussement bloqués. */
function afterDrain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test("pool : idle sweep n'évince pas un parent pi dont un subagent async tourne encore", async () => {
  const clients: FakeClient[] = [];
  const pool = new PiPool({ factory: () => { const c = new FakeClient(); clients.push(c); return c; }, idleMs: 100 });
  await pool.ensure("parent", { cwd: "/tmp", args: [] });
  const client = clients[0]!;
  client.emit(detachedEnd());
  client.emit({ type: "agent_settled" });
  await afterDrain();
  pool.backdate("parent", Date.now() - 5_000);
  await pool.sweep();
  assert.equal(pool.isLive("parent"), true);
  assert.equal(client.stopped, false);
  await pool.dispose();
});

test("pool : makeRoom n'évince pas un parent avec subagent async (plafond → pool_full)", async () => {
  const clients: FakeClient[] = [];
  const pool = new PiPool({ factory: () => { const c = new FakeClient(); clients.push(c); return c; }, max: 1 });
  await pool.ensure("parent", { cwd: "/tmp", args: [] });
  clients[0]!.emit(detachedEnd());
  clients[0]!.emit({ type: "agent_settled" });
  await afterDrain();
  await assert.rejects(
    () => pool.ensure("other", { cwd: "/tmp", args: [] }),
    (e: Error) => e instanceof PoolError && e.code === "pool_full",
  );
  assert.equal(pool.isLive("parent"), true);
  await pool.dispose();
});

test("pool : après fin du subagent async, le sweep idle peut recycler le parent", async () => {
  const clients: FakeClient[] = [];
  const pool = new PiPool({ factory: () => { const c = new FakeClient(); clients.push(c); return c; }, idleMs: 100 });
  await pool.ensure("parent", { cwd: "/tmp", args: [] });
  const client = clients[0]!;
  client.emit(detachedEnd());
  client.emit({ type: "agent_settled" });
  await afterDrain();
  client.emit(widget("complete"));
  await afterDrain();
  pool.backdate("parent", Date.now() - 5_000);
  await pool.sweep();
  assert.equal(pool.isLive("parent"), false);
  assert.equal(client.stopped, true);
  await pool.dispose();
});

test("pool : waitForSettled attend la fin du subagent async, pas le premier agent_settled", async () => {
  const clients: FakeClient[] = [];
  const pool = new PiPool({ factory: () => { const c = new FakeClient(); clients.push(c); return c; } });
  await pool.ensure("parent", { cwd: "/tmp", args: [] });
  const client = clients[0]!;
  const settled = pool.waitForSettled("parent", 2_000);
  let done = false;
  void settled.then(() => { done = true; });
  client.emit(detachedEnd());
  client.emit({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false);
  client.emit(widget("failed"));
  client.emit({ type: "agent_settled" });
  await settled;
  assert.equal(done, true);
  await pool.dispose();
});

test("extension refresh recycles idle sessions but preserves active parents and children", async () => {
  const clients: FakeClient[] = [];
  const pool = new PiPool({ factory: () => { const c = new FakeClient(); clients.push(c); return c; } });
  for (const id of ["idle", "busy", "child"]) await pool.ensure(id, { cwd: "/tmp", args: [] });
  clients[1]!.state.isStreaming = true;
  clients[2]!.emit(detachedEnd());
  assert.equal(await pool.refreshExtensions(), 2);
  assert.equal(clients[0]!.stopped, true);
  assert.equal(clients[1]!.stopped, false);
  assert.equal(clients[2]!.stopped, false);
  await pool.dispose();
});
