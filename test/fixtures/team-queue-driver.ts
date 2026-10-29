/**
 * Driver enfant pour le test kill -9 des files durables (prototype Q1).
 * seed   : ouvre la base, met 2 éléments en file, commence la livraison du 1er
 *          (le faux agent ne termine jamais), signale `delivering` au parent → SIGKILL.
 * reopen : rouvre la base, recoverInterrupted, relance la lane, renvoie l'état.
 */
import { openDb } from "../../src/db.js";
import { PiPool } from "../../src/pool.js";
import { enqueue, LaneDispatcher, listItems, recoverInterrupted } from "../../src/team-queue.js";

const [, , dbPath, phase] = process.argv;
const prompts: string[] = [];

class FakeClient {
  private listeners = new Set<(e: unknown) => void>();
  async start() {}
  async stop() {}
  onEvent(l: (e: unknown) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  async getState() { return { sessionFile: "/fake/s.jsonl", isStreaming: false }; }
  async getAvailableModels() { return []; }
  async getAvailableThinkingLevels() { return []; }
  async setThinkingLevel() {}
  async setModel() { return {}; }
  async abort() {}
  async prompt(text: string) {
    prompts.push(text);
    if (text === "hang") {
      // Livraison en cours : le parent tue ce process ici.
      process.send?.({ point: "delivering", pid: process.pid });
      return { disposition: "started" };
    }
    queueMicrotask(() => { for (const l of this.listeners) l({ type: "agent_settled" }); });
    return { disposition: "started" };
  }
}

const { db } = openDb(dbPath!);
const pool = new PiPool({ factory: () => new FakeClient() as never });
const dispatcher = new LaneDispatcher({ db, pool, ensure: (id) => pool.ensure(id, { cwd: process.cwd(), args: [] }) });

if (phase === "seed") {
  db.prepare("INSERT INTO conversation (id, provider, model) VALUES ('c1', 'fake', 'fake')").run();
  const first = enqueue(db, { conversationId: "c1", body: "hang", idempotencyKey: "k-hang" });
  enqueue(db, { conversationId: "c1", body: "after", idempotencyKey: "k-after" });
  void dispatcher.kick(first.laneId);
  setInterval(() => {}, 1000); // reste vivant jusqu'au SIGKILL
} else {
  const recovered = recoverInterrupted(db);
  const lane = (db.prepare("SELECT id FROM lane WHERE conversation_id = 'c1'").get() as { id: string }).id;
  await dispatcher.kick(lane);
  process.send?.({ recovered, prompts, items: listItems(db, lane).map(i => ({ body: i.body, status: i.status, error: i.error })) });
  db.close();
  process.exit(0);
}
