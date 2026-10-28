/** Prototype Q1 pi-openbot : migration v9 (lane, queue_item) + files durables, sans modifier pool.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { PiPool } from "../src/pool.js";
import { enqueue, LaneDispatcher, listItems, QueueError, setLanePaused, cancelItem, DEFAULT_HOP_LIMIT } from "../src/team-queue.js";

const DRIVER = join(import.meta.dirname, "fixtures", "team-queue-driver.ts");

type Hook = (convId: string, text: string) => void;
function fakePool(hook: Hook = () => {}) {
  const prompts: Array<[string, string]> = [];
  const pool = new PiPool({
    factory: ({ args }) => {
      const convId = args[0]!;
      const listeners = new Set<(e: unknown) => void>();
      return {
        async start() {}, async stop() {}, async abort() {},
        onEvent(l: (e: unknown) => void) { listeners.add(l); return () => listeners.delete(l); },
        async getState() { return { isStreaming: false }; },
        async getAvailableModels() { return []; }, async getAvailableThinkingLevels() { return []; },
        async setThinkingLevel() {}, async setModel() { return {}; },
        async prompt(text: string) {
          prompts.push([convId, text]);
          setImmediate(() => { hook(convId, text); for (const l of listeners) l({ type: "agent_settled" }); });
          return { disposition: "started" };
        },
      } as never;
    },
  });
  return { pool, prompts };
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "cog-q1-"));
  const { db, version } = openDb(join(dir, "c.db"));
  for (const id of ["a", "b"]) db.prepare("INSERT INTO conversation (id, provider, model) VALUES (?, 'fake', 'fake')").run(id);
  return { db, version, dir };
}

test("v9 : base neuve et migration v8 → v9 conservent les données", () => {
  const { db, version, dir } = freshDb();
  assert.equal(version, 9);
  db.close();
  const raw = new Database(join(dir, "c.db"));
  raw.exec("DROP TABLE queue_item; DROP TABLE lane;");
  raw.pragma("user_version = 8");
  raw.close();
  const again = openDb(join(dir, "c.db"));
  assert.equal(again.version, 9);
  assert.equal((again.db.prepare("SELECT COUNT(*) n FROM conversation").get() as { n: number }).n, 2);
  assert.ok(again.db.prepare("SELECT name FROM sqlite_master WHERE name='queue_item'").get());
  again.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("(a) 3 messages en file livrés dans l'ordre, un par un ; pause / reprise / annulation", async () => {
  const { db, dir } = freshDb();
  const { pool, prompts } = fakePool();
  const d = new LaneDispatcher({ db, pool, ensure: (id) => pool.ensure(id, { cwd: dir, args: [id] }) });
  const { laneId } = enqueue(db, { conversationId: "a", body: "m1" });
  setLanePaused(db, laneId, true);
  enqueue(db, { conversationId: "a", body: "m2" });
  const x = enqueue(db, { conversationId: "a", body: "x" });
  enqueue(db, { conversationId: "a", body: "m3" });
  cancelItem(db, x.id);
  await d.kick(laneId);
  assert.deepEqual(prompts, [], "lane en pause : rien livré");
  setLanePaused(db, laneId, false);
  await d.kick(laneId);
  assert.deepEqual(prompts.map(p => p[1]), ["m1", "m2", "m3"]);
  assert.deepEqual(listItems(db, laneId).map(i => i.status), ["done", "done", "cancelled", "done"]);
  await pool.dispose(); db.close(); rmSync(dir, { recursive: true, force: true });
});

test("(b) kill -9 de l'hôte pendant une livraison → interrupted, pas rejoué, la suite est livrée", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-q1-kill-"));
  const dbPath = join(dir, "c.db");
  const run = (phase: "seed" | "reopen") => new Promise<{ msg: unknown; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = fork(DRIVER, [dbPath, phase], { execArgv: ["--import", "tsx"], silent: true, env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir } });
    let msg: unknown; let stderr = "";
    child.stderr?.on("data", c => { stderr += String(c); });
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout ${phase}: ${stderr}`)); }, 30_000);
    child.on("message", m => { msg = m; if (phase === "seed") child.kill("SIGKILL"); });
    child.on("close", (code, signal) => { clearTimeout(t); resolve({ msg, code, signal }); });
  });
  const seed = await run("seed");
  console.log("seed:", JSON.stringify(seed));
  assert.equal(seed.signal, "SIGKILL");
  assert.equal((seed.msg as { point: string }).point, "delivering");
  const reopen = await run("reopen");
  console.log("reopen:", JSON.stringify(reopen));
  assert.equal(reopen.code, 0);
  const r = reopen.msg as { recovered: number; prompts: string[]; items: Array<{ body: string; status: string }> };
  assert.equal(r.recovered, 1);
  assert.deepEqual(r.prompts, ["after"], "l'élément interrompu n'est pas rejoué");
  assert.deepEqual(r.items.map(i => [i.body, i.status]), [["hang", "interrupted"], ["after", "done"]]);
  rmSync(dir, { recursive: true, force: true });
});

test("(c) deux agents qui se répondent sans fin s'arrêtent à la limite de sauts", async () => {
  const { db, dir } = freshDb();
  let refused = 0;
  let d!: LaneDispatcher;
  const lanes = new Map<string, string>();
  const { pool, prompts } = fakePool((convId) => {
    // Outil team_send simulé : l'agent répond toujours à l'autre, hop + 1.
    const cur = d.currentItem(convId)!;
    const to = convId === "a" ? "b" : "a";
    try {
      const { laneId } = enqueue(db, { conversationId: to, body: `ping hop ${cur.hop + 1}`, chainId: cur.chain_id, hop: cur.hop + 1 });
      lanes.set(to, laneId);
      setImmediate(() => void d.kick(laneId));
    } catch (e) { if (e instanceof QueueError && e.code === "hop_limit") refused++; else throw e; }
  });
  d = new LaneDispatcher({ db, pool, ensure: (id) => pool.ensure(id, { cwd: dir, args: [id] }) });
  const { laneId } = enqueue(db, { conversationId: "a", body: "start", chainId: "chain-1", hop: 0 });
  await d.kick(laneId);
  const deadline = Date.now() + 5_000;
  while (refused === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(refused, 1);
  assert.equal(prompts.length, DEFAULT_HOP_LIMIT + 1, "hop 0..limite livrés, puis refus");
  await pool.dispose(); db.close(); rmSync(dir, { recursive: true, force: true });
});

test("(d) même idempotency_key envoyée deux fois → un seul élément", () => {
  const { db, dir } = freshDb();
  const one = enqueue(db, { conversationId: "a", body: "x", idempotencyKey: "k1" });
  const two = enqueue(db, { conversationId: "a", body: "x", idempotencyKey: "k1" });
  assert.equal(one.created, true);
  assert.equal(two.created, false);
  assert.equal(two.id, one.id);
  assert.equal(listItems(db, one.laneId).length, 1);
  db.close(); rmSync(dir, { recursive: true, force: true });
});
