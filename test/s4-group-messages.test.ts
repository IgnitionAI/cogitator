import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const home = mkdtempSync(join(tmpdir(), "cog-s4bus-"));
const piDir = join(home, "pi-agent");
mkdirSync(join(piDir, "agents"), { recursive: true });
mkdirSync(join(home, "skills"), { recursive: true });
const sessionsDir = join(home, "sessions");
mkdirSync(sessionsDir, { recursive: true });
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
  sessionFile = join(sessionsDir, `${randomUUID()}.jsonl`);
  private listener: ((event: unknown) => void) | null = null;
  constructor(public opts: { cwd: string; args: string[] }) {}
  async start() {}
  async stop() {}
  onEvent(listener: (event: unknown) => void) {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  emit(event: unknown) {
    this.listener?.(event);
  }
  async getState() {
    // le fichier doit exister pour la relecture de la réponse finale (agent_end → bus)
    writeFileSync(this.sessionFile, "", { flag: "a" });
    return { sessionFile: this.sessionFile, isStreaming: false };
  }
  async prompt() {
    return {};
  }
  async abort() {}
  async setModel() {
    return {};
  }
}

interface GroupMember {
  agent_id: string;
  conversation_id: string;
  is_host: number;
}

interface Group {
  id: string;
  host_agent_id: string;
  members: GroupMember[];
}

interface GroupMessage {
  group_id: string;
  conversation_id: string | null;
  agent_id: string | null;
  role: string;
  text: string;
  detail: string | null;
  is_error: number;
}

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;
let botA: string;
let botB: string;
let group: Group;
let hostConvId: string;
let memberConvId: string;
let clients: FakeClient[] = [];
let promptCalls: Array<{ convId: string; text: string }> = [];

const post = (url: string, body: unknown) =>
  fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const clientFor = (convId: string): FakeClient => {
  const conv = db.prepare("SELECT session_file FROM conversation WHERE id = ?").get(convId) as { session_file: string };
  const client = clients.find((c) => c.sessionFile === conv.session_file);
  assert.ok(client, `client introuvable pour ${convId}`);
  return client!;
};

