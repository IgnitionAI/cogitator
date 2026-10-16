import { FakeConfiguration } from "./fixtures/fake-configuration.js";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";

// S3 (Plan 0004) : création NL d'un bot via le Majordome → la home Bots doit se rafraîchir.
// Le Majordome crée le preset via l'outil MCP cogitator_create_agent (= POST /api/agents) ;
// l'UI s'appuie sur l'événement SSE global agents_changed pour lister le nouveau bot.

const home = mkdtempSync(join(tmpdir(), "cog-s3-"));
const piDir = join(home, "pi-agent");
mkdirSync(join(piDir, "agents"), { recursive: true });
mkdirSync(join(home, "skills"), { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = join(piDir, "agents");
process.env.COGITATOR_SKILLS_DIRS = join(home, "skills");
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));

const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool } = await import("../src/pool.js");
const { setConversationStatus } = await import("../src/conversations.js");

class FakeClient {
  configuration = new FakeConfiguration(() => this.opts.args);
  getAvailableModels() { return this.configuration.getAvailableModels(); }
  getAvailableThinkingLevels() { return this.configuration.getAvailableThinkingLevels(); }
  setThinkingLevel(level: Parameters<FakeConfiguration["setThinkingLevel"]>[0]) { return this.configuration.setThinkingLevel(level); }
  sessionFile = `/fake/sessions/${Math.random()}.jsonl`;
  constructor(public opts: { cwd: string; args: string[] }) {}
  async start() {}
  async stop() {}
  onEvent() { return () => {}; }
  async getState() { return { ...await this.configuration.getState(), sessionFile: this.sessionFile, isStreaming: false }; }
  async prompt() { return {}; }
  async abort() {}
  async setModel(provider: string, id: string) { return this.configuration.setModel(provider, id); }
}

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;
let sseCleanup: (() => void) | null = null;

/**
 * Abonne un flux SSE /api/events (via fetch streaming — node:http get ne déclenche
 * pas son callback sous tsx --test), exécute `action` une fois le listener côté
 * serveur effectif, et résout quand un événement du type demandé est reçu.
 * Renvoie le résultat de `action` (le statut/objet à assert-er).
 */
function withEvent<T>(type: string, action: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    let gotEvent = false;
    let gotAction = false;
    let settled = false;
    const finish = () => {
      if (settled || !gotEvent || !gotAction) return;
      settled = true;
      clearTimeout(timer);
      resolve(result as T);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => fail(new Error(`événement ${type} non reçu sous 5 s`)), 5_000);
    // Déclencher l'action sur un timer INDÉPENDANT de la résolution du fetch SSE :
    // le serveur ne flush les headers SSE qu'à la première écriture (l'événement lui-même),
    // donc attendre le fetch avant l'action serait un deadlock. Le listener côté serveur
    // est attaché dès l'arrivée de la requête, bien avant ce délai.
    setTimeout(() => {
      action().then((r) => { result = r; gotAction = true; finish(); }).catch(fail);
    }, 150);
    void (async () => {
      const res = await fetch(`${base}/api/events`);
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      const reader = res.body.getReader();
      sseCleanup = () => { void reader.cancel().catch(() => undefined); };
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buf += decoder.decode(value, { stream: true });
        const line = buf.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(6)) as { type?: string };
          if (ev.type === type) { gotEvent = true; void reader.cancel().catch(() => undefined); finish(); }
        } catch { /* heartbeat ou JSON partiel : ignorer */ }
      }
    })().catch(fail);
  });
}

before(async () => {
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  const pool = new PiPool({
    factory: (o) => new FakeClient(o),
    callbacks: { onStatus: (id, s) => setConversationStatus(db, id, s) },
  });
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: opened.version, paths: getPaths(), pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  sseCleanup?.();
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("POST /api/agents (création Majordome) émet agents_changed et liste le nouveau bot", async () => {
  const created = await withEvent("agents_changed", () => fetch(`${base}/api/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Veille RAG", provider: "openai", model: "gpt-5.4",
      description: "Veille quotidienne sur l'actualité RAG",
      system_prompt: "Tu collectes, tu filtres, tu biblionnes. Jamais de promotion sans source.",
      skills: [], mcp_servers: [],
    }),
  }));
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: { id: string; name: string } };

  const listed = await (await fetch(`${base}/api/agents`)).json() as {
    agents: Array<{ id: string; name: string }>;
  };
  assert.ok(listed.agents.some((a) => a.id === agent.id && a.name === "Veille RAG"));
});

test("DELETE /api/agents émet agents_changed", async () => {
  const created = await (await fetch(`${base}/api/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Éphémère", provider: "openai", model: "gpt-5.4", skills: [], mcp_servers: [] }),
  })).json() as { agent: { id: string } };
  const deleted = await withEvent("agents_changed", () => fetch(`${base}/api/agents/${created.agent.id}`, { method: "DELETE" }));
  assert.equal(deleted.status, 200);
});
