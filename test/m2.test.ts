import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const home = mkdtempSync(join(tmpdir(), "cog-m2-"));
const piDir = join(home, "pi-agent");
const agentsDir = join(piDir, "agents");
const skillsDir = join(home, "skills");
mkdirSync(agentsDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = agentsDir;
process.env.COGITATOR_SKILLS_DIRS = skillsDir;

writeFileSync(join(piDir, "models-store.json"), JSON.stringify({
  deepseek: { models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] },
  openai: { models: [{ id: "gpt-5.4" }] },
}));
writeFileSync(join(piDir, "auth.json"), "{}");

const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool, PoolError } = await import("../src/pool.js");
const { buildArgs, modelArg } = await import("../src/spawn.js");
const { createAgent } = await import("../src/agents.js");
const { setConversationStatus } = await import("../src/conversations.js");

// ---------- Fake pi client ----------

class FakeClient {
  static instances: FakeClient[] = [];
  opts: { cwd: string; args: string[] };
  prompts: Array<{ text: string; images?: unknown[] }> = [];
  aborted = 0;
  modelsSet: Array<[string, string]> = [];
  stopped = false;
  state = { sessionFile: `/fake/sessions/${FakeClient.instances.length}.jsonl`, isStreaming: false };
  private listeners = new Set<(e: unknown) => void>();

  constructor(opts: { cwd: string; args: string[] }) {
    this.opts = opts;
    FakeClient.instances.push(this);
  }
  async start() {}
  async stop() { this.stopped = true; }
  onEvent(l: (e: unknown) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  async getState() { return this.state; }
  async prompt(text: string, images?: unknown[]) {
    this.prompts.push({ text, images });
    for (const l of this.listeners) l({ type: "message_update", text });
    return { disposition: "accepted" };
  }
  async abort() { this.aborted++; }
  async setModel(p: string, m: string) { this.modelsSet.push([p, m]); }
}

function lastClient(): FakeClient {
  return FakeClient.instances[FakeClient.instances.length - 1]!;
}

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;

before(async () => {
  ({ db } = openDb(join(home, "cogitator.db")));
  const pool = new PiPool({
    factory: (o) => new FakeClient(o),
    idleMs: 1_000,
    callbacks: { onStatus: (id, s) => setConversationStatus(db, id, s) },
  });
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: 3, paths: getPaths(), pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

// ---------- Matérialisation des flags (checklist item 2) ----------

test("buildArgs matérialise le preset en flags natifs pi", () => {
  const args = buildArgs(
    {
      provider: "openai", model: "gpt-5.4", thinking: "high",
      systemPrompt: "Scope RAG.", skills: ["/skills/a", "/skills/b"], tools: ["read", "bash"],
    },
    join(home, "tmp"), "conv-1",
  );
  assert.deepEqual(args, [
    "--model", "openai/gpt-5.4:high",
    "--append-system-prompt", join(home, "tmp", "conv-1.prompt.md"),
    "--no-skills", "--skill", "/skills/a", "--skill", "/skills/b",
    "--tools", "read,bash",
  ]);
  const content = readFileSync(join(home, "tmp", "conv-1.prompt.md"), "utf8");
  assert.equal(content, "Scope RAG.");
  assert.equal(modelArg({ provider: "x", model: "y" }), "x/y"); // sans thinking
});

// ---------- Conversations ----------

const preset = createAgent(db, {
  name: "Conv Agent", provider: "openai", model: "gpt-5.4", thinking: "low",
  system_prompt: "Tu es un agent de conversation.", skills: [], mcp_servers: [],
});

test("POST /api/conversations avec agent : snapshot figé du preset (O6)", async () => {
  const res = await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: preset.id, prompt: "Bonjour, présente-toi" }),
  });
  assert.equal(res.status, 201);
  const { conversation } = await res.json();
  assert.equal(conversation.status, "active");
  assert.equal(conversation.title, "Bonjour, présente-toi");
  const spawn = JSON.parse(conversation.spawn_args);
  assert.equal(spawn.provider, "openai");
  assert.equal(spawn.systemPrompt, "Tu es un agent de conversation.");
  const client = lastClient();
  assert.deepEqual(client.prompts.map((p) => p.text), ["Bonjour, présente-toi"]);
  const pair = (flag: string) => {
    const i = client.opts.args.indexOf(flag);
    return i >= 0 ? client.opts.args[i + 1] : undefined;
  };
  assert.equal(pair("--model"), "openai/gpt-5.4:low");
  assert.ok(pair("--append-system-prompt")?.endsWith(".prompt.md"));
  assert.ok(conversation.session_file.endsWith(".jsonl"));
});

test("POST /api/conversations libre ad hoc, sans workspace (checklist item 9)", async () => {
  const res = await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "deepseek", model: "deepseek-flash" }),
  });
  assert.equal(res.status, 201);
  const { conversation } = await res.json();
  assert.equal(conversation.workspace_id, null);
  assert.equal(conversation.agent_id, null);
  assert.equal(conversation.status, "idle"); // spawn paresseux : pas de prompt
});

