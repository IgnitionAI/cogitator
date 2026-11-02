/** Issue #31 : les images d'un message voyagent avec l'item de file (queue_item.images, migration v10). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { PiPool } from "../src/pool.js";
import { cancelItem, enqueue, LaneDispatcher, listItems, recoverInterrupted, setLanePaused, submitToLane } from "../src/team-queue.js";

const IMAGES = [
  { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
];

interface PromptCall {
  conversationId: string;
  text: string;
  images: unknown[] | undefined;
}

function fakePool() {
  const prompts: PromptCall[] = [];
  const pool = new PiPool({
    factory: ({ args }) => {
      const conversationId = args[0]!;
      const listeners = new Set<(e: unknown) => void>();
      return {
        async start() {}, async stop() {}, async abort() {},
        onEvent(listener: (e: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async getState() { return { isStreaming: false }; },
        async getAvailableModels() { return []; }, async getAvailableThinkingLevels() { return []; },
        async setThinkingLevel() {}, async setModel() { return {}; },
        async prompt(text: string, images?: unknown[]) {
          prompts.push({ conversationId, text, images });
          setImmediate(() => { for (const listener of listeners) listener({ type: "agent_settled" }); });
          return { disposition: "started" };
        },
      } as never;
    },
  });
  return { pool, prompts };
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "cog-ign31-"));
  const { db, version } = openDb(join(dir, "c.db"));
  db.prepare("INSERT INTO conversation (id, provider, model) VALUES ('a', 'fake', 'fake')").run();
  return { db, version, dir };
}

/** Un hôte : sa propre instance de dispatcher, aucun état mémoire partagé avec les autres. */
function dispatcher(db: ReturnType<typeof freshDb>["db"], pool: PiPool, dir: string) {
  return new LaneDispatcher({ db, pool, ensure: (id) => pool.ensure(id, { cwd: dir, args: [id] }) });
}

test("migration : base neuve en v10, queue_item.images présente", () => {
  const { db, version, dir } = freshDb();
  assert.equal(version, 10);
  const columns = db.prepare("PRAGMA table_info(queue_item)").all() as Array<{ name: string }>;
  assert.ok(columns.some((c) => c.name === "images"));
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("migration v9 → v10 : ALTER TABLE sans perte d'un queue_item existant", () => {
  const { db, dir } = freshDb();
  const dbPath = join(dir, "c.db");
  const queued = enqueue(db, {
    conversationId: "a", body: "avant migration", chainId: "chaine", hop: 1, idempotencyKey: "k-mig",
  });
  // Reproduit l'état v9 : la colonne images n'existait pas encore.
  db.exec("ALTER TABLE queue_item DROP COLUMN images");
  db.pragma("user_version = 9");
  db.close();

  const migrated = openDb(dbPath);
  assert.equal(migrated.version, 10);
  const columns = migrated.db.prepare("PRAGMA table_info(queue_item)").all() as Array<{ name: string }>;
  assert.ok(columns.some((c) => c.name === "images"), "colonne ajoutée par la migration");
  const rows = migrated.db.prepare("SELECT * FROM queue_item").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, "l'item existant est conservé");
  assert.equal(rows[0]!.id, queued.id);
  assert.equal(rows[0]!.body, "avant migration");
  assert.equal(rows[0]!.chain_id, "chaine");
  assert.equal(rows[0]!.hop, 1);
  assert.equal(rows[0]!.status, "queued");
  assert.equal(rows[0]!.idempotency_key, "k-mig");
  assert.equal(rows[0]!.images, null, "pas d'images pour un item hérité");
  migrated.db.close(); rmSync(dir, { recursive: true, force: true });
});

test("redémarrage : un item en file avec 2 images les retrouve sur une nouvelle instance du dispatcher", async () => {
  const { db, dir } = freshDb();
  const { pool, prompts } = fakePool();
  // Hôte 1 : lane en pause → l'item reste `queued`, rien n'est livré.
  const before = dispatcher(db, pool, dir);
  const { laneId } = enqueue(db, { conversationId: "a", body: "regarde ces images", images: IMAGES });
  setLanePaused(db, laneId, true);
  await before.kick(laneId);
  assert.equal(prompts.length, 0);
  const stored = listItems(db, laneId)[0]!;
  assert.deepEqual(JSON.parse(stored.images!), IMAGES, "les images sont dans la ligne de file");

  // Hôte 2 (redémarrage) : nouvelle instance, même base, aucune Map mémoire héritée.
  const after = dispatcher(db, pool, dir);
  setLanePaused(db, laneId, false);
  await after.kick(laneId);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.text, "regarde ces images");
  assert.deepEqual(prompts[0]!.images, IMAGES, "les 2 images sont livrées après redémarrage");
  const done = listItems(db, laneId)[0]!;
  assert.equal(done.status, "done");
  assert.equal(done.images, null, "le JSON d'images est libéré une fois l'item terminé");
  await pool.dispose(); db.close(); rmSync(dir, { recursive: true, force: true });
});

