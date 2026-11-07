/** Cron : le prompt d'un run passe par la file durable (lane/queue_item), pas par pool.waitForSettled. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agents.js";
import { createConversation } from "../src/conversations.js";
import { CronService, createTask, queueCronRun } from "../src/cron.js";
import { openDb } from "../src/db.js";
import { PiPool } from "../src/pool.js";
import { spawnConfigFromPreset } from "../src/spawn.js";
import type { Spawner } from "../src/spawner.js";
import { enqueue, LaneDispatcher, listItems, recoverInterrupted } from "../src/team-queue.js";
import { createWorkspace } from "../src/workspaces.js";

type Client = {
  streaming: boolean;
  emit: (event: unknown) => void;
  prompt: (text: string) => Promise<{ disposition: string }>;
};

function hangingPool() {
  const clients = new Map<string, Client>();
  const prompts: Array<[string, string]> = [];
  const pool = new PiPool({
    factory: ({ args }) => {
      const convId = args[0]!;
      const listeners = new Set<(e: unknown) => void>();
      const client: Client & Record<string, unknown> = {
        streaming: false,
        async start() {},
        async stop() {},
        async abort() {},
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
          return { disposition: "started" };
        },
      };
      clients.set(convId, client);
      return client as never;
    },
  });
  return { pool, clients, prompts };
}

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "cog-cron-q-"));
  process.env.COGITATOR_HOME = dir;
  const { db } = openDb(join(dir, "c.db"));
  const agent = createAgent(db, {
    name: "Cron Q",
    provider: "openai",
    model: "gpt-5.4",
    system_prompt: "",
    skills: [],
    mcp_servers: [],
  });
  const ws = createWorkspace(db, { dir }).workspace!;
  return { dir, db, agent, ws };
}

test("run cron mis en file derrière un tour en cours", async () => {
  const { dir, db, agent, ws } = fresh();
  const { pool, clients, prompts } = hangingPool();
  const d = new LaneDispatcher({ db, pool, ensure: (id) => pool.ensure(id, { cwd: dir, args: [id] }) });
  const conv = createConversation(db, {
    workspaceId: ws.id,
    agentId: agent.id,
    spawn: spawnConfigFromPreset(agent),
  });
  const hang = enqueue(db, { conversationId: conv.id, body: "tour-en-cours" });
  void d.kick(hang.laneId);
  await d.waitUntilPrompted(hang.id);
  assert.deepEqual(prompts.map((p) => p[1]), ["tour-en-cours"]);
  assert.equal(listItems(db, hang.laneId)[0]!.status, "delivering");

  const cronItem = queueCronRun(db, d, {
    conversationId: conv.id,
    prompt: "prompt-cron",
    fromAgentId: agent.id,
    idempotencyKey: "cron:run-1",
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(prompts.map((p) => p[1]), ["tour-en-cours"], "le cron n'est pas livré tant que le tour court");
  const rows = listItems(db, hang.laneId);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.body, "prompt-cron");
  assert.equal(rows[1]!.status, "queued");
  assert.equal(rows[1]!.hop, 1, "même lane : hop hérité du tour en cours");

  clients.get(conv.id)!.emit({ type: "agent_settled" });
  const cronId = rows[1]!.id;
  await d.waitUntilPrompted(cronId);
  clients.get(conv.id)!.emit({ type: "agent_settled" });
  const delivered = await cronItem;
  assert.equal(delivered.status, "done");
  assert.deepEqual(prompts.map((p) => p[1]), ["tour-en-cours", "prompt-cron"]);
  await pool.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("run cron marqué done/failed selon l'item", async () => {
  const { dir, db, agent, ws } = fresh();
  const { pool, clients, prompts } = hangingPool();
  const ensure = (id: string) => pool.ensure(id, { cwd: dir, args: [id] });
  const d = new LaneDispatcher({ db, pool, ensure, settleTimeoutMs: 80 });
  const spawner: Spawner = { tmpDir: dir, ensure: (conv) => ensure(conv.id) };
  const cron = new CronService({ db, pool, spawner, team: d });
  const okTask = createTask(db, {
    name: "ok",
    cron_expr: "0 0 * * *",
    prompt: "go",
    agent_id: agent.id,
    workspace_id: ws.id,
  }).task!;

  const fireOk = cron.fireNow(okTask.id);
  let convId: string | undefined;
  for (let i = 0; i < 50 && prompts.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
    convId = [...clients.keys()][0];
  }
  assert.ok(convId, "le dispatcher a spawn la conversation du run");
  const itemsWhile = db.prepare("SELECT status, body FROM queue_item").all() as Array<{ status: string; body: string }>;
  assert.equal(itemsWhile.length, 1);
  assert.equal(itemsWhile[0]!.body, "go");
  assert.equal(itemsWhile[0]!.status, "delivering");
  clients.get(convId)!.emit({ type: "agent_settled" });
  const okRun = await fireOk;
  assert.equal(okRun!.status, "ok");

  const failTask = createTask(db, {
    name: "fail",
    cron_expr: "0 0 * * *",
    prompt: "bloqué",
    agent_id: agent.id,
    workspace_id: ws.id,
  }).task!;
  const failRun = await cron.fireNow(failTask.id);
  assert.equal(failRun!.status, "timeout");
  assert.match(failRun!.error ?? "", /stall|sans progrès|progress/i);

  await pool.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("item cron delivering au boot devient interrupted", () => {
  const { dir, db, agent, ws } = fresh();
  const conv = createConversation(db, {
    workspaceId: ws.id,
    agentId: agent.id,
    spawn: spawnConfigFromPreset(agent),
  });
  const queued = enqueue(db, {
    conversationId: conv.id,
    body: "prompt-cron",
    fromAgentId: agent.id,
    idempotencyKey: "cron:boot-run",
  });
  db.prepare("UPDATE queue_item SET status = 'delivering' WHERE id = ?").run(queued.id);
  assert.equal(recoverInterrupted(db), 1);
  const [item] = listItems(db, queued.laneId);
  assert.equal(item!.status, "interrupted");
  assert.match(item!.error ?? "", /restart/i);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
