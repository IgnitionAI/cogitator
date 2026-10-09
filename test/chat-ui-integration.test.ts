import * as i18n from "../web/src/i18n.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { openDb } from "../src/db.js";
import { createConversation, getConversation } from "../src/conversations.js";
import { buildArgs, type SpawnConfig } from "../src/spawn.js";
import { makeSpawner } from "../src/spawner.js";
import { PiPool, type PiClientFactoryOptions } from "../src/pool.js";
import { getPaths } from "../src/paths.js";
import { UI_INSTRUCTIONS, UI_PRESENTATION_POLICY, parseUIResponse, serializeUIResponse } from "../src/generative-ui.js";
import { readEntries } from "../src/history.js";

i18n.setLocale("fr");

test("new conversations freeze the UI instructions; old spawn snapshots remain unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-ui-snapshot-"));
  const { db } = openDb(join(dir, "test.db"));
  try {
    const source: SpawnConfig = { provider: "test", model: "model", systemPrompt: "Instructions du preset." };
    const conversation = createConversation(db, { spawn: source });
    const snapshot: SpawnConfig = JSON.parse(conversation.spawn_args);
    assert.equal(snapshot.uiInstructions, UI_INSTRUCTIONS);
    assert.equal(source.uiInstructions, undefined);
    source.systemPrompt = "Autre configuration";
    assert.equal(JSON.parse(getConversation(db, conversation.id)!.spawn_args).systemPrompt, "Instructions du preset.");
    buildArgs(snapshot, dir, "new");
    assert.equal(readFileSync(join(dir, "new.prompt.md"), "utf8"), `Instructions du preset.\n\n${UI_INSTRUCTIONS}`);
    buildArgs({ provider: "test", model: "model", systemPrompt: "Ancien snapshot" }, dir, "old");
    assert.equal(readFileSync(join(dir, "old.prompt.md"), "utf8"), "Ancien snapshot");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("automatic UI reaches new and resumed legacy sessions without changing snapshots or sending synthetic messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-auto-ui-"));
  const { db } = openDb(join(dir, "test.db"));
  const launches: PiClientFactoryOptions[] = [];
  let prompts = 0;
  const pool = new PiPool({ factory: (options) => {
    launches.push(options);
    return {
      async start() {}, async stop() {}, onEvent: () => () => {},
      async getState() { return { isStreaming: false }; },
      async prompt() { prompts++; }, async abort() {}, async setModel() {},
    };
  } });
  try {
    const spawn: SpawnConfig = { provider: "test", model: "frozen", systemPrompt: "Preset figé", tools: ["read"] };
    const fresh = createConversation(db, { spawn });
    const legacy = createConversation(db, { spawn });
    const sessionFile = join(dir, "existing-session.jsonl");
    db.prepare("UPDATE conversation SET spawn_args = ?, session_file = ? WHERE id = ?").run(JSON.stringify(spawn), sessionFile, legacy.id);
    const spawner = makeSpawner({ db, pool, paths: { ...getPaths(), home: dir } });
    for (const id of [fresh.id, legacy.id]) {
      const conversation = getConversation(db, id)!;
      const snapshot = conversation.spawn_args;
      await spawner.ensure(conversation);
      const args = launches.at(-1)!.args;
      const prompt = readFileSync(args[args.indexOf("--append-system-prompt") + 1]!, "utf8");
      assert(prompt.startsWith("Preset figé"));
      assert.equal(prompt.split("## Interfaces Cogitator (contrat v1)").length, 2);
      assert(prompt.includes(UI_INSTRUCTIONS));
      assert(prompt.includes(UI_PRESENTATION_POLICY));
      assert.equal(getConversation(db, id)!.spawn_args, snapshot);
      assert.equal(args[args.indexOf("--tools") + 1], "read");
    }
    assert.equal(launches[1]!.args.at(-2), "--session");
    assert.equal(launches[1]!.args.at(-1), sessionFile);
    assert.equal(prompts, 0, "availability must not trigger a model call or add an artificial user message");
  } finally { await pool.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("JSONL restores generated interfaces, responses and actual tool error state", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-ui-history-"));
  try {
    const spec = { version: 1 as const, id: "scope", kind: "choices" as const, title: "Périmètre", options: [{ id: "chat", label: "Le chat" }] };
    const response = serializeUIResponse(spec, { selection: "chat" });
    const text = `Choisis un périmètre.\n\n\`\`\`cogitator-ui\n${JSON.stringify(spec)}\n\`\`\``;
    const messages = [
      { role: "assistant", content: [{ type: "text", text }] },
      { role: "user", content: [{ type: "text", text: response }] },
      { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "test" } }] },
      { role: "toolResult", toolCallId: "tool-1", isError: true, content: [{ type: "text", text: "Permission refusée" }] },
    ];
    const file = join(dir, "history.jsonl");
    writeFileSync(file, messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"));
    const entries = readEntries(file);
    assert.deepEqual(entries[0], { type: "assistant", text });
    assert(entries[1]?.type === "user");
    assert.equal(parseUIResponse(entries[1].text)?.values.selection, "chat");
    assert(entries[2]?.type === "tool");
    assert.equal(entries[2].isError, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("live tools finish only on execution end and preserve explicit errors", () => {
  const exports: { applyEvent?: (items: unknown[], event: unknown, state: unknown) => Array<Record<string, unknown>> } = {};
  const source = readFileSync("web/src/screens/Conversations.tsx", "utf8") + "\nexport { applyEvent };";
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: (name: string) => name === "../i18n" ? i18n : ({}) });
  const apply = exports.applyEvent!;
  const state = { assistantIndex: null, streaming: false, toolByContent: {} };
  let items = apply([], { type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "call1", contentIndex: 0, toolName: "read" } }, state);
  items = apply(items, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call1", name: "read", arguments: { path: "a.ts" } } } }, state);
  assert.equal(items[0]?.state, "running");
  items = apply(items, { type: "tool_execution_start", toolCallId: "call1", toolName: "read", args: { path: "a.ts" } }, state);
  assert.equal(items.length, 1);
  items = apply(items, { type: "tool_execution_update", toolCallId: "call1", partialResult: { content: [{ type: "text", text: "lecture…" }] } }, state);
  assert.equal(items[0]?.result, "lecture…");
  items = apply(items, { type: "tool_execution_end", toolCallId: "call1", isError: true, result: { content: [{ type: "text", text: "Introuvable" }] } }, state);
  assert.equal(items[0]?.state, "done");
  assert.equal(items[0]?.isError, true);
  assert.equal(items[0]?.result, "Introuvable");
});

