import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";

const home = mkdtempSync(join(tmpdir(), "cog-m5-"));
const piDir = join(home, "pi-agent");
const agentsDir = join(piDir, "agents");
const skillsDir = join(home, "skills");
const projDir = join(home, "projet-cron");
mkdirSync(agentsDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
mkdirSync(projDir, { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = agentsDir;
process.env.COGITATOR_SKILLS_DIRS = skillsDir;
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));

const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool } = await import("../src/pool.js");
const { setConversationStatus } = await import("../src/conversations.js");
const { createAgent } = await import("../src/agents.js");
const { createWorkspace } = await import("../src/workspaces.js");
const { CronService, nextAfter, validateCronExpr } = await import("../src/cron.js");
const { makeSpawner } = await import("../src/spawner.js");

let fakeCounter = 0;
class FakeClient {
  opts: { cwd: string; args: string[]; env?: Record<string, string> };
  sessionFile: string;
  prompts: string[] = [];
  private listeners = new Set<(e: unknown) => void>();
  failOnPrompt = false;
  constructor(opts: { cwd: string; args: string[]; env?: Record<string, string> }) {
    this.opts = opts;
    const sessionIndex = opts.args.indexOf("--session");
    this.sessionFile = sessionIndex >= 0 ? opts.args[sessionIndex + 1]! : `/fake/sessions/m5-${fakeCounter++}.jsonl`;
  }
  async start() {}
  async stop() {}
  onEvent(l: (e: unknown) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  async getState() { return { sessionFile: this.sessionFile, isStreaming: false }; }
  async prompt(text: string) {
    if (this.failOnPrompt) throw new Error("boom simulé");
    this.prompts.push(text);
    // émet un cycle complet terminé par agent_settled (attendu par waitForSettled)
    for (const l of this.listeners) l({ type: "agent_start" });
    for (const l of this.listeners) l({ type: "message_update" });
    for (const l of this.listeners) l({ type: "agent_settled" });
    return {};
  }
  async abort() {}
  async setModel() { return {}; }
}

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;
let pool: InstanceType<typeof PiPool>;
let cron: InstanceType<typeof CronService>;
let agentId: string;
let wsId: string;
const clients: FakeClient[] = [];
const notifications: Array<Record<string, unknown>> = [];

before(async () => {
  ({ db } = openDb(join(home, "cogitator.db")));
  agentId = createAgent(db, {
    name: "Cron Agent", provider: "openai", model: "gpt-5.4", system_prompt: "Agent de test cron.", skills: [], mcp_servers: [],
  }).id;
  wsId = createWorkspace(db, { dir: projDir }).workspace!.id;
  pool = new PiPool({
    factory: (o) => {
      const c = new FakeClient(o);
      clients.push(c);
      return c;
    },
    callbacks: { onStatus: (id, s) => setConversationStatus(db, id, s) },
  });
  cron = new CronService({
    db, pool, spawner: makeSpawner({ db, pool, paths: getPaths() }),
    notify: (e) => notifications.push(e),
    runTimeoutMs: 5_000,
  });
  const events = new EventEmitter();
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: 3, paths: getPaths(), pool, cron, events });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  cron.stop();
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

// ---------- Validation & next-run ----------

test("validateCronExpr : 5/6 champs OK, expressions pourries rejetées", () => {
  assert.ok(validateCronExpr("*/5 * * * *"));
  assert.ok(validateCronExpr("0 9 * * 1-5"));
  assert.ok(!validateCronExpr("pas une cron"));
  assert.ok(!validateCronExpr("61 * * * *"));
});

test("nextAfter : occurrence suivante depuis last_run_at", () => {
  const base = new Date("2026-10-06T10:00:00Z");
  const next = nextAfter({
    id: "t", name: "t", cron_expr: "*/15 * * * *", prompt: "p", agent_id: agentId,
    workspace_id: wsId, output_policy: "append_session", busy_policy: "skip",
    catchup: 0, enabled: 1, last_run_at: base.toISOString(), created_at: base.toISOString(),
  });
  assert.equal(next?.toISOString(), "2026-10-06T10:15:00.000Z");
});

// ---------- CRUD schedules ----------

test("POST /api/schedules : validation expr/agent/workspace", async () => {
  const bad = await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x", cron_expr: "nope", prompt: "p", agent_id: agentId, workspace_id: wsId }),
  });
  assert.equal(bad.status, 400);

