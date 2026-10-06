import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const home = mkdtempSync(join(tmpdir(), "cog-m4-"));
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

const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool } = await import("../src/pool.js");
const { setConversationStatus } = await import("../src/conversations.js");
const { createAgent } = await import("../src/agents.js");
const { encodeMcpEnv, decodeMcpEnv, MCP_ENV_VAR } = await import("../src/mcp-env.js");

let fakeCounter = 0;
class FakeClient {
  opts: { cwd: string; args: string[]; env?: Record<string, string> };
  sessionFile: string;
  constructor(opts: { cwd: string; args: string[]; env?: Record<string, string> }) {
    this.opts = opts;
    this.sessionFile = `/fake/sessions/m4-${fakeCounter++}.jsonl`;
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
const clients: FakeClient[] = [];
let presetWithMcp: string;

before(async () => {
  ({ db } = openDb(join(home, "cogitator.db")));
  presetWithMcp = createAgent(db, {
    name: "MCP Agent", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [],
    mcp_servers: [
      { name: "echo", command: "node", args: ["/fixtures/echo-mcp-server.mjs"] },
      { name: "broken" }, // sans command ni url → filtré
    ],
  }).id;
  const pool = new PiPool({
    factory: (o) => {
      const c = new FakeClient(o);
      clients.push(c);
      return c;
    },
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

// ---------- encode/decode ----------

test("encodeMcpEnv filtre les entrées invalides ; undefined si vide", () => {
  const env = encodeMcpEnv([
    { name: "ok", command: "node" },
    { name: "broken" },
    { name: "http-ok", url: "http://127.0.0.1:1/mcp" },
  ]);
  const parsed = JSON.parse(env!);
  assert.deepEqual(parsed.map((e: { name: string }) => e.name), ["ok", "http-ok"]);
  assert.equal(encodeMcpEnv([{ name: "broken" }]), undefined);
  assert.equal(encodeMcpEnv([]), undefined);
});

test("decodeMcpEnv : null si absent/JSON invalide ; config sans name", () => {
  assert.equal(decodeMcpEnv(undefined), null);
  assert.equal(decodeMcpEnv("pas du json"), null);
  assert.equal(decodeMcpEnv('{"a":1}'), null);
  const regs = decodeMcpEnv('[{"name":"echo","command":"node","args":["x.js"]},{"name":"bad"}]');
  assert.equal(regs!.length, 1);
  assert.equal(regs![0]!.name, "echo");
  assert.deepEqual(regs![0]!.config, { command: "node", args: ["x.js"] });
});

test("roundtrip encode → decode", () => {
  const entries = [{ name: "a", command: "node", args: ["server.js"], env: { KEY: "v" } }];
  const regs = decodeMcpEnv(encodeMcpEnv(entries))!;
  assert.deepEqual(regs, [{ name: "a", config: { command: "node", args: ["server.js"], env: { KEY: "v" } } }]);
});

// ---------- Env transporté au spawn ----------

test("spawn d'une conversation preset MCP : COGITATOR_MCP dans l'env du process pi", async () => {
  const res = await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: presetWithMcp, prompt: "hi" }),
  });
  assert.equal(res.status, 201);
  const client = clients[clients.length - 1]!;
  const raw = client.opts.env?.[MCP_ENV_VAR];
  assert.ok(raw, "COGITATOR_MCP présent dans l'env");
  const regs = decodeMcpEnv(raw)!;
  assert.deepEqual(regs.map((r) => r.name), ["echo"]); // l'entrée broken a été filtrée
  assert.equal(regs[0]!.config.command, "node");

  // snapshot figé contient les mcpServers (O6)
  const { conversation } = await res.json();
  const spawn = JSON.parse(conversation.spawn_args);
  assert.equal(spawn.mcpServers.length, 2);
});

test("conversation sans MCP : pas de COGITATOR_MCP dans l'env", async () => {
  const preset = createAgent(db, {
    name: "No MCP", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [],
  });
  await fetch(`${base}/api/conversations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: preset.id, prompt: "hi" }),
  });
  const client = clients[clients.length - 1]!;
  assert.equal(client.opts.env?.[MCP_ENV_VAR], undefined);
});

test("validateAgent rejette les entrées MCP sans command ni url", async () => {
  const { validateAgent } = await import("../src/agents.js");
  const v = await validateAgent(getPaths(), {
    name: "x", provider: "openai", model: "gpt-5.4", mcp_servers: [{ name: "ko" }],
  }, () => Promise.resolve(true));
  assert.ok(v.errors.some((e) => e.includes("command ou url requis")));
});