before(async () => {
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  assert.equal(opened.version, 6);
  botA = createAgent(db, { name: "Bot A", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
  botB = createAgent(db, { name: "Bot B", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
  const pool = new PiPool({
    factory: (o) => {
      const client = new FakeClient(o);
      clients.push(client);
      return client;
    },
    callbacks: { onStatus: (id, s) => setConversationStatus(db, id, s) },
  });
  // espionnage des injections : quel membre reçoit la ligne utilisateur
  const originalPrompt = pool.prompt.bind(pool);
  pool.prompt = async (convId: string, text: string, images?: unknown[]) => {
    promptCalls.push({ convId, text });
    return originalPrompt(convId, text, images);
  };
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: opened.version, paths: getPaths(), pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const res = await post("/api/groups", { name: "Fil bus", member_agent_ids: [botA, botB] });
  assert.equal(res.status, 201);
  group = (await res.json() as { group: Group }).group;
  hostConvId = group.members.find((m) => m.is_host === 1)!.conversation_id;
  memberConvId = group.members.find((m) => m.is_host === 0)!.conversation_id;
  assert.equal(group.host_agent_id, botA);
});

after(async () => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("v5 db migrates to v6 with the group_message bus table", () => {
  const legacy = join(home, "legacy-v5.db");
  const raw = new Database(legacy);
  raw.exec(`CREATE TABLE agent_preset (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, system_prompt TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '[]', tools_allowlist TEXT, mcp_servers TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_default INTEGER NOT NULL DEFAULT 0, default_workspace_id TEXT
  );
  CREATE TABLE agent_group (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, host_agent_id TEXT NOT NULL,
    default_workspace_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE conversation (
    id TEXT PRIMARY KEY, workspace_id TEXT, agent_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
    thinking TEXT, session_file TEXT UNIQUE, spawn_args TEXT NOT NULL DEFAULT '{}', title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle', group_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  raw.pragma("user_version = 5");
  raw.close();
  const migrated = openDb(legacy);
  assert.equal(migrated.version, 6);
  const tables = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='group_message'").all();
  assert.equal(tables.length, 1);
  migrated.db.close();
});

test("user line without @ is stored on the bus and injected only into the host session", async () => {
  promptCalls = [];
  const res = await post(`/api/groups/${group.id}/messages`, { text: "Bonjour l'équipe" });
  assert.equal(res.status, 200);

  // routage : une seule injection, dans la conversation de l'hôte
  assert.deepEqual(promptCalls.map((p) => p.convId), [hostConvId]);
  assert.equal(promptCalls[0]!.text, "Bonjour l'équipe");

  // stockage sur le fil du groupe
  const { messages } = await (await fetch(`${base}/api/groups/${group.id}/messages`)).json() as { messages: GroupMessage[] };
  const userRow = messages.find((m) => m.role === "user");
  assert.ok(userRow);
  assert.equal(userRow.text, "Bonjour l'équipe");
  assert.equal(userRow.agent_id, null); // message utilisateur : pas d'auteur bot
});

test("@mention routes to that member only; unknown mention falls back to host", async () => {
  promptCalls = [];
  const mentioned = await post(`/api/groups/${group.id}/messages`, { text: "@bot-b peux-tu vérifier ?" });
  assert.equal(mentioned.status, 200);
  assert.deepEqual(promptCalls.map((p) => p.convId), [memberConvId]);

  promptCalls = [];
  const unknown = await post(`/api/groups/${group.id}/messages`, { text: "@inconnu ça va ?" });
  assert.equal(unknown.status, 200);
  assert.deepEqual(promptCalls.map((p) => p.convId), [hostConvId]);
});

test("host tool activity and reply land on the bus attributed to that bot", async () => {
  const host = clientFor(hostConvId);

  // activité outil → ligne bus tool (streamée en direct, persistée pour le rejeu)
  host.emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "fichier listé" }] },
    isError: false,
  });

  // réponse finale : écrite dans le jsonl de la session, relue à agent_end
  writeFileSync(
    host.sessionFile,
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Réponse de l'hôte" }] },
    }) + "\n",
    { flag: "a" },
  );
  host.emit({ type: "agent_end" });

  const { messages } = await (await fetch(`${base}/api/groups/${group.id}/messages`)).json() as { messages: GroupMessage[] };
  const toolRow = messages.find((m) => m.role === "tool");
  assert.ok(toolRow);
  assert.equal(toolRow.text, "bash");
  assert.equal(toolRow.agent_id, botA);
  assert.equal(toolRow.conversation_id, hostConvId);
  assert.match(toolRow.detail ?? "", /fichier listé/);

  const assistantRow = messages.find((m) => m.role === "assistant");
  assert.ok(assistantRow);
  assert.equal(assistantRow.text, "Réponse de l'hôte");
  assert.equal(assistantRow.agent_id, botA); // la réponse apparaît comme ce bot
});

test("the group thread follows ONE SSE feed with member-attributed events", async () => {
  const res = await fetch(`${base}/api/groups/${group.id}/events`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();

  // premier événement : flush des en-têtes (group_ready), on le consomme
  const initial = await reader.read();
  assert.match(Buffer.from(initial.value ?? []).toString(), /group_ready/);

  const read = reader.read();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout SSE")), 5000));
  // activité du membre hôte → événement group_activity sur le seul flux du fil
  clientFor(hostConvId).emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  const { value } = await Promise.race([read, timeout]);
  const chunk = Buffer.from(value ?? []).toString();
  assert.match(chunk, /group_activity/);
  assert.match(chunk, new RegExp(botA)); // attribution bot dans l'enveloppe
  await reader.cancel();
});
