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
  static failConv = new Set<string>();
  static hold = new Map<string, { wait: Promise<void>; release: () => void }>();
  configuration = new FakeConfiguration(() => this.opts.args);
  getAvailableModels() { return this.configuration.getAvailableModels(); }
  getAvailableThinkingLevels() { return this.configuration.getAvailableThinkingLevels(); }
  setThinkingLevel(level: Parameters<FakeConfiguration["setThinkingLevel"]>[0]) { return this.configuration.setThinkingLevel(level); }
  prompts: string[] = [];
  private listeners = new Set<(e: unknown) => void>();
  constructor(readonly opts: { cwd: string; args: string[]; env?: Record<string, string> }) {}
  async start() {
    const id = this.opts.env?.COGITATOR_CONVERSATION_ID;
    if (id && FakeClient.failConv.has(id)) throw new Error("spawn boom");
  }
  async stop() {}
  onEvent(l: (e: unknown) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  sessionFile = `/fake/q1-${Math.random().toString(16).slice(2)}.jsonl`;
  async getState() { return { ...await this.configuration.getState(), sessionFile: this.sessionFile, isStreaming: false }; }
  async prompt(text: string) {
    this.prompts.push(text);
    const held = FakeClient.hold.get(text);
    if (held) await held.wait;
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

async function makeGroup(): Promise<{ a: string; b: string }> {
  const res = await post("/api/groups", { name: "Relais", member_agent_ids: [agentA, agentB] });
  assert.equal(res.status, 201);
  const { group } = await res.json() as { group: { members: Array<{ agent_id: string; conversation_id: string }> } };
  const a = group.members.find((m) => m.agent_id === agentA)!.conversation_id;
  const b = group.members.find((m) => m.agent_id === agentB)!.conversation_id;
  return { a, b };
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
  const items = listItems(db, lane.id);
  assert.deepEqual(items.map((i) => [i.body, i.status, i.from_agent_id]), [["bonjour file", "done", null]]);
  assert.equal(clients.at(-1)!.prompts.includes("bonjour file"), true);
});

test("team_send enfile vers une autre conversation du même groupe", async () => {
  const { a, b } = await makeGroup();
  const res = await post("/api/team/send", {
    conversation_id: b,
    body: "relais",
    from_conversation_id: a,
    idempotency_key: "k-relais",
  });
  assert.equal(res.status, 200);
  const first = await res.json() as { created: boolean; queue_item_id: string };
  const lane = db.prepare("SELECT id FROM lane WHERE conversation_id = ?").get(b) as { id: string };
  const item = listItems(db, lane.id).find((i) => i.id === first.queue_item_id)!;
  assert.equal(item.from_agent_id, agentA, "émetteur = agent de la conversation source, pas le destinataire");
  const again = await post("/api/team/send", {
    conversation_id: b,
    body: "relais",
    from_conversation_id: a,
    idempotency_key: "k-relais",
  });
  const second = await again.json() as { created: boolean; queue_item_id: string };
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.queue_item_id, first.queue_item_id);
});

test("team_send refuse un hop au-delà de la limite", async () => {
  const { a, b } = await makeGroup();
  const res = await post("/api/team/send", {
    conversation_id: b,
    body: "trop",
    from_conversation_id: a,
    hop: DEFAULT_HOP_LIMIT + 1,
  });
  assert.equal(res.status, 409);
  const body = await res.json() as { code: string };
  assert.equal(body.code, "hop_limit");
});

test("team_send refuse hors groupe commun", async () => {
  const { a } = await makeGroup();
  const other = await (await post("/api/conversations", { agent_id: agentB })).json() as { conversation: { id: string } };
  const res = await post("/api/team/send", { conversation_id: other.conversation.id, body: "nope", from_conversation_id: a });
  assert.equal(res.status, 403);
});

test("from_agent_id inconnu → 400", async () => {
  const { a, b } = await makeGroup();
  const res = await post("/api/team/send", {
    conversation_id: b,
    body: "x",
    from_conversation_id: a,
    from_agent_id: "no-such-agent",
  });
  assert.equal(res.status, 400);
});

test("hop:0 explicite pendant une livraison n'écrase pas le hop hérité", async () => {
  const { a, b } = await makeGroup();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  FakeClient.hold.set("HOLD", { wait, release });
  const holdReq = post(`/api/conversations/${a}/messages`, { text: "HOLD" });
  const deadline = Date.now() + 5_000;
  let delivering = false;
  while (Date.now() < deadline) {
    const row = db.prepare("SELECT status FROM queue_item WHERE body = 'HOLD' ORDER BY rowid DESC LIMIT 1").get() as { status: string } | undefined;
    if (row?.status === "delivering") { delivering = true; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(delivering, true);
  const res = await post("/api/team/send", {
    conversation_id: b,
    body: "bypass",
    from_conversation_id: a,
    hop: 0,
    chain_id: "forged-chain",
  });
  assert.equal(res.status, 200);
  const ack = await res.json() as { queue_item_id: string };
  const lane = db.prepare("SELECT id FROM lane WHERE conversation_id = ?").get(b) as { id: string };
  const item = listItems(db, lane.id).find((i) => i.id === ack.queue_item_id)!;
  assert.equal(item.hop, 1, "hop serveur = héritage+1, pas 0");
  const holdLane = db.prepare("SELECT id FROM lane WHERE conversation_id = ?").get(a) as { id: string };
  const holdItem = listItems(db, holdLane.id).find((i) => i.body === "HOLD")!;
  assert.equal(item.chain_id, holdItem.chain_id ?? holdItem.id, "la chaîne héritée l'emporte");
  release();
  const held = await holdReq;
  assert.equal(held.status, 200);
  FakeClient.hold.delete("HOLD");
});

test("erreur ensure/spawn sur un message UI n'est pas un 200 ok", async () => {
  const created = await post("/api/conversations", { agent_id: agentA });
  const { conversation } = await created.json() as { conversation: { id: string } };
  FakeClient.failConv.add(conversation.id);
  const sent = await post(`/api/conversations/${conversation.id}/messages`, { text: "boom" });
  FakeClient.failConv.delete(conversation.id);
  assert.notEqual(sent.status, 200);
});
