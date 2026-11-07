import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { getPaths } from "../src/paths.js";
import { createConversation } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { PiPool } from "../src/pool.js";
import { piCliPath, piCodingAgent } from "../src/host-pi.js";
import { disposeSetprivShims, guardedRpcSpawn } from "../src/pi-child.js";
import { upsertProvider } from "../src/registry.js";

// A real pi subprocess talks only to a disposable local HTTP fixture. No provider account or paid API.
test("configured custom provider completes an HTTP chat through the actual pi RPC process", { timeout: 40_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-chat-rpc-"));
  const paths = getPaths({ HOME: home, COGITATOR_HOME: home });
  let requests = 0;
  const modelServer = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(JSON.parse(body).model, "fixture-model");
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) => ({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "LOCAL_RPC_OK" }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => modelServer.listen(0, "127.0.0.1", resolve));
  const { db } = openDb(paths.db);
  const pool = new PiPool({ factory: options => new piCodingAgent.RpcClient(guardedRpcSpawn(piCliPath, {
    ...options,
    cwd: home,
    args: [...options.args, "--offline", "--no-extensions", "--no-skills", "--no-tools", "--no-prompt-templates"],
    env: { ...options.env, HOME: home },
  })) });
  const app = createApp({ db, dbPath: paths.db, dbVersion: 10, paths, pool });
  const events = new AbortController();
  try {
    assert.deepEqual(upsertProvider(paths, "fixture", {
      baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "local-fixture-only", models: [{ id: "fixture-model" }],
    }), {});
    const conversation = createConversation(db, { spawn: { provider: "fixture", model: "fixture-model", thinking: "off" } });
    await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/conversations/${conversation.id}/events`, { signal: AbortSignal.any([events.signal, AbortSignal.timeout(25_000)]) });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"type":"session"/);
    assert.equal(pool.isLive(conversation.id), true);
    assert.equal(requests, 0, "opening a conversation must not send a model request");
    const settled = pool.waitForSettled(conversation.id, 20_000);
    const sent = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Reply with the fixture response" }) });
    assert.equal(sent.status, 200);
    await settled;
    let stream = initial;
    while (!stream.includes("LOCAL_RPC_OK")) {
      const next = await reader.read();
      if (next.done) break;
      stream += new TextDecoder().decode(next.value);
    }
    assert.match(stream, /LOCAL_RPC_OK/);
    assert.equal(requests, 1);
    const history = await (await fetch(`${base}/api/conversations/${conversation.id}/history`)).json();
    assert.ok(history.entries.some((entry: { type: string; text?: string }) => entry.type === "assistant" && entry.text === "LOCAL_RPC_OK"));
    await reader.cancel();
  } finally {
    events.abort();
    await pool.dispose();
    disposeSetprivShims();
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
    modelServer.closeAllConnections();
    await new Promise<void>(resolve => modelServer.close(() => resolve()));
    db.close(); rmSync(home, { recursive: true });
  }
});

// The HTTP stream must deliver a terminal setup error instead of a 5xx that EventSource retries.
test("missing provider produces one explicit SSE setup error and a typed model-switch rejection", { timeout: 10_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-chat-setup-error-"));
  const paths = getPaths({ HOME: home, COGITATOR_HOME: home });
  const { db } = openDb(paths.db);
  let starts = 0;
  const pool = new PiPool({ factory: () => ({
    start: async () => { starts++; }, stop: async () => {}, onEvent: () => () => {},
    getState: async () => ({ model: { provider: "unconnected", id: "old" }, thinkingLevel: "off" as const }),
    getAvailableModels: async () => [], getAvailableThinkingLevels: async () => ["off" as const],
    setThinkingLevel: async () => {}, setModel: async () => {}, prompt: async () => { assert.fail("must not prompt"); }, abort: async () => {},
  }) });
  const app = createApp({ db, dbPath: paths.db, dbVersion: 10, paths, pool });
  try {
    const conversation = createConversation(db, { spawn: { provider: "unconnected", model: "old", thinking: "off" } });
    await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/conversations/${conversation.id}/events`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const stream = await response.text();
    const event = JSON.parse(stream.split("\n").find(line => line.startsWith("data: "))!.slice(6));
    assert.equal(event.type, "session_error"); assert.equal(event.code, "PROVIDER_NOT_CONFIGURED"); assert.equal(event.provider, "unconnected");
    assert.equal(starts, 1); assert.equal(pool.isLive(conversation.id), false);
    const change = await fetch(`${base}/api/conversations/${conversation.id}/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "unconnected", id: "new" }) });
    assert.equal(change.status, 409); assert.equal((await change.json()).code, "PROVIDER_NOT_CONFIGURED");
    const current = (await (await fetch(`${base}/api/conversations/${conversation.id}`)).json()).conversation;
    assert.equal(current.model, "old"); assert.equal(current.pending_configuration.status, "failed");
  } finally {
    await pool.dispose(); app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
    db.close(); rmSync(home, { recursive: true });
  }
});
