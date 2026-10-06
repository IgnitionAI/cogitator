import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "../src/server.js";
import { getPaths } from "../src/paths.js";
import { PiPool } from "../src/pool.js";

let home: string;
let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "cogitator-test-"));
  db = new Database(join(home, "cogitator.db"));
  db.exec(`
    CREATE TABLE agent_preset (id TEXT PRIMARY KEY);
    CREATE TABLE subagent_setup (id TEXT PRIMARY KEY);
    CREATE TABLE workspace (id TEXT PRIMARY KEY);
    CREATE TABLE conversation (id TEXT PRIMARY KEY);
    CREATE TABLE cron_task (id TEXT PRIMARY KEY);
    CREATE TABLE cron_run (id TEXT PRIMARY KEY);
  `);
  server = createApp({
    db,
    dbPath: join(home, "cogitator.db"),
    dbVersion: 2,
    paths: getPaths(),
    pool: new PiPool({ factory: () => ({ start: async () => {}, stop: async () => {}, onEvent: () => () => {}, getState: async () => ({}), prompt: async () => ({}), abort: async () => {}, setModel: async () => ({}) }) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("GET /api/health répond le contrat", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
  assert.ok("pi_version" in body);
  assert.equal(body.sessions_active, 0);
  assert.equal(body.db.version, 2);
  assert.equal(body.db.path, join(home, "cogitator.db"));
});

test("GET / sert le placeholder HTML", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /Cogitator/);
});

test("route API inconnue → 404 JSON", async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /not found/);
});
