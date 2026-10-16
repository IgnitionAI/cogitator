import assert from "node:assert/strict";
import { test } from "node:test";
import { PiPool, type PiClientLike } from "../src/pool.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

class Client implements PiClientLike {
  state = { model: { provider: "p", id: "old" }, thinkingLevel: "low" as ThinkingLevel, isStreaming: false };
  calls: string[] = [];
  listeners = new Set<(event: unknown) => void>();
  async start() {} async stop() { this.calls.push("stop"); }
  onEvent(cb: (event: unknown) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit(type: string) { for (const cb of this.listeners) cb({ type }); }
  async getState() { return this.state; }
  async getAvailableModels() { return [{ provider: "p", id: "old" }, { provider: "p", id: "new" }]; }
  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> { return ["off", "low", "high"]; }
  async setThinkingLevel(level: ThinkingLevel) { this.state.thinkingLevel = level; }
  async setModel(provider: string, id: string) { this.calls.push(id); this.state.model = { provider, id }; }
  async prompt(text: string) { this.calls.push(text); this.state.isStreaming = true; this.emit("agent_start"); return { disposition: "started" }; }
  async abort() { this.state.isStreaming = false; this.emit("agent_settled"); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test("configuration waits for true settled and precedes retained follow-up", async () => {
  const client = new Client();
  const pool = new PiPool({ factory: () => client });
  await pool.ensure("c", { cwd: "/tmp", args: [] });
  await pool.prompt("c", "first");
  assert.equal(await pool.configure("c", async () => { await client.setModel("p", "new"); }), false);
  await pool.prompt("c", "second");
  client.state.isStreaming = false;
  client.emit("agent_end");
  await tick();
  assert.deepEqual(client.calls, ["first"]);
  client.emit("agent_settled");
  await tick();
  assert.deepEqual(client.calls, ["first", "new", "second"]);
  await pool.dispose();
});

import { openDb } from "../src/db.js";
import { createConversation, getConversation } from "../src/conversations.js";
import { changeConfiguration } from "../src/classic-configuration.js";
import { getPaths } from "../src/paths.js";
test("atomic tuple commit preserves snapshot and authoritative reasoning", async () => {
  const { db } = openDb(":memory:");
  const client = new Client();
  const pool = new PiPool({ factory: () => client });
  const conv = createConversation(db, { spawn: { provider: "p", model: "old", thinking: "low", systemPrompt: "keep" } });
  await pool.ensure(conv.id, { cwd: "/tmp", args: [] });
  const result = await changeConfiguration({ db, pool, paths: getPaths(), ensure: async () => ({}) }, conv.id, { provider: "p", id: "new", thinking: "high" });
  assert.equal(result.status, 200);
  const actual = getConversation(db, conv.id)!;
  assert.equal(actual.model, "new"); assert.equal(actual.thinking, "high");
  assert.equal(JSON.parse(actual.spawn_args).systemPrompt, "keep");
  assert.equal(actual.pending_configuration, null);
  await pool.dispose(); db.close();
});

import { dismissConfiguration, recoverConfigurations, reconcileConfiguration } from "../src/classic-configuration.js";
import { requestAuthorization } from "../src/request-authorization.js";
function fixture(client = new Client()) {
  const { db } = openDb(":memory:");
  const pool = new PiPool({ factory: () => client });
  const conv = createConversation(db, { spawn: { provider: "p", model: "old", thinking: "low", tools: ["read"] } });
  const deps = { db, pool, paths: getPaths(), ensure: async () => pool.ensure(conv.id, { cwd: "/tmp", args: [], initialize: c => reconcileConfiguration(db, pool, conv.id, c) }) };
  return { ...deps, deps, conv, client, close: async () => { await pool.dispose(); db.close(); } };
}

test("unsupported reasoning rolls back model, persists failure and supports dismiss/retry", async () => {
  const f = fixture();
  try {
    await assert.rejects(changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new", thinking: "max" }), /unsupported thinking/);
    assert.equal(f.client.state.model.id, "old");
    assert.equal(getConversation(f.db, f.conv.id)!.pending_configuration?.status, "failed");
    assert.equal(dismissConfiguration(f.db, f.pool, f.conv.id).pending_configuration, null);
    await changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new" });
    assert.equal(getConversation(f.db, f.conv.id)!.thinking, "low");
  } finally { await f.close(); }
});

test("pending survives reads, rejects competitors and uses originating authorization at settlement", async () => {
  const f = fixture(); let allowed = true;
  try {
    await f.deps.ensure();
    await f.pool.prompt(f.conv.id, "first");
    const result = await requestAuthorization.run(() => { if (!allowed) throw new Error("revoked"); }, () => changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new" }));
    assert.equal(result.status, 202);
    assert.equal(result.conversation.model, "old");
    assert.equal(result.conversation.pending_configuration?.model, "new");
    await assert.rejects(changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "old" }), /outstanding/);
    allowed = false;
    f.client.state.isStreaming = false; f.client.emit("agent_settled"); await tick();
    assert.equal(getConversation(f.db, f.conv.id)!.pending_configuration?.status, "failed");
    assert.match(getConversation(f.db, f.conv.id)!.pending_configuration!.error!, /revoked/);
    assert.equal(f.client.state.model.id, "old");
  } finally { await f.close(); }
});

test("rollback failure quarantines client and clears retained prompts", async () => {
  class BrokenRollback extends Client {
    changed = false;
    override async setModel(provider: string, id: string) {
      if (this.changed && id === "old") throw new Error("rollback failed");
      await super.setModel(provider, id); this.changed = true;
    }
  }
  const f = fixture(new BrokenRollback());
  try {
    await f.deps.ensure(); await f.pool.prompt(f.conv.id, "first");
    await changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new", thinking: "max" });
    await f.pool.prompt(f.conv.id, "never dispatch");
    f.client.state.isStreaming = false; f.client.emit("agent_settled"); await tick();
    assert.equal(f.pool.isLive(f.conv.id), false);
    assert(!f.client.calls.includes("never dispatch"));
    assert(f.client.calls.includes("stop"));
    assert.equal(getConversation(f.db, f.conv.id)!.model, "old");
  } finally { await f.close(); }
});

test("DB commit failure restores verified previous runtime", async () => {
  const f = fixture();
  try {
    await f.deps.ensure();
    f.db.exec("CREATE TRIGGER fail_configuration BEFORE UPDATE OF model ON conversation WHEN NEW.model = 'new' BEGIN SELECT RAISE(FAIL, 'disk failure'); END");
    await assert.rejects(changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new" }), /disk failure/);
    assert.equal(f.client.state.model.id, "old");
    assert.equal(getConversation(f.db, f.conv.id)!.model, "old");
    assert.equal(getConversation(f.db, f.conv.id)!.pending_configuration?.status, "failed");
  } finally { await f.close(); }
});

test("resume reconciles committed tuple; restart keeps pending visible but requires renewed authorization", async () => {
  const f = fixture();
  try {
    f.client.state.model.id = "new";
    await f.deps.ensure();
    assert.equal(f.client.state.model.id, "old");
    await f.pool.prompt(f.conv.id, "first");
    await changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new" });
    recoverConfigurations(f.db);
    assert.equal(getConversation(f.db, f.conv.id)!.pending_configuration?.status, "failed");
    assert.match(getConversation(f.db, f.conv.id)!.pending_configuration!.error!, /restarted/);
  } finally { await f.close(); }
});

test("Durable rejects with zero mutation or spawn", async () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE conversation SET runtime_kind = 'durable' WHERE id = ?").run(f.conv.id);
    await assert.rejects(changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new" }), /Durable/);
    assert.equal(f.pool.size, 0); assert.deepEqual(f.client.calls, []);
    assert.equal(getConversation(f.db, f.conv.id)!.pending_configuration, null);
  } finally { await f.close(); }
});

test("parallel startup respects pool capacity and same-conversation startup is unique", async () => {
  let created = 0;
  const pool = new PiPool({ max: 1, factory: () => { created++; return new Client(); } });
  try {
    const results = await Promise.allSettled([pool.ensure("a", { cwd: "/tmp", args: [] }), pool.ensure("b", { cwd: "/tmp", args: [] })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(created, 1);
    await Promise.all([pool.ensure("a", { cwd: "/tmp", args: [] }), pool.ensure("a", { cwd: "/tmp", args: [] })]);
    assert.equal(created, 1);
  } finally { await pool.dispose(); }
});

test("settled before prompt acknowledgment cannot apply configuration before acceptance", async () => {
  let release!: () => void;
  const acceptance = new Promise<void>(resolve => { release = resolve; });
  class SlowAcceptance extends Client {
    override async prompt(text: string) {
      this.calls.push(text); this.emit("agent_start"); this.emit("agent_settled");
      await acceptance;
      this.calls.push("accepted");
      return { disposition: "started" };
    }
  }
  const f = fixture(new SlowAcceptance());
  try {
    await f.deps.ensure();
    const first = f.pool.prompt(f.conv.id, "first");
    await tick();
    const change = changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new" });
    await tick(); assert.deepEqual(f.client.calls, ["first"]);
    release(); await first; await change;
    assert.deepEqual(f.client.calls, ["first", "accepted", "new"]);
  } finally { release(); await f.close(); }
});

test("queued prompt retains its own authorization, and stop reports cleared messages", async () => {
  const f = fixture(); let allowed = true; const events: unknown[] = [];
  f.pool.onEvent((_id, event) => events.push(event));
  try {
    await f.deps.ensure(); await f.pool.prompt(f.conv.id, "first");
    await requestAuthorization.run(() => { if (!allowed) throw new Error("prompt revoked"); }, () => f.pool.prompt(f.conv.id, "forbidden"));
    allowed = false; f.client.state.isStreaming = false; f.client.emit("agent_settled"); await tick();
    assert(!f.client.calls.includes("forbidden"));
    assert(events.some(event => (event as { type: string }).type === "queue_error"));
    await f.pool.prompt(f.conv.id, "again"); await f.pool.prompt(f.conv.id, "cleared");
    await f.pool.abort(f.conv.id); await tick();
    assert(!f.client.calls.includes("cleared"));
    assert(events.some(event => (event as { type: string }).type === "queue_cleared"));
  } finally { await f.close(); }
});

test("authorization loss after setter rolls runtime back before exposing failure", async () => {
  let allowed = true;
  class RevokingClient extends Client {
    override async setModel(provider: string, id: string) { await super.setModel(provider, id); allowed = false; }
  }
  const f = fixture(new RevokingClient());
  try {
    await f.deps.ensure();
    await assert.rejects(requestAuthorization.run(() => { if (!allowed) throw new Error("revoked during RPC"); }, () => changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new" })), /revoked/);
    assert.equal(f.client.state.model.id, "old");
    assert.equal(getConversation(f.db, f.conv.id)!.model, "old");
  } finally { await f.close(); }
});

import { createAgent, getAgent } from "../src/agents.js";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("preset scope changes only linked defaults and current conversation, and runs Apply", async () => {
  const f = fixture(); const home = mkdtempSync(join(tmpdir(), "cog-config-"));
  f.deps.paths = getPaths({ COGITATOR_HOME: home, COGITATOR_PI_AGENT_DIR: join(home, "pi"), COGITATOR_AGENTS_DIR: join(home, "agents") });
  try {
    const preset = createAgent(f.db, { name: "bot", provider: "p", model: "old", thinking: "low", system_prompt: "keep", subagents: [{ name: "child", provider: "p", model: "old", system_prompt: "child instructions" }] });
    f.db.prepare("UPDATE conversation SET agent_id = ? WHERE id = ?").run(preset.id, f.conv.id);
    const sibling = createConversation(f.db, { agentId: preset.id, spawn: { provider: "p", model: "old", thinking: "low" } });
    await changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new", thinking: "high" });
    assert.equal(getAgent(f.db, preset.id)!.model, "old");
    await changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new", thinking: "high", scope: "preset" });
    const actual = getAgent(f.db, preset.id)!;
    assert.equal(actual.model, "new"); assert.equal(actual.thinking, "high");
    assert.equal(actual.system_prompt, "keep"); assert.deepEqual(actual.subagents, preset.subagents);
    assert.equal(getConversation(f.db, sibling.id)!.model, "old");
    assert.equal(readdirSync(f.deps.paths.piAgentsDir).length, 1);
  } finally { await f.close(); rmSync(home, { recursive: true, force: true }); }
});

test("lying RPC readback cannot commit success", async () => {
  class LyingClient extends Client {
    override async setThinkingLevel(level: ThinkingLevel) { if (level !== "high") await super.setThinkingLevel(level); }
  }
  const f = fixture(new LyingClient());
  try {
    await assert.rejects(changeConfiguration(f.deps, f.conv.id, { provider: "p", id: "new", thinking: "high" }), /readback mismatch/);
    assert.equal(f.client.state.model.id, "old");
    assert.equal(getConversation(f.db, f.conv.id)!.model, "old");
    assert.equal(getConversation(f.db, f.conv.id)!.pending_configuration?.status, "failed");
  } finally { await f.close(); }
});

import { createApp } from "../src/server.js";
import type { AddressInfo } from "node:net";
test("HTTP model endpoint returns full authoritative conversation with specified error codes", async () => {
  const f = fixture(); const home = mkdtempSync(join(tmpdir(), "cog-config-http-"));
  const paths = getPaths({ COGITATOR_HOME: home, COGITATOR_PI_AGENT_DIR: join(home, "pi"), COGITATOR_AGENTS_DIR: join(home, "agents") });
  const server = createApp({ db: f.db, dbPath: ":memory:", dbVersion: 8, paths, pool: f.pool });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/conversations/${f.conv.id}/model`;
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ provider: "p" })).status, 400);
    assert.equal((await post({ provider: "p", id: "new", scope: "global" })).status, 409);
    assert.equal((await post({ provider: "p", id: "new", scope: "preset" })).status, 409);
    const applied = await post({ provider: "p", id: "new", thinking: "high" });
    assert.equal(applied.status, 200);
    const body = await applied.json() as { id: string; model: string; thinking: string; pending_configuration: unknown; runtime_kind: string };
    assert.equal(body.id, f.conv.id); assert.equal(body.model, "new"); assert.equal(body.thinking, "high");
    assert.equal(body.pending_configuration, null); assert.equal(body.runtime_kind, "classic");
    assert.equal((await post({ provider: "p", id: "unknown" })).status, 422);
    const dismissed = await fetch(url, { method: "DELETE" }); assert.equal(dismissed.status, 200);
    assert.equal((await dismissed.json() as { pending_configuration: unknown }).pending_configuration, null);
    await f.pool.prompt(f.conv.id, "first");
    const queued = await post({ provider: "p", id: "old", thinking: "low" }); assert.equal(queued.status, 202);
    assert.equal((await queued.json() as { pending_configuration: { status: string } }).pending_configuration.status, "pending");
    assert.equal((await fetch(url, { method: "DELETE" })).status, 409);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close(); rmSync(home, { recursive: true, force: true });
  }
});