  const ok = await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Veille horaire", cron_expr: "0 9 * * *", prompt: "Fais la veille", agent_id: agentId, workspace_id: wsId, busy_policy: "skip" }),
  });
  assert.equal(ok.status, 201);
  const { schedule } = await ok.json();
  assert.equal(schedule.name, "Veille horaire");
  assert.equal(schedule.next_run_at !== null, true);
});

// ---------- Fire manuel (checklist item 7) ----------

test("fire manuel : run ok, session dédiée, cwd workspace, prompts reçus, notifications", async () => {
  const { schedules } = await (await fetch(`${base}/api/schedules`)).json();
  const task = schedules.find((s: { name: string }) => s.name === "Veille horaire");

  const accept = await fetch(`${base}/api/schedules/${task.id}/run`, { method: "POST" });
  assert.equal(accept.status, 202);

  // attendre la fin du run (poll /runs)
  let runs: Array<{ status: string; session_file: string | null; error: string | null }> = [];
  for (let i = 0; i < 50; i++) {
    runs = (await (await fetch(`${base}/api/schedules/${task.id}/runs`)).json()).runs;
    if (runs.length && runs[0]!.status !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(runs[0]!.status, "ok");
  assert.ok(runs[0]!.session_file?.endsWith(".jsonl"));
  assert.equal(runs[0]!.error, null);

  // le process pi a reçu le prompt, cwd = workspace
  const client = clients[clients.length - 1]!;
  assert.deepEqual(client.prompts, ["Fais la veille"]);
  assert.equal(client.opts.cwd, realpathSync(projDir));

  // notifications start + finish (O3)
  assert.ok(notifications.some((n) => n.type === "cron_run_started"));
  assert.ok(notifications.some((n) => n.type === "cron_run_finished" && n.status === "ok"));

  // conversation éphémère nettoyée du pool ET de la table (row transitoire, .jsonl conservé)
  assert.equal(pool.size, 0);
  const convs = (await (await fetch(`${base}/api/conversations`)).json()).conversations;
  assert.equal(convs.filter((c: { title: string }) => c.title.startsWith("[cron]")).length, 0);
});

test("run en échec du LLM : run tracé en error (O3)", async () => {
  const { schedules } = await (await fetch(`${base}/api/schedules`)).json();
  void schedules;

  // tâche valide créée, puis l'agent est supprimé → fireNow trace un run en error
  const noAgent = (await (await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sans agent", cron_expr: "0 0 * * *", prompt: "x", agent_id: agentId, workspace_id: wsId }),
  })).json()).schedule;
  db.prepare("DELETE FROM agent_preset WHERE id = ?").run(agentId); // l'agent disparaît
  await cron.fireNow(noAgent.id);

  const runs = (await (await fetch(`${base}/api/schedules/${noAgent.id}/runs`)).json()).runs;
  assert.equal(runs[0]!.status, "error");
  assert.match(runs[0]!.error ?? "", /agent introuvable/);
});

test("busy-guard skip : run concurrent tracé skipped", async () => {
  // recréer un agent pour la suite
  agentId = createAgent(db, {
    name: "Cron Agent 2", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [],
  }).id;
  const task = (await (await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Busy", cron_expr: "0 0 * * *", prompt: "attends", agent_id: agentId, workspace_id: wsId, busy_policy: "skip" }),
  })).json()).schedule;

  // simuler un run encore 'running' en base
  db.prepare("INSERT INTO cron_run (id, task_id, status, started_at) VALUES ('run-stale', ?, 'running', '2000-01-01 00:00:00')").run(task.id);
  const run = await cron.fireNow(task.id);
  assert.equal(run!.status, "skipped");
  assert.match(run!.error ?? "", /encore actif/);
  db.prepare("UPDATE cron_run SET status = 'ok' WHERE id = 'run-stale'").run();
});

