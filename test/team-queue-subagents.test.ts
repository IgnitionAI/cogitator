/** #51 : ne pas clore un item/run tant que des sous-agents tournent ; abort réel au stall. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agents.js";
import { CronService, createTask } from "../src/cron.js";
import { openDb } from "../src/db.js";
import { PiPool } from "../src/pool.js";
import type { Spawner } from "../src/spawner.js";
import { enqueue, LaneDispatcher, listItems } from "../src/team-queue.js";
import { createWorkspace } from "../src/workspaces.js";

type Client = {
  streaming: boolean;
  aborted: number;
  emit: (event: unknown) => void;
  prompt: (text: string) => Promise<{ disposition: string }>;
  abort: () => Promise<void>;
};

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

function controlledPool(opts?: { hangPromptUntilAbort?: boolean }) {
  const clients = new Map<string, Client>();
  const prompts: Array<[string, string]> = [];
  const pool = new PiPool({
    factory: ({ args }) => {
      const convId = args[0]!;
      const listeners = new Set<(e: unknown) => void>();
      let releasePrompt: ((value: { disposition: string }) => void) | undefined;
      const client: Client & Record<string, unknown> = {
        streaming: false,
        aborted: 0,
        async start() {},
        async stop() {},
        async abort() {
          client.aborted += 1;
          client.streaming = false;
          releasePrompt?.({ disposition: "started" });
          releasePrompt = undefined;
        },
        onEvent(l: (e: unknown) => void) {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        async getState() {
          return { isStreaming: client.streaming };
        },
        async getAvailableModels() {
          return [];
        },
        async getAvailableThinkingLevels() {
          return [];
        },
        async setThinkingLevel() {},
        async setModel() {
          return {};
        },
        emit(event: unknown) {
          for (const l of listeners) l(event);
        },
        async prompt(text: string) {
          prompts.push([convId, text]);
          if (opts?.hangPromptUntilAbort && prompts.length === 1) {
            return new Promise((resolve) => {
              releasePrompt = resolve;
            });
          }
          return { disposition: "started" };
        },
      };
      clients.set(convId, client);
      return client as never;
    },
  });
  return { pool, clients, prompts };
}

function freshQueue() {
  const dir = mkdtempSync(join(tmpdir(), "cog-q51-"));
  const { db } = openDb(join(dir, "c.db"));
  db.prepare("INSERT INTO conversation (id, provider, model) VALUES ('a', 'fake', 'fake')").run();
  return { db, dir };
}

function freshCron() {
  const dir = mkdtempSync(join(tmpdir(), "cog-q51-cron-"));
  process.env.COGITATOR_HOME = dir;
  const { db } = openDb(join(dir, "c.db"));
  const agent = createAgent(db, {
    name: "Cron 51",
    provider: "openai",
    model: "gpt-5.4",
    system_prompt: "",
    skills: [],
    mcp_servers: [],
  });
  const ws = createWorkspace(db, { dir }).workspace!;
  return { dir, db, agent, ws };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(cond(), "condition non atteinte");
}

test("item de file reste delivering tant qu'un sous-agent async tourne après agent_settled", async () => {
  const { db, dir } = freshQueue();
  const { pool, clients } = controlledPool();
  const d = new LaneDispatcher({ db, pool, ensure: (id) => pool.ensure(id, { cwd: dir, args: [id] }) });
  const { id, laneId } = enqueue(db, { conversationId: "a", body: "délègue" });
  const kicked = d.kick(laneId);
  await d.waitUntilPrompted(id);
  const client = clients.get("a")!;
  client.emit(detachedEnd());
  client.emit({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(listItems(db, laneId)[0]!.status, "delivering", "ne pas clore pendant qu'un enfant async tourne");
  assert.equal(pool.isLive("a"), true);
  client.emit({ type: "subagent:async-complete" });
  await kicked;
  assert.equal(listItems(db, laneId)[0]!.status, "done");
  await pool.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("délai dépassé : abort avant failed, slot libéré, pas de livraison tardive", { timeout: 10_000 }, async () => {
  const { db, dir } = freshQueue();
  const { pool, clients, prompts } = controlledPool({ hangPromptUntilAbort: true });
  const d = new LaneDispatcher({
    db,
    pool,
    ensure: (id) => pool.ensure(id, { cwd: dir, args: [id] }),
    settleTimeoutMs: 50,
  });
  const first = enqueue(db, { conversationId: "a", body: "bloqué" });
  const second = enqueue(db, { conversationId: "a", body: "suivant" });
  const kicked = d.kick(first.laneId);
  try {
    await waitFor(() => (clients.get("a")?.aborted ?? 0) > 0);
    const client = clients.get("a")!;
    assert.ok(client.aborted >= 1, "l'agent doit être aborté au stall");
    client.emit({ type: "agent_settled" });
    await waitFor(() => listItems(db, first.laneId)[0]!.status === "failed");
    const stalled = listItems(db, first.laneId)[0]!;
    assert.equal(stalled.status, "failed");
    assert.match(stalled.error ?? "", /stall|sans progrès|progress/i);
    client.emit({ type: "agent_settled" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(listItems(db, first.laneId)[0]!.status, "failed", "un settle tardif ne rouvre pas l'item");
    assert.equal(prompts.filter(([, text]) => text === "bloqué").length, 1, "pas de relivraison du tour aborté");
    client.emit({ type: "agent_settled" });
    await kicked;
    const items = listItems(db, first.laneId);
    assert.equal(items[0]!.status, "failed");
    assert.equal(items[1]!.id, second.id);
    assert.equal(items[1]!.status, "done");
    assert.ok(client.aborted >= 1);
  } finally {
    for (const c of clients.values()) await c.abort();
    await kicked.catch(() => undefined);
    await pool.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run cron n'est pas clos / évincé tant qu'un sous-agent async tourne", async () => {
  const { dir, db, agent, ws } = freshCron();
  const { pool, clients, prompts } = controlledPool();
  const ensure = (id: string) => pool.ensure(id, { cwd: dir, args: [id] });
  const d = new LaneDispatcher({ db, pool, ensure });
  const spawner: Spawner = { tmpDir: dir, ensure: (conv) => ensure(conv.id) };
  const cron = new CronService({ db, pool, spawner, team: d });
  const task = createTask(db, {
    name: "avec-enfant",
    cron_expr: "0 0 * * *",
    prompt: "délègue-cron",
    agent_id: agent.id,
    workspace_id: ws.id,
  }).task!;

  const fire = cron.fireNow(task.id);
  await waitFor(() => prompts.length > 0);
  const convId = [...clients.keys()][0]!;
  const client = clients.get(convId)!;
  client.emit(detachedEnd());
  client.emit({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(pool.isLive(convId), true, "éviction trop tôt tuerait l'enfant");
  const runWhile = db.prepare("SELECT status FROM cron_run WHERE task_id = ?").get(task.id) as { status: string };
  assert.equal(runWhile.status, "running");
  const itemWhile = db.prepare("SELECT status FROM queue_item").get() as { status: string };
  assert.equal(itemWhile.status, "delivering");
  client.emit({ type: "subagent:async-complete" });
  const run = await fire;
  assert.equal(run!.status, "ok");
  assert.equal(pool.isLive(convId), false, "slot libéré après la fin réelle");
  await pool.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
