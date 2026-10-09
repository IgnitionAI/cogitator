import * as i18n from "../web/src/i18n.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { HistoryEntry, SseEvent } from "../web/src/types";
import * as generativeUI from "../src/generative-ui.js";

i18n.setLocale("fr");

// Executes the real component handlers with local hook/API doubles; never contacts the backend.
function chatHarness() {
  const slots: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  let sends = 0;
  let historyEntries: HistoryEntry[] | null = null;
  let onEvent!: (event: SseEvent) => void;
  let resolveSend!: () => void;
  let rejectSend!: (error: Error) => void;
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: unknown) => {
        slots[index] = typeof value === "function" ? value(slots[index]) : value;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect: () => void) { effects.push(effect); },
    useCallback(callback: unknown) { return callback; },
  };
  type Node = { type: string; props: Record<string, unknown> };
  const jsx = (type: string, props: Record<string, unknown>): Node => ({ type, props });
  const exports: Record<string, (props: unknown) => Node> = {};
  const code = ts.transpileModule(readFileSync("web/src/screens/Conversations.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(code, {
    exports,
    setTimeout: () => 0,
    clearTimeout() {},
    FileReader: class {
      result = "";
      onload: (() => void) | null = null;
      readAsDataURL(file: { name: string }) { this.result = `data:image/png;base64,${file.name}`; this.onload?.(); }
    },
    require: (name: string) => {
      if (name === "./i18n" || name === "../i18n") return i18n;
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "../api") return { openEvents: (_url: string, listener: typeof onEvent) => { onEvent = listener; return () => {}; }, api: {
        history: () => historyEntries === null ? Promise.reject(new Error("offline")) : Promise.resolve({ entries: historyEntries }),
        conversationFiles: () => Promise.resolve({ files: [] }),
        skills: () => Promise.resolve({ skills: [] }),
        sendMessage: () => {
          sends++;
          return new Promise<void>((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
        },
      } };
      if (name === "../ui") return { useToast: () => () => {}, statusColor: () => "" };
      if (name === "../../../src/generative-ui") return generativeUI;
      if (name === "../ChatMessage") return { AssistantContent: "AssistantContent", UserContent: "UserContent" };
      return {};
    },
  });
  function render() {
    cursor = 0;
    effects = [];
    return exports.ChatView({ conversation: { id: "test", status: "active" }, onClose() {}, onDeleted() {} });
  }
  function find(node: unknown, predicate: (node: Node) => boolean): Node | undefined {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) { const match = find(child, predicate); if (match) return match; }
      return;
    }
    const element = node as Node;
    if (predicate(element)) return element;
    return find(element.props?.children, predicate);
  }
  const textarea = () => find(render(), (node) => node.type === "textarea")!;
  const sendButton = () => find(render(), (node) => node.type === "button" && node.props.className === "btn btn-primary")!;
  const change = (value: string) => (textarea().props.onChange as (event: unknown) => void)({ target: { value } });
  const enter = (isComposing = false) => (textarea().props.onKeyDown as (event: unknown) => void)({
    key: "Enter", shiftKey: false, nativeEvent: { isComposing }, preventDefault() {},
  });
  const attach = (name: string) => {
    const input = find(render(), (node) => node.type === "input" && node.props.type === "file")!;
    (input.props.onChange as (event: unknown) => void)({ target: { files: [{ name, type: "image/png" }], value: name } });
  };
  const scrollEffect = () => effects.at(-1)!();
  const loadHistory = () => { render(); effects[1]!(); };
  const historySucceeds = (entries: HistoryEntry[]) => { historyEntries = entries; };
  const emit = (event: SseEvent) => onEvent(event);
  const messages = () => {
    const transcript = find(render(), (node) => node.props.className === "chat-scroll")!;
    const timeline = (transcript.props.children as unknown[])[4] as Node[];
    return Array.from(timeline, (node) => find(node, (child) => typeof child.props.text === "string")?.props.text);
  };
  return { change, enter, textarea, sendButton, render, find, attach, scrollEffect, loadHistory, historySucceeds, emit, messages, sends: () => sends, resolve: () => resolveSend(), reject: () => rejectSend(new Error("offline")) };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("failed send preserves draft; IME and repeat Enter do not submit; success keeps later edits", async () => {
  const chat = chatHarness();
  chat.change("Brouillon");
  chat.enter(true);
  assert.equal(chat.sends(), 0);
  chat.enter();
  chat.enter();
  assert.equal(chat.sends(), 1);
  assert.equal(chat.textarea().props.value, "Brouillon");
  chat.reject();
  await settle();
  assert.equal(chat.textarea().props.value, "Brouillon");
  chat.enter();
  chat.change("Texte suivant");
  chat.resolve();
  await settle();
  assert.equal(chat.textarea().props.value, "Texte suivant");
  chat.enter();
  chat.resolve();
  await settle();
  assert.equal(chat.textarea().props.value, "");
  assert.equal(chat.find(chat.render(), (node) => node.props["aria-label"] === "Historique de la conversation")?.props["aria-live"], "off");
  assert.equal(chat.find(chat.render(), (node) => node.type === "button" && node.props.className === "btn btn-sm btn-danger"), undefined, "a live idle process does not need a Stop control");
  chat.loadHistory();
  chat.emit({ type: "agent_start" });
  assert.ok(chat.find(chat.render(), (node) => node.type === "button" && node.props.className === "btn btn-sm btn-danger"));
});