test("recovery repairs missed text, tool completion and remote responses while retaining live positions and keys", () => {
  type Item = { kind: string; text: string; id?: string; key?: number; result?: string; state?: string; isError?: boolean };
  const exports: { reconcile?: (items: Item[], entries: unknown[], stream: typeof state, initial?: boolean) => Item[] } = {};
  const source = readFileSync("web/src/screens/Conversations.tsx", "utf8") + "\nexport { reconcile };";
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: (name: string) => name === "../i18n" ? i18n : ({}) });
  const state = { assistantIndex: 1 as number | null, streaming: false, toolByContent: { 0: 2 } };
  const response = serializeUIResponse({ version: 1, id: "choice", kind: "choices", title: "Choix", options: [{ id: "yes", label: "Oui" }] }, { selection: "yes" });
  const previous = [
    { kind: "user", text: "Question", key: 10 },
    { kind: "assistant", text: "Réponse partielle", key: 11 },
    { kind: "tool", id: "call", text: "read", args: "{}", result: "partial", state: "running", key: 12 },
  ];
  const history = [
    { type: "user", text: "Question" }, { type: "thinking", text: "Réflexion" },
    { type: "assistant", text: "Réponse partielle puis complète" },
    { type: "tool", id: "call", name: "read", args: "{}", result: "FINAL ERROR", isError: true },
    { type: "user", text: response },
  ];
  const recovered = exports.reconcile!(previous, history, state);
  assert.equal(recovered.length, 5);
  assert.equal(recovered[2]?.text, "Réponse partielle puis complète");
  assert.equal(recovered[2]?.key, 11, "inserting thinking must not remount an existing form");
  assert.equal(recovered[3]?.result, "FINAL ERROR");
  assert.equal(recovered[3]?.state, "done");
  assert.equal(recovered[3]?.isError, true);
  assert.equal(recovered[4]?.text, response);
  assert.equal(state.assistantIndex, 2);
  assert.equal(state.toolByContent[0], 3);
  assert.equal(exports.reconcile!(recovered, history, state).length, 5, "recovery is idempotent");
  const liveState = { assistantIndex: 1, streaming: true, toolByContent: { 0: 2 } };
  const live = exports.reconcile!(previous, history, liveState);
  assert.equal(live[2]?.text, "Réponse partielle", "a snapshot must not get ahead of the active delta stream");
  const idle = () => ({ assistantIndex: null, streaming: false, toolByContent: { 0: 0 } });
  const firstLoad = exports.reconcile!(previous.slice(0, 2), history.slice(0, 3), idle(), true);
  assert.equal(firstLoad.length, 3, "thinking during initial hydration must not duplicate messages");
  const tools = exports.reconcile!([{ kind: "tool", id: "a", text: "read", state: "running" }], [
    { type: "tool", id: "a", name: "read", args: "{}", result: "A" },
    { type: "tool", id: "b", name: "read", args: "{}", result: "B" },
  ], idle(), true);
  assert.deepEqual(Array.from(tools, item => [item.id, item.result]), [["a", "A"], ["b", "B"]], "tool names cannot stand in for call IDs");
  const gap = exports.reconcile!([{ kind: "assistant", text: "Hello !", key: 50 }], [{ type: "assistant", text: "Hello world!" }], idle());
  assert.equal(gap.length, 1);
  assert.equal(gap[0]?.text, "Hello world!");
  assert.equal(gap[0]?.key, 50);
  const unsaved = exports.reconcile!([{ kind: "user", text: "Nouvelle question" }], history.slice(0, 3), idle(), true);
  assert.equal(unsaved.at(-1)?.text, "Nouvelle question", "unflushed local echoes stay after the older history");
});
