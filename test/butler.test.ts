import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const home = mkdtempSync(join(tmpdir(), "cog-butler-"));
const piDir = join(home, "pi-agent");
const agentsDir = join(piDir, "agents");
const skillsDir = join(home, "skills");
mkdirSync(agentsDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = agentsDir;
process.env.COGITATOR_SKILLS_DIRS = skillsDir;
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));
writeFileSync(join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.4" }));

const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool } = await import("../src/pool.js");
const { setConversationStatus } = await import("../src/conversations.js");
const { seedDefaultAgents, findPackageRoot } = await import("../src/default-agent.js");
const { getDefaultAgentId, setDefaultAgent, createAgent, getAgent } = await import("../src/agents.js");

let fakeCounter = 0;
class FakeClient {
  opts: { cwd: string; args: string[]; env?: Record<string, string> };
  sessionFile: string;
  constructor(opts: { cwd: string; args: string[]; env?: Record<string, string> }) {
    this.opts = opts;
    this.sessionFile = `/fake/sessions/butler-${fakeCounter++}.jsonl`;
  }
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
let webDistRoot: string;

before(async () => {
  ({ db } = openDb(join(home, "cogitator.db")));
  const pool = new PiPool({
    factory: (o) => new FakeClient(o),
    callbacks: { onStatus: (id, s) => setConversationStatus(db, id, s) },
  });
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: 3, paths: getPaths(), pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  webDistRoot = findPackageRoot(import.meta.dirname)!;
});

after(async () => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("seed : Majordome (défaut) + Chef de Projet + Architecte de Skills, MCP cogitator, idempotent", () => {
  const r1 = seedDefaultAgents(db, getPaths());
  assert.equal(r1.majordome, true);
  assert.equal(r1.chef, true);
  const majRow = db.prepare("SELECT id FROM agent_preset WHERE slug = 'majordome'").get() as { id: string };
  const maj = getAgent(db, majRow.id)!;
  assert.equal(maj.is_default, 1);
  assert.equal(maj.provider, "openai"); // repris des defaults pi
  assert.equal(maj.mcp_servers.length, 1);
  assert.equal(maj.mcp_servers[0]!.name, "cogitator");
  assert.match(maj.mcp_servers[0]!.args?.[0] ?? "", /mcp-server\.js$/);
  assert.match(maj.system_prompt, /Majordome/);

  const chefRow = db.prepare("SELECT id FROM agent_preset WHERE slug = 'chef-de-projet'").get() as { id: string };
  const chef = getAgent(db, chefRow.id)!;
  assert.equal(chef.is_default ?? 0, 0); // pas l'agent par défaut
  assert.match(chef.system_prompt, /cogitator\.board\.json/);
  assert.match(chef.system_prompt, /Chef de Projet/);

  const archRow = db.prepare("SELECT id FROM agent_preset WHERE slug = 'architecte-de-skills'").get() as { id: string };
  const arch = getAgent(db, archRow.id)!;
  assert.match(arch.system_prompt, /Agent Skills/);
  assert.equal(arch.mcp_servers[0]!.name, "cogitator");

  const r2 = seedDefaultAgents(db, getPaths());
  assert.equal(r2.majordome, false); // idempotent
  assert.equal(r2.chef, false);
  assert.equal(r2.architecte, false);
  const count = db.prepare("SELECT COUNT(*) AS n FROM agent_preset").get() as { n: number };
  assert.equal(count.n, 3);
});

test("défaut unique : setDefaultAgent bascule, un seul à 1", () => {
  const other = createAgent(db, { name: "Second", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] });
  assert.equal(setDefaultAgent(db, other.id), true);
  assert.equal(getDefaultAgentId(db), other.id);
  const ones = db.prepare("SELECT COUNT(*) AS n FROM agent_preset WHERE is_default = 1").get() as { n: number };
  assert.equal(ones.n, 1);
  assert.equal(setDefaultAgent(db, "ghost"), false);
});

test("conversation sans rien préciser → agent par défaut global", async () => {
  const res = await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
  const { conversation } = await res.json();
  assert.equal(conversation.agent_id, getDefaultAgentId(db));
});

test("route POST /api/agents/:id/default", async () => {
  const maj = db.prepare("SELECT id FROM agent_preset WHERE slug = 'majordome'").get() as { id: string };
  const res = await fetch(`${base}/api/agents/${maj.id}/default`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(getDefaultAgentId(db), maj.id);
});

// ---------- MCP serveur : handshake stdio réel contre le serveur HTTP ----------

function mcpRoundTrip(requests: Array<Record<string, unknown>>, env: NodeJS.ProcessEnv): Promise<string> {
  const script = join(webDistRoot, "dist", "src", "mcp-server.js");
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    setTimeout(() => {
      child.kill();
      resolve(out);
    }, 4000);
  });
}

test("serveur MCP : initialize + tools/list + cogitator_health", async () => {
  const out = await mcpRoundTrip([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cogitator_health", arguments: {} } },
  ], { COGITATOR_URL: base });

  const responses = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const init = responses.find((r) => r.id === 1);
  assert.ok(init?.result?.capabilities?.tools, "initialize renvoie les capacités tools");
  const list = responses.find((r) => r.id === 2);
  const toolNames = list.result.tools.map((t: { name: string }) => t.name);
  assert.ok(toolNames.includes("cogitator_create_agent"));
  assert.ok(toolNames.includes("cogitator_create_schedule"));
  assert.ok(toolNames.includes("cogitator_health"));
  assert.ok(toolNames.length >= 15);
  const health = responses.find((r) => r.id === 3);
  assert.equal(health.result.isError, undefined);
  assert.match(health.result.content[0].text, /"ok": true/);
});

test("serveur MCP : cogitator_create_agent crée réellement un agent", async () => {
  const out = await mcpRoundTrip([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "cogitator_create_agent", arguments: { name: "Agent via MCP", provider: "openai", model: "gpt-5.4", system_prompt: "Créé par le Majordome." } },
    },
  ], { COGITATOR_URL: base });
  const responses = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const created = responses.find((r) => r.id === 2);
  assert.equal(created.result.isError, undefined);
  const agent = db.prepare("SELECT * FROM agent_preset WHERE name = 'Agent via MCP'").get();
  assert.ok(agent, "l'agent créé via MCP existe en base");
  const md = db.prepare("SELECT name FROM subagent_setup").all();
  void md;
});
