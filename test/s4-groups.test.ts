import { FakeConfiguration } from "./fixtures/fake-configuration.js";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const home = mkdtempSync(join(tmpdir(), "cog-s4-"));
const piDir = join(home, "pi-agent");
mkdirSync(join(piDir, "agents"), { recursive: true });
mkdirSync(join(home, "skills"), { recursive: true });
const projDir = join(home, "projet");
mkdirSync(projDir, { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = join(piDir, "agents");
process.env.COGITATOR_SKILLS_DIRS = join(home, "skills");
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));

const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool } = await import("../src/pool.js");
const { setConversationStatus } = await import("../src/conversations.js");
const { createAgent } = await import("../src/agents.js");

class FakeClient {
  configuration = new FakeConfiguration(() => this.opts.args);
  getAvailableModels() { return this.configuration.getAvailableModels(); }
  getAvailableThinkingLevels() { return this.configuration.getAvailableThinkingLevels(); }
  setThinkingLevel(level: Parameters<FakeConfiguration["setThinkingLevel"]>[0]) { return this.configuration.setThinkingLevel(level); }
  sessionFile = `/fake/sessions/${Math.random()}.jsonl`;
  constructor(public opts: { cwd: string; args: string[] }) {}
  async start() {}
  async stop() {}
  onEvent() { return () => {}; }
  async getState() { return { ...await this.configuration.getState(), sessionFile: this.sessionFile, isStreaming: false }; }
  async prompt() { return {}; }
  async abort() {}
  async setModel(provider: string, id: string) { return this.configuration.setModel(provider, id); }
}

interface GroupMember {
  agent_id: string;
  name: string;
  conversation_id: string;
  is_host: number;
}

interface Group {
  id: string;
  name: string;
  host_agent_id: string;
  default_workspace_id: string | null;
  members: GroupMember[];
}

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;
let botA: string;
let botB: string;
let botC: string;

const post = (url: string, body: unknown) =>
  fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