test("append_session : reprise de la session dédiée de la tâche", async () => {
  const task = (await (await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Append", cron_expr: "0 0 * * *", prompt: "p", agent_id: agentId, workspace_id: wsId, output_policy: "append_session" }),
  })).json()).schedule;

  await cron.fireNow(task.id);
  const runs1 = (await (await fetch(`${base}/api/schedules/${task.id}/runs`)).json()).runs;
  const session1 = runs1[0]!.session_file;

  await cron.fireNow(task.id);
  const runs2 = (await (await fetch(`${base}/api/schedules/${task.id}/runs`)).json()).runs;
  assert.equal(runs2.length, 2);
  assert.ok(runs2.every((run: { session_file: string | null }) => run.session_file === session1), "chaque run reprend la même session dédiée");
  // le client a été repris avec --session
  const lastArgs = clients[clients.length - 1]!.opts.args;
  const idx = lastArgs.indexOf("--session");
  assert.equal(lastArgs[idx + 1], session1);
});

test("runs de même seconde : historique et reprise choisissent le dernier run inséré", async () => {
  const task = (await (await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Same second", cron_expr: "0 0 * * *", prompt: "p", agent_id: agentId, workspace_id: wsId, output_policy: "append_session" }),
  })).json()).schedule;
  const insert = db.prepare("INSERT INTO cron_run (id, task_id, started_at, status, session_file) VALUES (?, ?, '2000-01-01 00:00:00', 'ok', ?)");
  insert.run("tie-first", task.id, "/fake/sessions/first.jsonl");
  insert.run("tie-latest", task.id, "/fake/sessions/latest.jsonl");
  const runs = (await (await fetch(`${base}/api/schedules/${task.id}/runs`)).json()).runs;
  assert.equal(runs[0]!.id, "tie-latest");
  await cron.fireNow(task.id);
  const args = clients.at(-1)!.opts.args;
  assert.equal(args[args.indexOf("--session") + 1], "/fake/sessions/latest.jsonl");
});

test("tick : tâche due avec catchup → fire ; sans catchup → avance le curseur", async () => {
  const dueCatchup = (await (await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "DueCatchup", cron_expr: "* * * * *", prompt: "tick", agent_id: agentId, workspace_id: wsId, catchup: true }),
  })).json()).schedule;
  const dueNoCatchup = (await (await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "DueNoCatchup", cron_expr: "* * * * *", prompt: "tick", agent_id: agentId, workspace_id: wsId, catchup: false }),
  })).json()).schedule;

  // curseurs dans le passé → les deux sont dues
  const past = new Date(Date.now() - 120_000).toISOString();
  db.prepare("UPDATE cron_task SET last_run_at = ? WHERE id IN (?, ?)").run(past, dueCatchup.id, dueNoCatchup.id);

  await cron.tick();
  await new Promise((r) => setTimeout(r, 300)); // laisser le fire async se faire

  const runsC = (await (await fetch(`${base}/api/schedules/${dueCatchup.id}/runs`)).json()).runs;
  assert.ok(runsC.length >= 1, "catchup : un run a été créé");

  const runsN = (await (await fetch(`${base}/api/schedules/${dueNoCatchup.id}/runs`)).json()).runs;
  assert.equal(runsN.length, 0, "pas de catchup : aucun run");
  const after1 = (await (await fetch(`${base}/api/schedules`)).json()).schedules.find((s: { id: string }) => s.id === dueNoCatchup.id);
  assert.ok(new Date(after1.last_run_at).getTime() > Date.now() - 60_000, "curseur avancé");
});