test("messages démarre la session paresseuse ; stop → abort ; model → setModel", async () => {
  const { conversation } = await (await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "deepseek", model: "deepseek-flash" }),
  })).json();

  await fetch(`${base}/api/conversations/${conversation.id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: " Premier message " }),
  });
  const client = lastClient();
  assert.deepEqual(client.prompts.map((p) => p.text), [" Premier message ".trim()]);

  await fetch(`${base}/api/conversations/${conversation.id}/stop`, { method: "POST" });
  assert.equal(client.aborted, 1);

  const sw = await fetch(`${base}/api/conversations/${conversation.id}/model`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openai", id: "gpt-5.4" }),
  });
  assert.equal(sw.status, 200);
  assert.deepEqual(client.modelsSet, [["openai", "gpt-5.4"]]);
  const after2 = await (await fetch(`${base}/api/conversations/${conversation.id}`)).json();
  assert.equal(after2.conversation.provider, "openai");
});

test("DELETE ferme la conversation (process stoppé, .jsonl conservé)", async () => {
  const { conversation } = await (await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "deepseek", model: "deepseek-flash" }),
  })).json();
  await fetch(`${base}/api/conversations/${conversation.id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }),
  });
  const client = lastClient();
  await fetch(`${base}/api/conversations/${conversation.id}`, { method: "DELETE" });
  assert.equal(client.stopped, true);
  const gone = await fetch(`${base}/api/conversations/${conversation.id}`);
  assert.equal(gone.status, 404);
});

// ---------- Pool : cap, idle, resume ----------

test("pool : cap avec éviction du plus vieux non-streaming", async () => {
  const pool = new PiPool({ factory: (o) => new FakeClient(o), max: 2 });
  await pool.ensure("a", { cwd: "/tmp", args: [] });
  await pool.ensure("b", { cwd: "/tmp", args: [] });
  pool.backdate("a", Date.now() - 60_000);
  await pool.ensure("c", { cwd: "/tmp", args: [] }); // évince a (le plus vieux, non-streaming)
  assert.equal(pool.isLive("a"), false);
  assert.equal(pool.isLive("b"), true);
  assert.equal(pool.isLive("c"), true);
});

test("pool : cap plein de sessions streaming → PoolError pool_full", async () => {
  const pool = new PiPool({ factory: (o) => new FakeClient(o), max: 1 });
  await pool.ensure("x", { cwd: "/tmp", args: [] });
  for (const c of FakeClient.instances) c.state.isStreaming = true;
  await assert.rejects(() => pool.ensure("y", { cwd: "/tmp", args: [] }), (e: Error) => e instanceof PoolError && e.code === "pool_full");
});

test("pool : idle sweep recycle les process inactifs (checklist item 8)", async () => {
  const pool = new PiPool({ factory: (o) => new FakeClient(o), idleMs: 100 });
  await pool.ensure("s1", { cwd: "/tmp", args: [] });
  pool.backdate("s1", Date.now() - 5_000);
  await pool.sweep();
  assert.equal(pool.isLive("s1"), false);
});

test("pool : reprise de session (--session figé dans les args)", async () => {
  const pool = new PiPool({ factory: (o) => new FakeClient(o) });
  await pool.ensure("r1", { cwd: "/tmp", args: ["--model", "openai/gpt-5.4"], resumeSessionFile: "/sessions/old.jsonl" });
  assert.deepEqual(lastClient().opts.args.slice(-2), ["--session", "/sessions/old.jsonl"]);
});

// ---------- Migration v1 → v2 ----------

test("migration v1 → v2 : session_file devient nullable + spawn_args", () => {
  const v1db = join(home, "v1.db");
  const legacy = new Database(v1db);
  legacy.exec(`CREATE TABLE conversation (
    id TEXT PRIMARY KEY, workspace_id TEXT, agent_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
    thinking TEXT, session_file TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'spawning',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE agent_preset (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
  INSERT INTO conversation (id, provider, model, session_file) VALUES ('legacy-1', 'openai', 'gpt-4', '/s.jsonl');
  `);
  legacy.pragma("user_version = 1");
  legacy.close();

  const { db: migrated, version } = openDb(v1db);
  assert.equal(version, 3);
  const row = migrated.prepare("SELECT * FROM conversation WHERE id = 'legacy-1'").get() as { session_file: string; spawn_args: string };
  assert.equal(row.session_file, "/s.jsonl");
  assert.equal(row.spawn_args, "{}");
  // nullable désormais (FK off : le fixture n'a pas les tables parentes, sans rapport avec la nullability)
  migrated.pragma("foreign_keys = OFF");
  migrated.prepare("INSERT INTO conversation (id, provider, model) VALUES ('new-1', 'openai', 'gpt-4')").run();
  migrated.close();
});
