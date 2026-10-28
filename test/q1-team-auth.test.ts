/** team_send en mode auth : fetch anonyme refusé ; ownerRequest (socket privé) passe. */
import { FakeConfiguration } from "./fixtures/fake-configuration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { initializeOwner, loadAuth, lockHome } from "../src/auth-state.js";
import { openDb } from "../src/db.js";
import { getPaths } from "../src/paths.js";
import { PiPool } from "../src/pool.js";
import { createApp } from "../src/server.js";
import { createAgent } from "../src/agents.js";
import { listenOwnerSocket, ownerRequest } from "../src/owner-transport.js";
import { AUTH_TEST_TMP, closeServer, email, httpCall, origin, password } from "./native-auth-fixture.js";

class FakeClient {
  configuration = new FakeConfiguration(() => this.opts.args);
  private listeners = new Set<(e: unknown) => void>();
  constructor(readonly opts: { cwd: string; args: string[]; env?: Record<string, string> }) {}
  async start() {}
  async stop() {}
  onEvent(l: (e: unknown) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  sessionFile = `/fake/auth-${Math.random().toString(16).slice(2)}.jsonl`;
  async getState() { return { ...await this.configuration.getState(), sessionFile: this.sessionFile, isStreaming: false }; }
  async getAvailableModels() { return this.configuration.getAvailableModels(); }
  async getAvailableThinkingLevels() { return this.configuration.getAvailableThinkingLevels(); }
  async setThinkingLevel(level: Parameters<FakeConfiguration["setThinkingLevel"]>[0]) { return this.configuration.setThinkingLevel(level); }
  async prompt() {
    for (const l of this.listeners) l({ type: "agent_settled" });
    return { disposition: "started" };
  }
  async abort() {}
  async setModel(p: string, m: string) { return this.configuration.setModel(p, m); }
}

test("team_send avec opts.auth : HTTP public 401, ownerRequest OK", async () => {
  const home = mkdtempSync(join(AUTH_TEST_TMP, "cog-team-auth-"));
  const unlock = lockHome(home);
  let socket: Awaited<ReturnType<typeof listenOwnerSocket>> | undefined;
  let server: ReturnType<typeof createApp> | undefined;
  try {
    await initializeOwner(home, origin, email, password);
    const state = loadAuth(home);
    const paths = getPaths({ COGITATOR_HOME: home, COGITATOR_PI_AGENT_DIR: join(home, "pi"), COGITATOR_AGENTS_DIR: join(home, "agents"), COGITATOR_SKILLS_DIRS: join(home, "skills") });
    mkdirSync(join(home, "pi", "agents"), { recursive: true });
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "pi", "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));
    const { db, version } = openDb(paths.db);
    const agentA = createAgent(db, { name: "A", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
    const agentB = createAgent(db, { name: "B", provider: "openai", model: "gpt-5.4", system_prompt: "", skills: [], mcp_servers: [] }).id;
    const pool = new PiPool({ factory: (o) => new FakeClient(o) });
    const events = new EventEmitter();
    server = createApp({ db, dbPath: paths.db, dbVersion: version, paths, pool, events, auth: state });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    socket = await listenOwnerSocket(server, home);
    const env = { COGITATOR_HOME: home };
    const anon = await httpCall(port, "/api/team/send", "POST", { conversation_id: "x", body: "y" });
    assert.equal(anon.status, 401);
    const group = await ownerRequest<{ group: { members: Array<{ agent_id: string; conversation_id: string }> } }>(
      "POST",
      "/api/groups",
      { name: "Auth team", member_agent_ids: [agentA, agentB] },
      env,
    );
    const a = group.group.members.find((m) => m.agent_id === agentA)!.conversation_id;
    const b = group.group.members.find((m) => m.agent_id === agentB)!.conversation_id;
    const sent = await ownerRequest<{ ok: boolean }>("POST", "/api/team/send", {
      conversation_id: b,
      body: "via socket",
      from_conversation_id: a,
    }, env);
    assert.equal(sent.ok, true);
    state.db.close();
    db.close();
  } finally {
    if (socket) await closeServer(socket);
    if (server) {
      server.closeAllConnections();
      if (server.listening) await closeServer(server);
    }
    unlock();
    rmSync(home, { recursive: true, force: true });
  }
});
