/** IGN-230 / #50 : runs cron `running` orphelins au crash, reprise append_session. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agents.js";
import { createConversation } from "../src/conversations.js";
import { CronService, createTask, listRuns, recoverStaleCronRuns } from "../src/cron.js";
import { openDb } from "../src/db.js";
import { PiPool } from "../src/pool.js";
import { spawnConfigFromPreset } from "../src/spawn.js";
import type { Spawner } from "../src/spawner.js";
import { LaneDispatcher } from "../src/team-queue.js";
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
  const dir = mkdtempSync(join(tmpdir(), "cog-cron-stale-"));
  process.env.COGITATOR_HOME = dir;
  const { db } = openDb(join(dir, "c.db"));
  const agent = createAgent(db, {
    name: "Cron Stale",
    provider: "openai",
    model: "gpt-5.4",
    system_prompt: "",
    skills: [],
    mcp_servers: [],
  });
  const ws = createWorkspace(db, { dir }).workspace!;
  return { dir, db, agent, ws };
}

function service(dir: string, db: ReturnType<typeof openDb>["db"], pool: PiPool) {
  const ensure = (id: string) => pool.ensure(id, { cwd: dir, args: [id] });
  const d = new LaneDispatcher({ db, pool, ensure });
  const spawner: Spawner = { tmpDir: dir, ensure: (conv) => ensure(conv.id) };
  return { cron: new CronService({ db, pool, spawner, team: d }), dispatcher: d, ensure };
}

async function waitForPrompt(prompts: Array<[string, string]>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (prompts.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(prompts.length > 0, "le dispatcher n'a pas livré le prompt cron");
}

test("run running orphelin en base est clos au démarrage", () => {
  const { dir, db, agent, ws } = fresh();
  const task = createTask(db, {
    name: "orphelin",
    cron_expr: "0 0 * * *",
    prompt: "p",
    agent_id: agent.id,
    workspace_id: ws.id,
    busy_policy: "skip",
  }).task!;
  db.prepare("INSERT INTO cron_run (id, task_id, status, started_at) VALUES ('orphan-run', ?, 'running', '2000-01-01 00:00:00')").run(task.id);

  const closed = recoverStaleCronRuns(db);
  assert.equal(closed, 1);
  const [row] = listRuns(db, task.id);
  assert.equal(row!.id, "orphan-run");
  assert.equal(row!.status, "interrupted");
  assert.ok(row!.finished_at);
  assert.match(row!.error ?? "", /restart/i);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("après clôture d'un orphelin, le déclenchement suivant s'exécute sous skip", async () => {
  const { dir, db, agent, ws } = fresh();
  const { pool, clients, prompts } = hangingPool();
  const { cron } = service(dir, db, pool);
  const task = createTask(db, {
    name: "skip-reprend",
    cron_expr: "0 0 * * *",
    prompt: "après-crash",
    agent_id: agent.id,
    workspace_id: ws.id,
    busy_policy: "skip",
  }).task!;
  db.prepare("INSERT INTO cron_run (id, task_id, status, started_at) VALUES ('orphan-skip', ?, 'running', '2000-01-01 00:00:00')").run(task.id);
  recoverStaleCronRuns(db);

  const fire = cron.fireNow(task.id);
  await waitForPrompt(prompts);
  const convId = [...clients.keys()][0]!;
  clients.get(convId)!.emit({ type: "agent_settled" });
  const run = await fire;
  assert.equal(run!.status, "ok");
  assert.notEqual(run!.id, "orphan-skip");
  const statuses = listRuns(db, task.id).map((r) => r.status);
  assert.deepEqual(statuses, ["ok", "interrupted"]);

  await pool.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("append_session reprend la session après un crash sans erreur UNIQUE", async () => {
  const { dir, db, agent, ws } = fresh();
  const { pool, clients, prompts } = hangingPool();
  const { cron } = service(dir, db, pool);
  const task = createTask(db, {
    name: "append",
    cron_expr: "0 0 * * *",
    prompt: "reprends",
    agent_id: agent.id,
    workspace_id: ws.id,
    output_policy: "append_session",
    busy_policy: "skip",
  }).task!;
  const sessionFile = join(dir, "cron-session.jsonl");
  db.prepare("INSERT INTO cron_run (id, task_id, started_at, status, session_file) VALUES ('prev-ok', ?, '2000-01-01 00:00:00', 'ok', ?)").run(task.id, sessionFile);
  const leftover = createConversation(db, {
    workspaceId: ws.id,
    agentId: agent.id,
    spawn: spawnConfigFromPreset(agent),
  });
  db.prepare("UPDATE conversation SET session_file = ?, title = ? WHERE id = ?").run(sessionFile, "[cron] append", leftover.id);

  const fire = cron.fireNow(task.id);
  try {
    await waitForPrompt(prompts);
  } catch (err) {
    const failed = await fire;
    assert.equal(failed!.status, "ok", failed!.error ?? String(err));
    throw err;
  }
  assert.equal([...clients.keys()].length, 1, "une seule conversation spawnée (réutilisation, pas d'INSERT)");
  assert.equal([...clients.keys()][0], leftover.id);
  clients.get(leftover.id)!.emit({ type: "agent_settled" });
  const run = await fire;
  assert.equal(run!.status, "ok");
  assert.equal(run!.session_file, sessionFile);
  const leftoverGone = db.prepare("SELECT 1 FROM conversation WHERE id = ?").get(leftover.id);
  assert.equal(leftoverGone, undefined);

  await pool.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("un run réellement en cours dans le serveur vivant n'est pas clos", async () => {
  const { dir, db, agent, ws } = fresh();
  const { pool, clients, prompts } = hangingPool();
  const { cron } = service(dir, db, pool);
  const liveTask = createTask(db, {
    name: "vivant",
    cron_expr: "0 0 * * *",
    prompt: "en-cours",
    agent_id: agent.id,
    workspace_id: ws.id,
    busy_policy: "skip",
  }).task!;
  const orphanTask = createTask(db, {
    name: "orphelin-voisin",
    cron_expr: "0 0 * * *",
    prompt: "mort",
    agent_id: agent.id,
    workspace_id: ws.id,
    busy_policy: "skip",
  }).task!;
  db.prepare("INSERT INTO cron_run (id, task_id, status, started_at) VALUES ('other-orphan', ?, 'running', '2000-01-01 00:00:00')").run(orphanTask.id);

  const fire = cron.fireNow(liveTask.id);
  try {
    await waitForPrompt(prompts);
    const live = listRuns(db, liveTask.id)[0]!;
    assert.equal(live.status, "running");

    cron.recoverStaleRuns();
    assert.equal(listRuns(db, liveTask.id)[0]!.status, "running");
    assert.equal(listRuns(db, orphanTask.id)[0]!.status, "interrupted");

    clients.get([...clients.keys()][0]!)!.emit({ type: "agent_settled" });
    const done = await fire;
    assert.equal(done!.status, "ok");
  } finally {
    const convId = [...clients.keys()][0];
    if (convId) clients.get(convId)?.emit({ type: "agent_settled" });
    await fire.catch(() => undefined);
  }

  await pool.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
