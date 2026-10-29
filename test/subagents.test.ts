import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { FakeConfiguration } from "./fixtures/fake-configuration.js";

// Environnement injecté : jamais la vraie base ~/.cogitator.
const home = mkdtempSync(join(tmpdir(), "cog-subagents-"));
const piDir = join(home, "pi-agent");
mkdirSync(join(piDir, "agents"), { recursive: true });
mkdirSync(join(home, "skills"), { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = join(piDir, "agents");
process.env.COGITATOR_SKILLS_DIRS = join(home, "skills");
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));

const { subagentsForConversation, linkBelongsToConversation, listSubagents } = await import("../src/subagents.js");
const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool } = await import("../src/pool.js");
const { createConversation, setConversationSession } = await import("../src/conversations.js");

const SESSION_A = join(home, "sessions", "conv-a.json");
const SESSION_B = join(home, "sessions", "conv-b.json");

const pane = (over: Record<string, unknown>) => ({
  pane_id: "w1:p1",
  label: null,
  agent: null,
  agent_status: "working",
  agent_session: null,
  ...over,
});

// ---------- Mapping pur (snapshot factice — mock identifié, preuve live = spike plan 0006) ----------

test("linkBelongsToConversation : true seulement si agent_session.source == session_file", () => {
  const linked = pane({ agent_session: { source: SESSION_A, agent: "explore", kind: "path", value: "/x/herdr/child.json" } });
  assert.equal(linkBelongsToConversation(linked, SESSION_A), true);
  assert.equal(linkBelongsToConversation(linked, SESSION_B), false);
  assert.equal(linkBelongsToConversation(pane({}), SESSION_A), false); // sans agent_session
  assert.equal(linkBelongsToConversation(pane({ agent_session: { source: SESSION_B, agent: "a", kind: "id", value: "v" } }), SESSION_A), false);
});

test("subagentsForConversation : extrait les panes imbriqués, filtre par session, projette", () => {
  const snapshot = {
    workspaces: [{
      tabs: [{
        panes: [
          pane({ pane_id: "w1:p1", label: "explore-code", agent: "explore", agent_session: { source: SESSION_A, agent: "explore", kind: "path", value: "/x/herdr/child-1.json" } }),
          pane({ pane_id: "w1:p2", agent_session: { source: SESSION_B, agent: "general", kind: "path", value: "/x/herdr/child-2.json" }, agent_status: "blocked" }),
          pane({ pane_id: "w1:p3" }), // pas de session déclarée
        ],
      }],
    }],
  };
  const subs = subagentsForConversation(snapshot, SESSION_A);
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0], {
    pane_id: "w1:p1",
    label: "explore-code",
    agent: "explore",
    status: "working",
    session: "/x/herdr/child-1.json",
  });
  // statut absent → unknown ; aucun lien croisé vers l'autre session
  const subsB = subagentsForConversation(snapshot, SESSION_B);
  assert.equal(subsB.length, 1);
  assert.equal(subsB[0]!.status, "blocked");
});

test("subagentsForConversation : forme aplatie { panes: [...] } + dédoublonnage par pane_id", () => {
  const p = pane({ pane_id: "w1:p1", agent_session: { source: SESSION_A, agent: "a", kind: "id", value: "s1" } });
  const snapshot = { panes: [p], also: { panes: [p] } };
  assert.equal(subagentsForConversation(snapshot, SESSION_A).length, 1);
  assert.equal(subagentsForConversation(snapshot, SESSION_A)[0]!.session, "s1");
});

test("subagentsForConversation : snapshot sans pane → []", () => {
  assert.deepEqual(subagentsForConversation({}, SESSION_A), []);
  assert.deepEqual(subagentsForConversation(null, SESSION_A), []);
});

test("listSubagents : runner en échec → live:false ; session_file null → jamais de mapping", async () => {
  const failing = () => Promise.reject(new Error("no herdr server"));
  assert.deepEqual(await listSubagents(SESSION_A, failing), { live: false, subagents: [] });
  const ok = () => Promise.resolve(JSON.stringify({ panes: [] }));
  assert.deepEqual(await listSubagents(null, ok), { live: true, subagents: [] });
  // JSON invalide → live:false
  const bad = () => Promise.resolve("not json");
  assert.deepEqual(await listSubagents(SESSION_A, bad), { live: false, subagents: [] });
});

// ---------- Route GET /api/conversations/:id/subagents ----------

class FakeClient {
  configuration = new FakeConfiguration(() => this.opts.args);
  opts: { cwd: string; args: string[]; env?: Record<string, string> };
  constructor(opts: { cwd: string; args: string[]; env?: Record<string, string> }) { this.opts = opts; }
  async start() {}
  async stop() {}
  onEvent() { return () => {}; }
  async getState() { return { ...(await this.configuration.getState()), sessionFile: null, isStreaming: false }; }
  async prompt() { return {}; }
  async abort() {}
}

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;
const calls: string[][] = [];
const SNAPSHOT = {
  panes: [
    pane({ pane_id: "w1:p1", label: "explore", agent_session: { source: SESSION_A, agent: "explore", kind: "path", value: "/x/child-a.json" } }),
    pane({ pane_id: "w1:p2", agent_session: { source: SESSION_B, agent: "general", kind: "path", value: "/x/child-b.json" } }),
  ],
};

before(async () => {
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  const pool = new PiPool({ factory: (o) => new FakeClient(o) });
  server = createApp({
    db, dbPath: join(home, "cogitator.db"), dbVersion: opened.version, paths: getPaths(), pool,
    subagentRunner: (cmd, args) => { calls.push([cmd, ...args]); return Promise.resolve(JSON.stringify(SNAPSHOT)); },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const getSubagents = async (id: string) => {
  const res = await fetch(`${base}/api/conversations/${id}/subagents`);
  return { status: res.status, body: await res.json() as { live: boolean; subagents: Array<{ pane_id: string }> } };
};

test("route : 404 conversation inconnue", async () => {
  const res = await getSubagents("nexiste-pas");
  assert.equal(res.status, 404);
});

test("route : ne expose que les subagents liés à la session de cette conversation", async () => {
  const a = createConversation(db, { spawn: { provider: "openai", model: "gpt-5.4" } });
  setConversationSession(db, a.id, SESSION_A);
  const b = createConversation(db, { spawn: { provider: "openai", model: "gpt-5.4" } });
  setConversationSession(db, b.id, SESSION_B);

  const ra = await getSubagents(a.id);
  assert.equal(ra.status, 200);
  assert.equal(ra.body.live, true);
  assert.deepEqual(ra.body.subagents.map((s) => s.pane_id), ["w1:p1"]); // pas w1:p2 (session B)

  const rb = await getSubagents(b.id);
  assert.deepEqual(rb.body.subagents.map((s) => s.pane_id), ["w1:p2"]);

  assert.deepEqual(calls[0], ["herdr", "api", "snapshot"]); // contrat shell-out figé
});

test("route : conversation sans session_file → live selon herdr, liste vide", async () => {
  const c = createConversation(db, { spawn: { provider: "openai", model: "gpt-5.4" } });
  const res = await getSubagents(c.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.live, true);
  assert.deepEqual(res.body.subagents, []);
});
