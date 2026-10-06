import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const home = mkdtempSync(join(tmpdir(), "cog-m3-"));
const piDir = join(home, "pi-agent");
const agentsDir = join(piDir, "agents");
const skillsDir = join(home, "skills");
const projDir = join(home, "projet-a");
const projBDir = join(home, "projet-b");
mkdirSync(agentsDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
mkdirSync(projDir, { recursive: true });
mkdirSync(projBDir, { recursive: true });
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
const { browseDir } = await import("../src/workspaces.js");

let fakeCounter = 0;

class FakeClient {
  static instances: FakeClient[] = [];
  opts: { cwd: string; args: string[] };
  sessionFile: string;
  constructor(opts: { cwd: string; args: string[] }) {
    this.opts = opts;
    this.sessionFile = `/fake/sessions/${fakeCounter++}.jsonl`;
    FakeClient.instances.push(this);
  }
  async start() {}
  async stop() {}
  onEvent() { return () => {}; }
  async getState() { return { sessionFile: this.sessionFile, isStreaming: false }; }
  async prompt() { return {}; }
  async abort() {}
  async setModel() { return {}; }
}

function lastClient(): FakeClient {
  return FakeClient.instances[FakeClient.instances.length - 1]!;
}

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;
let agentId: string;

before(async () => {
  ({ db } = openDb(join(home, "cogitator.db")));
  agentId = createAgent(db, {
    name: "WS Agent", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [],
  }).id;
  const pool = new PiPool({
    factory: (o) => new FakeClient(o),
    callbacks: { onStatus: (id, s) => setConversationStatus(db, id, s) },
  });
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: 2, paths: getPaths(), pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

// ---------- Workspaces CRUD ----------

test("POST /api/workspaces : dir existant requis, nom dérivé du dossier", async () => {
  const res = await fetch(`${base}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: projDir }),
  });
  assert.equal(res.status, 201);
  const { workspace } = await res.json();
  assert.equal(workspace.name, "projet-a");
  assert.equal(workspace.dir, realpathSync(projDir)); // /tmp est un symlink sur macOS : chemin canonicalisé

  const again = await fetch(`${base}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: projDir }),
  });
  assert.equal(again.status, 400); // dir unique

  const ghost = await fetch(`${base}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: join(home, "nope") }),
  });
  assert.equal(ghost.status, 400); // dossier doit exister
});

test("workspace avec agent par défaut + PUT renomme", async () => {
  const res = await fetch(`${base}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: projBDir, name: "Projet B", default_agent_id: agentId }),
  });
  const { workspace } = await res.json();
  assert.equal(workspace.default_agent_id, agentId);

  const renamed = await fetch(`${base}/api/workspaces/${workspace.id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Projet B renommé" }),
  });
  assert.equal((await renamed.json()).workspace.name, "Projet B renommé");

  const bad = await fetch(`${base}/api/workspaces/${workspace.id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ default_agent_id: "ghost" }),
  });
  assert.equal(bad.status, 400);
});

test("GET /api/workspaces liste avec nb de conversations", async () => {
  const { workspaces } = await (await fetch(`${base}/api/workspaces`)).json();
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces[0].conversation_count, 0);
});

// ---------- Conversations rattachées ----------

test("conversation dans un workspace : cwd = dir du workspace au spawn (checklist item 4)", async () => {
  const { workspaces } = await (await fetch(`${base}/api/workspaces`)).json();
  const ws = workspaces.find((w: { dir: string }) => w.dir === realpathSync(projDir));

  const res = await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: ws.id, provider: "openai", model: "gpt-5.4", prompt: "hello" }),
  });
  assert.equal(res.status, 201);
  const { conversation } = await res.json();
  assert.equal(conversation.workspace_id, ws.id);
  assert.equal(conversation.agent_id, null); // provider ad hoc, pas d'héritage
  assert.equal(lastClient().opts.cwd, realpathSync(projDir));

  // héritage de l'agent par défaut (projet-b)
  const wsB = workspaces.find((w: { dir: string }) => w.dir === realpathSync(projBDir));
  const resB = await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: wsB.id, prompt: "hi" }),
  });
  const convB = (await resB.json()).conversation;
  assert.equal(convB.agent_id, agentId);
  const spawnB = JSON.parse(convB.spawn_args);
  assert.equal(spawnB.provider, "openai");

  const filtered = await (await fetch(`${base}/api/conversations?workspace_id=${ws.id}`)).json();
  assert.equal(filtered.conversations.length, 1);
});

test("DELETE workspace : les conversations deviennent libres (SET NULL), sessions survivent", async () => {
  const { workspaces } = await (await fetch(`${base}/api/workspaces`)).json();
  const ws = workspaces.find((w: { dir: string }) => w.dir === realpathSync(projDir));
  await fetch(`${base}/api/workspaces/${ws.id}`, { method: "DELETE" });
  const convs = await (await fetch(`${base}/api/conversations`)).json();
  const orphan = convs.conversations.find((c: { workspace_id: string | null }) => c.workspace_id === null && c.title === "hello");
  assert.ok(orphan, "la conversation orpheline existe encore");
  const list = await (await fetch(`${base}/api/workspaces`)).json();
  assert.equal(list.workspaces.length, 1);
});

// ---------- File-picker ----------

test("GET /api/fs/browse liste les dossiers (dirs d'abord, cachés exclus)", async () => {
  const res = await fetch(`${base}/api/fs/browse?path=${encodeURIComponent(home)}`);
  assert.equal(res.status, 200);
  const { path, parent, entries } = await res.json();
  assert.equal(path, realpathSync(home)); // /tmp → /private/tmp sur macOS
  assert.ok(parent);
  const names = entries.map((e: { name: string }) => e.name);
  assert.ok(names.includes("projet-a") && names.includes("projet-b"));
  assert.ok(!names.includes(".hidden"));
  const types = entries.map((e: { type: string }) => e.type);
  assert.deepEqual(types, [...types].sort((a, b) => (a === b ? 0 : a === "dir" ? -1 : 1)));
});

test("GET /api/fs/browse sans path part de $HOME ; chemin invalide → 400", async () => {
  const res = await fetch(`${base}/api/fs/browse`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).path, process.env.HOME);
  const bad = await fetch(`${base}/api/fs/browse?path=/chemin/introuvable`);
  assert.equal(bad.status, 400);
});

test("browseDir direct : fichier → erreur", () => {
  const f = join(home, "f.txt");
  writeFileSync(f, "x");
  const r = browseDir(f);
  assert.ok("error" in r);
});
