import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, type Db } from "../src/db.js";

/**
 * Une base v9 **réellement existante** — schéma d'avant #31, donc `queue_item` sans colonne
 * `images` — doit se rouvrir sans erreur, être migrée en v10 et conserver ses données.
 *
 * L'intention d'origine (#32) est conservée : une base déjà à son numéro de schéma ne rejoue
 * pas les migrations antérieures et reste lisible. Depuis #31 (migration v9 → v10) on vérifie
 * en plus que la migration s'applique vraiment : `user_version` passe à 10, `queue_item.images`
 * est ajoutée et vaut NULL sur la ligne existante, puis deux réouvertures de plus sont stables.
 *
 * Le schéma ci-dessous est celui de `src/db.ts` **avant** la v10 : c'est indispensable, car une
 * base neuve créée par `openDb` contient déjà `images` dans le `CREATE TABLE queue_item` de
 * MIGRATE_V8_TO_V9, ce qui court-circuiterait `migrateV9ToV10` et rendrait le test creux.
 */
const SCHEMA_V9 = `
-- Tables parentes des clés étrangères, réduites à leur clé : SQLite (foreign_keys = ON)
-- refuse une insertion si la table référencée n'existe pas, même quand la colonne est NULL.
CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS agent_preset (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS agent_group (id TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent_preset(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT,
  session_file TEXT UNIQUE,
  spawn_args TEXT NOT NULL DEFAULT '{}',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  group_id TEXT REFERENCES agent_group(id) ON DELETE CASCADE,
  runtime_kind TEXT NOT NULL DEFAULT 'classic',
  pending_configuration TEXT
);
CREATE TABLE IF NOT EXISTS lane (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'chat',
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conversation_id, kind)
);
CREATE TABLE IF NOT EXISTS queue_item (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  from_agent_id TEXT REFERENCES agent_preset(id) ON DELETE SET NULL,
  chain_id TEXT,
  hop INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','delivering','done','failed','interrupted','cancelled')),
  idempotency_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (lane_id, seq),
  UNIQUE (lane_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_queue_item_lane_status ON queue_item(lane_id, status, seq);
`;

/** Colonnes de `queue_item` en v9 : tout sauf `images` (ajoutée par la migration v10). */
const V9_QUEUE_ITEM_COLUMNS = [
  "id",
  "lane_id",
  "seq",
  "body",
  "from_agent_id",
  "chain_id",
  "hop",
  "status",
  "idempotency_key",
  "error",
  "created_at",
  "started_at",
  "finished_at",
];

function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

/** Fabrique une base v9 telle que la laissait le schéma d'avant #31, avec trois lignes. */
function buildV9Db(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(SCHEMA_V9);
    // Garde-fou du fixture : si le schéma v9 embarquait déjà `images`, le test ne prouverait rien.
    assert.deepEqual(columnNames(db, "queue_item"), V9_QUEUE_ITEM_COLUMNS);

    db.prepare(
      "INSERT INTO conversation (id, provider, model, title, runtime_kind) VALUES ('c9', 'openai', 'gpt-4', 'avant v10', 'durable')",
    ).run();
    db.prepare("INSERT INTO lane (id, conversation_id, kind, paused) VALUES ('l9', 'c9', 'chat', 1)").run();
    db.prepare(
      `INSERT INTO queue_item (id, lane_id, seq, body, hop, status, idempotency_key, started_at, finished_at)
       VALUES ('q9', 'l9', 1, 'ping', 2, 'done', 'k9', '2026-01-01 00:00:00', '2026-01-01 00:00:01')`,
    ).run();
    db.pragma("user_version = 9");
    assert.equal(db.pragma("user_version", { simple: true }), 9);
  } finally {
    db.close();
  }
}

test("une base v9 existante est migrée en v10 à la réouverture (images NULL, données intactes, idempotent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-db-v9-"));
  const dbPath = join(dir, "cogitator.db");
  try {
    // 1. Base v9 construite à la main : `queue_item` sans `images`, données déjà présentes.
    buildV9Db(dbPath);

    // 2. Première réouverture par un démarrage normal : la migration v9 → v10 doit s'appliquer.
    const migrated = openDb(dbPath);
    assert.equal(migrated.version, 10);
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 10);
    assert.deepEqual(columnNames(migrated.db, "queue_item"), [...V9_QUEUE_ITEM_COLUMNS, "images"]);

    // La ligne existante a survécu, ses nouvelles `images` sont NULL (aucune image perdue/ajoutée).
    const item = migrated.db
      .prepare("SELECT id, lane_id, seq, body, hop, status, idempotency_key, started_at, finished_at, images FROM queue_item")
      .get() as Record<string, unknown>;
    assert.deepEqual(item, {
      id: "q9",
      lane_id: "l9",
      seq: 1,
      body: "ping",
      hop: 2,
      status: "done",
      idempotency_key: "k9",
      started_at: "2026-01-01 00:00:00",
      finished_at: "2026-01-01 00:00:01",
      images: null,
    });
    assert.deepEqual(migrated.db.prepare("SELECT id, provider, model, title, runtime_kind FROM conversation").all(), [
      { id: "c9", provider: "openai", model: "gpt-4", title: "avant v10", runtime_kind: "durable" },
    ]);
    assert.deepEqual(migrated.db.prepare("SELECT id, conversation_id, kind, paused FROM lane").all(), [
      { id: "l9", conversation_id: "c9", kind: "chat", paused: 1 },
    ]);
    const migratedSchema = columnNames(migrated.db, "queue_item");
    migrated.db.close();

    // 3. Idempotence : une deuxième ouverture ne rejoue rien et ne dérive pas le schéma.
    const second = openDb(dbPath);
    assert.equal(second.version, 10);
    assert.equal(second.db.pragma("user_version", { simple: true }), 10);
    assert.deepEqual(columnNames(second.db, "queue_item"), migratedSchema);
    assert.equal((second.db.prepare("SELECT count(*) AS n FROM queue_item").get() as { n: number }).n, 1);
    second.db.close();

    // 4. Troisième ouverture : même version, même schéma, base saine, données toujours là.
    const third = openDb(dbPath);
    assert.equal(third.version, 10);
    assert.deepEqual(columnNames(third.db, "queue_item"), migratedSchema);
    assert.deepEqual(third.db.prepare("PRAGMA integrity_check").get(), { integrity_check: "ok" });
    assert.deepEqual(third.db.prepare("SELECT id, images FROM queue_item").all(), [{ id: "q9", images: null }]);
    assert.equal((third.db.prepare("SELECT count(*) AS n FROM conversation").get() as { n: number }).n, 1);
    assert.equal((third.db.prepare("SELECT count(*) AS n FROM lane").get() as { n: number }).n, 1);
    third.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