test("SSE reports reconnects and removes handlers on cleanup without breaking legacy callers", () => {
  const states: string[] = [];
  let instance!: FakeSource;
  class FakeSource {
    static CLOSED = 2;
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { instance = this; }
    close() { this.readyState = 2; }
  }
  const exports: { openEvents?: (url: string, onEvent: (event: unknown) => void, options?: unknown) => () => void } = {};
  runInNewContext(ts.transpileModule(readFileSync("web/src/api.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, EventSource: FakeSource });
  const close = exports.openEvents!("/fake", () => {}, { onStateChange: (state: string) => states.push(state) });
  instance.onopen!();
  instance.onerror!();
  instance.onopen!();
  close();
  assert.deepEqual(states, ["connecting", "connected", "reconnecting", "connected", "closed"]);
  assert.equal(instance.onopen, null);
  assert.equal(instance.onmessage, null);
  exports.openEvents!("/legacy", () => {})();
});

test("attachments survive failure and only sent images are removed on success; scrolling respects position", async () => {
  const chat = chatHarness();
  const attachments = () => chat.find(chat.render(), (node) => node.props.className === "msg msg-user thumbs");
  chat.attach("first");
  chat.enter();
  chat.reject();
  await settle();
  assert.ok(attachments());
  chat.enter();
  chat.attach("later");
  chat.resolve();
  await settle();
  const thumbs = attachments()!.props.children as unknown[];
  assert.equal((thumbs[0] as unknown[]).length, 1);
  const scroll = chat.find(chat.render(), (node) => node.props.className === "chat-scroll")!;
  let scrolls = 0;
  (scroll.props.ref as { current: unknown }).current = { scrollHeight: 1000, scrollTo() { scrolls++; } };
  const onScroll = scroll.props.onScroll as (event: unknown) => void;
  onScroll({ currentTarget: { scrollHeight: 1000, scrollTop: 100, clientHeight: 200 } });
  chat.scrollEffect();
  assert.equal(scrolls, 0);
  onScroll({ currentTarget: { scrollHeight: 1000, scrollTop: 750, clientHeight: 200 } });
  chat.scrollEffect();
  assert.equal(scrolls, 1);
});

test("history failure is visible with retry instead of a false empty session", async () => {
  const chat = chatHarness();
  chat.loadHistory();
  await settle();
  assert.ok(chat.find(chat.render(), (node) => node.props.error === "Historique indisponible : offline"));
  assert.ok(chat.find(chat.render(), (node) => node.props.children === "Réessayer l’historique"));
  assert.equal(chat.find(chat.render(), (node) => node.props.title === "Session prête"), undefined);
});

test("retry after failed initial history merges old history with sent/live items and deduplicates overlap", async () => {
  for (const recoveredAssistant of [undefined, null, "Réponse", "Réponse live", "Réponse live complète"]) {
    const chat = chatHarness();
    chat.loadHistory();
    await settle();
    chat.change("Message envoyé");
    chat.enter();
    chat.resolve();
    await settle();
    chat.emit({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
    chat.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Réponse live" } });
    chat.historySucceeds([
      { type: "user", text: "Ancienne question" },
      { type: "assistant", text: "Ancienne réponse" },
      ...(recoveredAssistant === undefined ? [] : [{ type: "user" as const, text: "Message envoyé" }]),
      ...(typeof recoveredAssistant === "string" ? [{ type: "assistant" as const, text: recoveredAssistant }] : []),
    ]);
    const retry = chat.find(chat.render(), (node) => node.props.children === "Réessayer l’historique")!;
    (retry.props.onClick as () => void)();
    await settle();
    assert.deepEqual(chat.messages(), ["Ancienne question", "Ancienne réponse", "Message envoyé", "Réponse live"]);
    assert.equal(chat.find(chat.render(), (node) => Boolean(node.props.error)), undefined);
    chat.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " suite" } });
    assert.deepEqual(chat.messages(), ["Ancienne question", "Ancienne réponse", "Message envoyé", "Réponse live suite"]);
  }
});
