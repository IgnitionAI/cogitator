import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCogitatorTools, type CogitatorCall } from "../src/mcp-tools.js";

async function pair(call: CogitatorCall, scope: "read" | "full" = "full") {
  const server = new McpServer({ name: "t", version: "0" });
  const names = registerCogitatorTools(server, { call, scope, pollMs: 5 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  return { client, names };
}

test("scope read : sous-ensemble strict des outils full", async () => {
  const noop: CogitatorCall = async () => ({});
  const fullNames = (await pair(noop)).names;
  const readNames = (await pair(noop, "read")).names;
  assert.ok(readNames.length > 5 && readNames.length < fullNames.length);
  for (const n of readNames) assert.ok(fullNames.includes(n));
});

test("cogitator_send_message wait=true : attend la fin du tour, renvoie la réponse, émet la progression", async () => {
  let entries: Array<Record<string, unknown>> = [{ type: "user", text: "hello" }, { type: "assistant", text: "hi" }];
  let polls = 0;
  const calls: string[] = [];
  const call: CogitatorCall = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/conversations/c1/messages") {
      assert.equal((body as { text: string }).text, "quelle heure ?");
      assert.ok((body as { requestId: string }).requestId);
      return { ok: true };
    }
    if (path === "/api/conversations/c1") {
      polls++;
      if (polls === 2) entries = [...entries, { type: "user", text: "quelle heure ?" }, { type: "tool", name: "clock", args: "{}" }];
      if (polls === 4) entries = [...entries, { type: "assistant", text: "Il est midi." }];
      return { streaming: polls < 4 };
    }
    if (path === "/api/conversations/c1/history") return { entries };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const { client } = await pair(call);
  const progress: number[] = [];
  const result = await client.callTool({ name: "cogitator_send_message", arguments: { conversation_id: "c1", text: "quelle heure ?" } },
    undefined, { onprogress: (p) => progress.push(p.progress) });
  const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  assert.equal(data.status, "completed");
  assert.equal(data.reply, "Il est midi.");
  assert.deepEqual(data.tools_used, [{ name: "clock", isError: false }]);
  assert.ok(progress.length >= 2, "notifications de progression reçues");
});

test("cogitator_send_message : timeout → status running ; wait=false → sent", async () => {
  const call: CogitatorCall = async (_m, path) => path.endsWith("/history") ? { entries: [] } : path.endsWith("/messages") ? { ok: true } : { streaming: true };
  const { client } = await pair(call);
  const r = await client.callTool({ name: "cogitator_send_message", arguments: { conversation_id: "c1", text: "x", timeout_seconds: 1 } });
  assert.equal(JSON.parse((r.content as Array<{ text: string }>)[0]!.text).status, "running");
  const s = await client.callTool({ name: "cogitator_send_message", arguments: { conversation_id: "c1", text: "x", wait: false } });
  assert.equal(JSON.parse((s.content as Array<{ text: string }>)[0]!.text).status, "sent");
});

test("cogitator_read_conversation : filtre les outils par défaut, limite", async () => {
  const entries = [{ type: "user", text: "a" }, { type: "thinking", text: "t" }, { type: "tool", name: "x" }, { type: "assistant", text: "b" }];
  const { client } = await pair(async () => ({ entries }));
  const plain = JSON.parse(((await client.callTool({ name: "cogitator_read_conversation", arguments: { conversation_id: "c" } })).content as Array<{ text: string }>)[0]!.text);
  assert.deepEqual(plain.entries.map((e: { type: string }) => e.type), ["user", "assistant"]);
  const all = JSON.parse(((await client.callTool({ name: "cogitator_read_conversation", arguments: { conversation_id: "c", include_tools: true, limit: 2 } })).content as Array<{ text: string }>)[0]!.text);
  assert.deepEqual(all.entries.map((e: { type: string }) => e.type), ["tool", "assistant"]);
});
