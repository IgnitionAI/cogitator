import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";

/**
 * Une base déjà migrée en v9 (par 288b20ac) doit se rouvrir sans erreur, à l'identique :
 * `openDb` ne rejoue pas MIGRATE_V8_TO_V9 (garde `user_version < 9`) et les données
 * existantes restent intactes. C'était le risque du lot 2 : une base v9 rouverte par un
 * binaire qui ne connaît pas ce numéro de schéma.
 */
test("une base v9 se rouvre sans erreur (migration idempotente, données intactes)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-db-v9-"));
  const dbPath = join(dir, "cogitator.db");
  try {
    const first = openDb(dbPath);
    assert.equal(first.version, 9);
    first.db.prepare("INSERT INTO conversation (id, provider, model) VALUES ('c9', 'openai', 'gpt-4')").run();
    first.db.prepare("INSERT INTO lane (id, conversation_id, kind) VALUES ('l9', 'c9', 'chat')").run();
    first.db.prepare("INSERT INTO queue_item (id, lane_id, seq, body) VALUES ('q9', 'l9', 1, 'ping')").run();
    first.db.close();

    // Réouverture par un démarrage normal : rien à migrer, aucune erreur, aucune perte.
    const second = openDb(dbPath);
    assert.equal(second.version, 9);
    assert.equal(second.db.pragma("user_version", { simple: true }), 9);
    const rows = second.db.prepare("SELECT id, provider, model FROM conversation").all() as { id: string; provider: string; model: string }[];
    assert.deepEqual(rows, [{ id: "c9", provider: "openai", model: "gpt-4" }]);
    assert.equal((second.db.prepare("SELECT count(*) AS n FROM lane").get() as { n: number }).n, 1);
    assert.equal((second.db.prepare("SELECT count(*) AS n FROM queue_item").get() as { n: number }).n, 1);
    second.db.close();

    // Troisième ouverture : idempotence stable (aucune dérive de schéma).
    const third = openDb(dbPath);
    assert.equal(third.version, 9);
    assert.deepEqual(third.db.prepare("PRAGMA integrity_check").get(), { integrity_check: "ok" });
    third.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
