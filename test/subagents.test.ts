import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
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

const { listSubagents, readSubagent, statusOfEntries, tasksDirFor, parentSessionIdOf, MAX_SUBAGENTS } = await import("../src/subagents.js");
const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool } = await import("../src/pool.js");
const { createConversation, setConversationSession } = await import("../src/conversations.js");

/** Session parente factice : en-tête seul, nom = celui que pi utilise en production. */
function makeParentSession(name: string, parentId: string): string {
  const file = join(home, "sessions", `${name}.jsonl`);
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: parentId, timestamp: "2026-10-29T10:00:00.000Z" }) + "\n");
  return file;
}

type ChildSpec = { id: string; parent?: string | null; label?: string | null; model?: string; last?: "toolCall" | "done" | "error"; mtime?: number };

/** Journal enfant conforme à ce que pi-subagents écrit (voir src/session/session-dir.ts). */
function writeChild(parentSession: string, spec: ChildSpec): string {
  const dir = tasksDirFor(parentSession);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${spec.id}.jsonl`);
  const lines: unknown[] = [{ type: "session", version: 3, id: spec.id, timestamp: "2026-10-29T10:01:00.000Z", cwd: home, parentSession: spec.parent === undefined ? parentSessionIdOf(parentSession) : spec.parent }];
  if (spec.model) lines.push({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-29T10:01:00.001Z", provider: "kimi-coding", modelId: spec.model });
  if (spec.label) lines.push({ type: "message", id: "u1", parentId: "m1", timestamp: "2026-10-29T10:01:01.000Z", message: { role: "user", content: [{ type: "text", text: spec.label }] } });
  const last = spec.last ?? "done";
  if (last === "toolCall") {
    lines.push({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-29T10:01:02.000Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { command: "sleep 30" } }] } });
  } else if (last === "error") {
    lines.push({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-29T10:01:02.000Z", message: { role: "assistant", stopReason: "error", content: [] } });
  } else {
    lines.push({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-29T10:01:02.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] } });
  }
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  if (spec.mtime) utimesSync(file, spec.mtime, spec.mtime);
  return file;
}

const SESSION_A = makeParentSession("parent-a", "01PARENT-A");
const SESSION_B = makeParentSession("parent-b", "01PARENT-B");

// ---------- Lecture du journal d'un enfant (pas de démon : la source est la session pi) ----------

test("tasksDirFor : répertoire des enfants dérivé du nom de la session parente", () => {
  assert.equal(tasksDirFor("/s/dir/2026-01-01T00-00-00-000Z_abc.jsonl"), "/s/dir/2026-01-01T00-00-00-000Z_abc/tasks");
});

test("statusOfEntries : appelle d'outil en attente → working ; message assistant clos → done", () => {
  const msg = (role: string, stopReason?: string) => ({ message: { role, stopReason } });
  assert.equal(statusOfEntries([msg("user"), msg("assistant", "toolUse")]), "working");
  assert.equal(statusOfEntries([msg("assistant", "toolUse"), msg("toolResult")]), "working"); // l'agent reprend après l'outil
  assert.equal(statusOfEntries([msg("assistant", "stop")]), "done");
  assert.equal(statusOfEntries([msg("assistant", "length")]), "done");
  assert.equal(statusOfEntries([msg("assistant", "error")]), "unknown");
  assert.equal(statusOfEntries([]), "unknown");
});

test("readSubagent : libellé = première consigne, modèle = model_change, statut du journal", () => {
  const file = writeChild(SESSION_A, { id: "child-live", label: "Sonde état subagent", model: "kd-1", last: "toolCall" });
  const view = readSubagent(file);
  assert.ok(view);
  assert.equal(view.id, "child-live");
  assert.equal(view.label, "Sonde état subagent");
  assert.equal(view.model, "kimi-coding/kd-1");
  assert.equal(view.status, "working");
  assert.equal(view.started_at, "2026-10-29T10:01:00.000Z");
});

test("readSubagent : enfant sans consigne ni modèle → label/model null, journal illisible → null", () => {
  const file = writeChild(SESSION_A, { id: "child-brut" });
  const view = readSubagent(file);
  assert.equal(view?.label, null);
  assert.equal(view?.model, null);
  assert.equal(view?.status, "done");
  assert.equal(readSubagent(join(home, "sessions", "parent-a", "tasks", "absent.jsonl")), null);
});

test("readSubagent : statut correct après un long préambule UTF-8 et une ligne corrompue", () => {
  const file = writeChild(SESSION_A, { id: "child-unicode", label: "Vérifier les accents", last: "toolCall" });
  appendFileSync(file, JSON.stringify({ type: "custom", data: "é🚀".repeat(100_000) }) + "\nnull\n");
  appendFileSync(file, JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } }) + "\n");
  const view = readSubagent(file);
  assert.equal(view?.label, "Vérifier les accents");
  assert.equal(view?.status, "done");
});

test("listSubagents : ignore les entrées non fichiers et les enfants sans lien parent vérifiable", () => {
  const parent = makeParentSession("parent-invalid-children", "PARENT-VALID");
  const dir = tasksDirFor(parent);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "directory.jsonl"));
  writeChild(parent, { id: "child-unlinked", parent: null });
  writeChild(parent, { id: "child-linked", label: "Consigne valide" });
  writeFileSync(join(dir, "corrupt.jsonl"), "null\n{\n");
  assert.deepEqual(listSubagents(parent).subagents.map((s) => s.id), ["child-linked"]);
});

test("listSubagents : en-tête parent corrompu → session indisponible, aucun enfant exposé", () => {
  const parent = makeParentSession("parent-corrupt", "PARENT-CORRUPT");
  writeChild(parent, { id: "child-hidden" });
  writeFileSync(parent, "null\n");
  assert.deepEqual(listSubagents(parent), { live: false, subagents: [] });
});

test("listSubagents : enfant inactif depuis > 1 h → statut unknown (process probablement tué)", () => {
  const old = Math.floor(Date.now() / 1000) - 7_200;
  writeChild(SESSION_A, { id: "child-vieux", last: "toolCall", mtime: old });
  const view = listSubagents(SESSION_A).subagents.find((s) => s.id === "child-vieux");
  assert.equal(view?.status, "unknown");
});

test("listSubagents : session inconnue → live:false ; pas de répertoire tasks → live:true et liste vide", () => {
  assert.deepEqual(listSubagents(null), { live: false, subagents: [] });
  assert.deepEqual(listSubagents(join(home, "sessions", "inexistante.jsonl")), { live: false, subagents: [] });
  assert.deepEqual(listSubagents(SESSION_B), { live: true, subagents: [] });
});

test("listSubagents : un enfant déclarant une autre session parente n'est jamais exposé", () => {
  const foreign = makeParentSession("parent-x", "01PARENT-X");
  writeChild(foreign, { id: "child-foreign", label: "autre conversation" });
  // répertoire recyclé : l'enfant est déposé chez A mais déclare X
  const dir = tasksDirFor(SESSION_A);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "child-recycle.jsonl"), JSON.stringify({ type: "session", id: "child-recycle", parentSession: "01PARENT-X" }) + "\n");
  const ids = listSubagents(SESSION_A).subagents.map((s) => s.id);
  assert.ok(!ids.includes("child-recycle"));
  assert.ok(!ids.includes("child-foreign"));
});

test("listSubagents : tri par récence et borne MAX_SUBAGENTS", () => {
  const parent = makeParentSession("parent-cap", "01PARENT-CAP");
  const base = Math.floor(Date.now() / 1000) - 600;
  for (let i = 0; i < MAX_SUBAGENTS + 5; i++) writeChild(parent, { id: `c${String(i).padStart(2, "0")}`, mtime: base + i });
  const subs = listSubagents(parent).subagents;
  assert.equal(subs.length, MAX_SUBAGENTS);
  assert.equal(subs[0]!.id, `c${String(MAX_SUBAGENTS + 4).padStart(2, "0")}`); // le plus récent d'abord
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

before(async () => {
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  const pool = new PiPool({ factory: (o) => new FakeClient(o) });
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: opened.version, paths: getPaths(), pool });
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
  return { status: res.status, body: await res.json() as { live: boolean; subagents: Array<{ id: string }> } };
};

test("route : 404 conversation inconnue", async () => {
  const res = await getSubagents("nexiste-pas");
  assert.equal(res.status, 404);
});

test("route : chaque conversation ne voit que ses propres sous-agents", async () => {
  const a = createConversation(db, { spawn: { provider: "openai", model: "gpt-5.4" } });
  setConversationSession(db, a.id, SESSION_A);
  const b = createConversation(db, { spawn: { provider: "openai", model: "gpt-5.4" } });
  setConversationSession(db, b.id, SESSION_B);
  writeChild(SESSION_B, { id: "child-b", label: "travail de B" });

  const ra = await getSubagents(a.id);
  assert.equal(ra.status, 200);
  assert.equal(ra.body.live, true);
  assert.ok(!ra.body.subagents.some((s) => s.id === "child-b")); // pas de fuite inter-conversations

  const rb = await getSubagents(b.id);
  assert.deepEqual(rb.body.subagents.map((s) => s.id), ["child-b"]);
});

test("route : conversation sans session pi → live:false, liste vide", async () => {
  const c = createConversation(db, { spawn: { provider: "openai", model: "gpt-5.4" } });
  const res = await getSubagents(c.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.live, false);
  assert.deepEqual(res.body.subagents, []);
});
