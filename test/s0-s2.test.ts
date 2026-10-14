import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const home = mkdtempSync(join(tmpdir(), "cog-s0-"));
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
  sessionFile = `/fake/sessions/${Math.random()}.jsonl`;
  constructor(public opts: { cwd: string; args: string[] }) {}
  async start() {}
  async stop() {}
  onEvent() { return () => {}; }
  async getState() { return { sessionFile: this.sessionFile, isStreaming: false }; }
  async prompt() { return {}; }
  async abort() {}
  async setModel() { return {}; }
}

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;
let agentId: string;

before(async () => {
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  assert.equal(opened.version, 4);
  agentId = createAgent(db, {
    name: "Bot A", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [],
  }).id;
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

test("v3 db migrates to v4 with default_workspace_id", () => {
  const legacy = join(home, "legacy.db");
  const raw = new Database(legacy);
  raw.exec(`CREATE TABLE agent_preset (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, system_prompt TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '[]', tools_allowlist TEXT, mcp_servers TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_default INTEGER NOT NULL DEFAULT 0
  );`);
  raw.pragma("user_version = 3");
  raw.close();
  const migrated = openDb(legacy);
  assert.equal(migrated.version, 4);
  const cols = migrated.db.prepare("PRAGMA table_info(agent_preset)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "default_workspace_id"));
  migrated.db.close();
});

test("GET /api/conversations?agent_id= filters 1-1", async () => {
  const other = createAgent(db, {
    name: "Bot B", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [],
  });
  const a1 = await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  assert.equal(a1.status, 201);
  await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: other.id }),
  });
  const filtered = await (await fetch(`${base}/api/conversations?agent_id=${agentId}`)).json() as {
    conversations: Array<{ agent_id: string }>;
  };
  assert.ok(filtered.conversations.length >= 1);
  assert.ok(filtered.conversations.every((c) => c.agent_id === agentId));
});

test("spawn without workspace_id uses preset default_workspace_id", async () => {
  const ws = await (await fetch(`${base}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: projDir }),
  })).json() as { workspace: { id: string; dir: string } };
  const bot = await (await fetch(`${base}/api/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Cwd bot", provider: "openai", model: "gpt-5.4",
      default_workspace_id: ws.workspace.id, skills: [], mcp_servers: [],
    }),
  })).json() as { agent: { id: string; default_workspace_id: string } };
  assert.equal(bot.agent.default_workspace_id, ws.workspace.id);

  const conv = await (await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: bot.agent.id }),
  })).json() as { conversation: { workspace_id: string | null } };
  assert.equal(conv.conversation.workspace_id, ws.workspace.id);
});

test("DELETE workspace SET NULL on agent default_workspace_id", async () => {
  const dir = join(home, "projet-drop");
  mkdirSync(dir);
  const ws = await (await fetch(`${base}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir }),
  })).json() as { workspace: { id: string } };
  const bot = await (await fetch(`${base}/api/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Drop cwd", provider: "openai", model: "gpt-5.4",
      default_workspace_id: ws.workspace.id, skills: [], mcp_servers: [],
    }),
  })).json() as { agent: { id: string } };
  const del = await fetch(`${base}/api/workspaces/${ws.workspace.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const again = await (await fetch(`${base}/api/agents/${bot.agent.id}`)).json() as {
    agent: { default_workspace_id: string | null };
  };
  assert.equal(again.agent.default_workspace_id, null);
});

test("PUT assigns then re-assigns a bot's default workspace (picker path)", async () => {
  const mkWs = (dir: string) => {
    mkdirSync(dir);
    return fetch(`${base}/api/workspaces`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    }).then((r) => r.json()) as Promise<{ workspace: { id: string } }>;
  };
  const wsA = await mkWs(join(home, "picker-a"));
  const wsB = await mkWs(join(home, "picker-b"));
  const created = await (await fetch(`${base}/api/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Picker bot", provider: "openai", model: "gpt-5.4", skills: [], mcp_servers: [] }),
  })).json() as { agent: { id: string; default_workspace_id: string | null } };
  assert.equal(created.agent.default_workspace_id, null);

  const put = (body: Record<string, unknown>) =>
    fetch(`${base}/api/agents/${created.agent.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const baseBody = {
    name: "Picker bot", provider: "openai", model: "gpt-5.4",
    skills: [], mcp_servers: [], subagents: [],
  };

  const r1 = await (await put({ ...baseBody, default_workspace_id: wsA.workspace.id })).json() as { agent: { default_workspace_id: string } };
  assert.equal(r1.agent.default_workspace_id, wsA.workspace.id);

  await fetch(`${base}/api/workspaces/${wsA.workspace.id}`, { method: "DELETE" });
  const cleared = await (await fetch(`${base}/api/agents/${created.agent.id}`)).json() as { agent: { default_workspace_id: string | null } };
  assert.equal(cleared.agent.default_workspace_id, null);

  const r2 = await (await put({ ...baseBody, default_workspace_id: wsB.workspace.id })).json() as { agent: { default_workspace_id: string } };
  assert.equal(r2.agent.default_workspace_id, wsB.workspace.id);
});
