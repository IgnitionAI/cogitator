import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

/** v1 volontairement incomplet : INSERT v1→v2 sélectionne `title`, absent ici. */
const BROKEN_V1 = `
CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  agent_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT,
  session_file TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

test("migration legacy : une erreur annule le schéma partiel (conversation_v2 n'existe pas, version inchangée)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-db-tx-"));
  const dbPath = join(dir, "cogitator.db");
  try {
    const raw = new Database(dbPath);
    raw.exec(BROKEN_V1);
    raw.prepare("INSERT INTO conversation (id, provider, model) VALUES ('c1', 'openai', 'gpt-4')").run();
    raw.pragma("user_version = 1");
    raw.close();

    assert.throws(() => openDb(dbPath));

    const after = new Database(dbPath, { readonly: true });
    try {
      assert.equal(after.pragma("user_version", { simple: true }), 1);
      const tables = after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_v2'").all();
      assert.deepEqual(tables, []);
      const row = after.prepare("SELECT id, provider, model FROM conversation").get() as { id: string };
      assert.equal(row.id, "c1");
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