before(async () => {
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  assert.equal(opened.version, 8);
  botA = createAgent(db, { name: "Bot A", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
  botB = createAgent(db, { name: "Bot B", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
  botC = createAgent(db, { name: "Bot C", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
  const pool = new PiPool({
    factory: (o) => new FakeClient(o),
    callbacks: { onStatus: (id, s) => setConversationStatus(db, id, s) },
  });
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: opened.version, paths: getPaths(), pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("v4 db migrates to v5 with agent_group and conversation.group_id", () => {
  const legacy = join(home, "legacy-v4.db");
  const raw = new Database(legacy);
  raw.exec(`CREATE TABLE agent_preset (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, system_prompt TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '[]', tools_allowlist TEXT, mcp_servers TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_default INTEGER NOT NULL DEFAULT 0, default_workspace_id TEXT
  );
  CREATE TABLE workspace (
    id TEXT PRIMARY KEY, dir TEXT NOT NULL UNIQUE, name TEXT NOT NULL, default_agent_id TEXT
  );
  CREATE TABLE conversation (
    id TEXT PRIMARY KEY, workspace_id TEXT, agent_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
    thinking TEXT, session_file TEXT UNIQUE, spawn_args TEXT NOT NULL DEFAULT '{}', title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  raw.pragma("user_version = 4");
  raw.close();
  const migrated = openDb(legacy);
  assert.equal(migrated.version, 8);
  const tables = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_group'").all();
  assert.equal(tables.length, 1);
  const cols = migrated.db.prepare("PRAGMA table_info(conversation)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "group_id"));
  migrated.db.close();
});

test("POST /api/groups creates a group with private idle member sessions", async () => {
  const res = await post("/api/groups", { name: "Équipe test", member_agent_ids: [botA, botB, botC] });
  assert.equal(res.status, 201);
  const { group } = await res.json() as { group: Group };
  assert.equal(group.name, "Équipe test");
  assert.equal(group.host_agent_id, botA); // hôte = premier membre par défaut
  assert.equal(group.members.length, 3);
  for (const m of group.members) {
    assert.equal(m.is_host, m.agent_id === botA ? 1 : 0);
    assert.ok(m.conversation_id);
  }

  // sessions idle : chaque membre a une conversation privée avec session_file
  const convs = db.prepare("SELECT * FROM conversation WHERE group_id = ?").all(group.id) as Array<{ agent_id: string; session_file: string | null; group_id: string }>;
  assert.equal(convs.length, 3);
  assert.ok(convs.every((c) => c.session_file !== null));

  // visible dans la liste
  const listed = await (await fetch(`${base}/api/groups`)).json() as { groups: Group[] };
  assert.ok(listed.groups.some((g) => g.id === group.id && g.members.length === 3));

  const one = await (await fetch(`${base}/api/groups/${group.id}`)).json() as { group: Group };
  assert.equal(one.group.id, group.id);
});

test("resume-last ignores group member conversations", async () => {
  await post("/api/groups", { name: "Groupe isolé", member_agent_ids: [botA, botB] });
  // le fil 1–1 du bot A reste vide : ses conversations de groupe ne remontent pas
  const listed = await (await fetch(`${base}/api/conversations?agent_id=${botA}`)).json() as {
    conversations: Array<{ group_id?: string | null }>;
  };
  assert.equal(listed.conversations.length, 0);
});

test("group size outside 2-6 is rejected", async () => {
  const one = await post("/api/groups", { name: "Solo", member_agent_ids: [botA] });
  assert.equal(one.status, 400);
  const seven = await post("/api/groups", {
    name: "Trop grand",
    member_agent_ids: [botA, botB, botC, botA, botB, botC, botA],
  });
  assert.equal(seven.status, 400); // zod max 6 avant déduplication
});

test("duplicates collapse; host must be a member; unknown agent rejected", async () => {
  const dup = await post("/api/groups", { name: "Dédoublonné", member_agent_ids: [botA, botA, botB] });
  assert.equal(dup.status, 201);
  const { group } = await dup.json() as { group: Group };
  assert.equal(group.members.length, 2);

  const badHost = await post("/api/groups", { name: "Mauvais hôte", member_agent_ids: [botA, botB], host_agent_id: botC });
  assert.equal(badHost.status, 400);

  const unknown = await post("/api/groups", { name: "Inconnu", member_agent_ids: [botA, "nope"] });
  assert.equal(unknown.status, 404);
});

test("explicit host and optional workspace are honored", async () => {
  const ws = await (await post("/api/workspaces", { dir: projDir })).json() as { workspace: { id: string } };
  const res = await post("/api/groups", {
    name: "Avec workspace",
    member_agent_ids: [botA, botB],
    host_agent_id: botB,
    default_workspace_id: ws.workspace.id,
  });
  assert.equal(res.status, 201);
  const { group } = await res.json() as { group: Group };
  assert.equal(group.host_agent_id, botB);
  assert.equal(group.default_workspace_id, ws.workspace.id);
  const convs = db.prepare("SELECT workspace_id FROM conversation WHERE group_id = ?").all(group.id) as Array<{ workspace_id: string | null }>;
  assert.ok(convs.every((c) => c.workspace_id === ws.workspace.id));

  // sans workspace : repli sur le workspace par défaut du preset hôte (ADR-011)
  const hostDir = join(home, "projet-hote");
  mkdirSync(hostDir);
  const wsHost = await (await post("/api/workspaces", { dir: hostDir })).json() as { workspace: { id: string } };
  await fetch(`${base}/api/agents/${botA}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bot A", provider: "openai", model: "gpt-5.4", default_workspace_id: wsHost.workspace.id }),
  });
  const fallback = await post("/api/groups", { name: "Repli hôte", member_agent_ids: [botA, botC] });
  assert.equal(fallback.status, 201);
  const { group: g2 } = await fallback.json() as { group: Group };
  const convs2 = db.prepare("SELECT workspace_id FROM conversation WHERE group_id = ?").all(g2.id) as Array<{ workspace_id: string | null }>;
  assert.ok(convs2.every((c) => c.workspace_id === wsHost.workspace.id));
});

test("DELETE /api/groups/:id cascades member conversations", async () => {
  const res = await post("/api/groups", { name: "Supprimable", member_agent_ids: [botA, botB] });
  const { group } = await res.json() as { group: Group };
  const del = await fetch(`${base}/api/groups/${group.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM conversation WHERE group_id = ?").get(group.id) as { n: number };
  assert.equal(remaining.n, 0);
  const missing = await fetch(`${base}/api/groups/${group.id}`);
  assert.equal(missing.status, 404);
});
