/** Branchement server.ts : messages UI → queue_item, outil team_send. */
import { FakeConfiguration } from "./fixtures/fake-configuration.js";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { getPaths } from "../src/paths.js";
import { createApp } from "../src/server.js";
import { PiPool } from "../src/pool.js";
import { createAgent } from "../src/agents.js";
import { setConversationStatus } from "../src/conversations.js";
import { DEFAULT_HOP_LIMIT, listItems } from "../src/team-queue.js";

const home = mkdtempSync(join(tmpdir(), "cog-q1-http-"));
const piDir = join(home, "pi-agent");
mkdirSync(join(piDir, "agents"), { recursive: true });
mkdirSync(join(home, "skills"), { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = join(piDir, "agents");
process.env.COGITATOR_SKILLS_DIRS = join(home, "skills");
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));

class FakeClient {
  configuration = new FakeConfiguration(() => this.opts.args);
  getAvailableModels() { return this.configuration.getAvailableModels(); }
  getAvailableThinkingLevels() { return this.configuration.getAvailableThinkingLevels(); }
  setThinkingLevel(level: Parameters<FakeConfiguration["setThinkingLevel"]>[0]) { return this.configuration.setThinkingLevel(level); }
  prompts: string[] = [];
  private listeners = new Set<(e: unknown) => void>();
  constructor(readonly opts: { cwd: string; args: string[]; env?: Record<string, string> }) {}
  async start() {}
  async stop() {}
  onEvent(l: (e: unknown) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  async getState() { return { ...await this.configuration.getState(), sessionFile: "/fake/q1.jsonl", isStreaming: false }; }
  async prompt(text: string) {
    this.prompts.push(text);
    for (const l of this.listeners) l({ type: "agent_settled" });
    return { disposition: "started" };
  }
  async abort() {}
  async setModel(p: string, m: string) { return this.configuration.setModel(p, m); }
}

const clients: FakeClient[] = [];
let db: ReturnType<typeof openDb>["db"];
let server: ReturnType<typeof createApp>;
let base: string;
let agentA: string;
let agentB: string;

before(async () => {
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  agentA = createAgent(db, { name: "A", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
  agentB = createAgent(db, { name: "B", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
  const pool = new PiPool({
    factory: (o) => {
      const c = new FakeClient(o);
      clients.push(c);
      return c;
    },
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

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("message UI classic est persisté dans queue_item puis livré", async () => {
  const created = await post("/api/conversations", { agent_id: agentA });
  assert.equal(created.status, 201);
  const { conversation } = await created.json() as { conversation: { id: string } };
  const sent = await post(`/api/conversations/${conversation.id}/messages`, { text: "bonjour file" });
  assert.equal(sent.status, 200);
  const ack = await sent.json() as { ok: boolean };
  assert.equal(ack.ok, true);
  const lane = db.prepare("SELECT id FROM lane WHERE conversation_id = ?").get(conversation.id) as { id: string };
  assert.deepEqual(listItems(db, lane.id).map((i) => [i.body, i.status]), [["bonjour file", "done"]]);
  assert.equal(clients.at(-1)!.prompts.includes("bonjour file"), true);
});

test("team_send enfile vers une autre conversation", async () => {
  const a = await (await post("/api/conversations", { agent_id: agentA })).json() as { conversation: { id: string } };
  const b = await (await post("/api/conversations", { agent_id: agentB })).json() as { conversation: { id: string } };
  const res = await post("/api/team/send", {
    conversation_id: b.conversation.id,
    body: "relais",
    from_conversation_id: a.conversation.id,
    idempotency_key: "k-relais",
  });
  assert.equal(res.status, 200);
  const again = await post("/api/team/send", {
    conversation_id: b.conversation.id,
    body: "relais",
    idempotency_key: "k-relais",
  });
  const first = await res.json() as { created: boolean; queue_item_id: string };
  const second = await again.json() as { created: boolean; queue_item_id: string };
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.queue_item_id, first.queue_item_id);
});

test("team_send refuse un hop au-delà de la limite", async () => {
  const { conversation } = await (await post("/api/conversations", { agent_id: agentA })).json() as { conversation: { id: string } };
  const res = await post("/api/team/send", { conversation_id: conversation.id, body: "trop", hop: DEFAULT_HOP_LIMIT + 1 });
  assert.equal(res.status, 409);
  const body = await res.json() as { code: string };
  assert.equal(body.code, "hop_limit");
});