test("attachImages (API de server.ts) écrit en base : une autre instance relit les images", async () => {
  const { db, dir } = freshDb();
  const { pool, prompts } = fakePool();
  const first = dispatcher(db, pool, dir);
  const { id, laneId } = enqueue(db, { conversationId: "a", body: "attach tardif" });
  first.attachImages(id, IMAGES);
  assert.deepEqual(JSON.parse(listItems(db, laneId)[0]!.images!), IMAGES, "attachImages persiste, pas de Map mémoire");

  const second = dispatcher(db, pool, dir);
  await second.kick(laneId);
  assert.deepEqual(prompts[0]!.images, IMAGES);
  await pool.dispose(); db.close(); rmSync(dir, { recursive: true, force: true });
});

test("submitToLane écrit les images avec l'item dès l'enqueue (lane occupée)", async () => {
  const { db, dir } = freshDb();
  const { pool, prompts } = fakePool();
  const d = dispatcher(db, pool, dir);
  const busy = enqueue(db, { conversationId: "a", body: "occupé" });
  setLanePaused(db, busy.laneId, true);
  const queued = await submitToLane(db, d, { conversationId: "a", body: "(image)", idempotencyKey: "k-img" }, IMAGES);
  assert.equal(prompts.length, 0, "lane en pause : rien livré");
  const row = listItems(db, queued.laneId).find((i) => i.id === queued.id)!;
  assert.equal(row.status, "queued");
  assert.deepEqual(JSON.parse(row.images!), IMAGES);
  await pool.dispose(); db.close(); rmSync(dir, { recursive: true, force: true });
});

test("item sans images : la livraison ne casse pas et passe `undefined` au prompt", async () => {
  const { db, dir } = freshDb();
  const { pool, prompts } = fakePool();
  const { laneId } = enqueue(db, { conversationId: "a", body: "texte seul" });
  assert.equal(listItems(db, laneId)[0]!.images, null);
  await dispatcher(db, pool, dir).kick(laneId);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.images, undefined);
  const done = listItems(db, laneId)[0]!;
  assert.equal(done.status, "done");
  assert.equal(done.images, null);
  await pool.dispose(); db.close(); rmSync(dir, { recursive: true, force: true });
});

test("item interrompu par un redémarrage : jamais rejoué, images libérées", () => {
  const { db, dir } = freshDb();
  const { laneId } = enqueue(db, { conversationId: "a", body: "en vol", images: IMAGES });
  db.prepare("UPDATE queue_item SET status = 'delivering' WHERE lane_id = ?").run(laneId);
  assert.equal(recoverInterrupted(db), 1);
  const item = listItems(db, laneId)[0]!;
  assert.equal(item.status, "interrupted");
  assert.equal(item.images, null, "pas d'images orphelines sur un item jamais rejoué");
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("item annulé ou échoué : le JSON d'images ne reste pas", async () => {
  const { db, dir } = freshDb();
  const { pool } = fakePool();
  const { laneId } = enqueue(db, { conversationId: "a", body: "à annuler", images: IMAGES });
  const queued = listItems(db, laneId)[0]!;
  assert.ok(queued.images, "images présentes tant que l'item est en file");
  cancelItem(db, queued.id);
  const cancelled = listItems(db, laneId)[0]!;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.images, null, "annulation : plus de JSON d'images");

  // Échec de livraison (spawn) : l'item passe failed et libère aussi ses images.
  const d = new LaneDispatcher({
    db,
    pool,
    ensure: async () => { throw new Error("spawn boom"); },
  });
  await assert.rejects(() => submitToLane(db, d, { conversationId: "a", body: "(image)" }, IMAGES), /spawn boom/);
  const failed = listItems(db, laneId).find((i) => i.status === "failed")!;
  assert.match(failed.error ?? "", /spawn boom/);
  assert.equal(failed.images, null, "échec : plus de JSON d'images");
  await pool.dispose(); db.close(); rmSync(dir, { recursive: true, force: true });
});
