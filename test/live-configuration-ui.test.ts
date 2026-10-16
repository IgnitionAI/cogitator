import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as i18n from "../web/src/i18n.js";
import { THINKING_LEVELS } from "../web/src/types.js";
import type { Conversation } from "../web/src/types.js";

type Node = { type: string | { name: string }; props: Record<string, unknown> };
function find(node: unknown, predicate: (node: Node) => boolean): Node | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  const element = node as Node;
  return predicate(element) ? element : find(element.props?.children, predicate);
}

// Real component handlers, hook/API doubles. This is not real RPC or browser proof.
function harness() {
  let conversation: Conversation = { id: "chat", agent_id: "bot", workspace_id: null, provider: "old", model: "one", thinking: "low", session_file: null, title: "Chat", status: "idle", updated_at: "", runtime_kind: "classic", pending_configuration: null };
  const slots: unknown[] = [];
  let cursor = 0;
  const calls: unknown[][] = [];
  const effects: Array<() => void> = [];
  let failure = false;
  let deferred = false;
  const jsx = (type: Node["type"], props: Node["props"]): Node => ({ type, props });
  const exports: Record<string, (props: unknown) => Node | null> = {};
  const code = ts.transpileModule(readFileSync("web/src/ModelConfiguration.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(code, { exports, require(name: string) {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "./i18n") return i18n;
    if (name === "./types") return { THINKING_LEVELS };
    if (name === "./ui") return { Field: "Field", ErrorText: "ErrorText" };
    if (name === "react") return {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value: unknown) => { slots[index] = value; }];
      },
      useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
      useEffect(effect: () => void) { effects.push(effect); },
    };
    if (name === "./api") return { api: {
      providers: async () => ({ providers: [{ id: "new", models: [{ id: "two" }] }] }),
      switchModel: async (...args: unknown[]) => {
        calls.push(args);
        if (failure) throw new Error("Rejected");
        return { ...conversation, provider: args[1], model: args[2], thinking: args[3], pending_configuration: deferred ? { request_id: "request", provider: args[1], model: args[2], thinking: args[3], scope: args[4], status: "pending" } : null };
      },
      conversation: async () => ({ conversation: { ...conversation, pending_configuration: null } }),
      dismissConfiguration: async () => { calls.push(["dismiss"]); return { ...conversation, pending_configuration: null }; },
    } };
    throw new Error(name);
  } });
  const render = () => { cursor = 0; return exports.LiveConfiguration!({ conversation, onChanged: (next: Conversation) => { conversation = next; } }); };
  const fields = () => find(render(), (node) => typeof node.type !== "string" && node.type.name === "ModelFields")!;
  const click = (label: string) => {
    const button = find(render(), (node) => node.type === "button" && node.props.children === label)!;
    assert.ok(button, label);
    (button.props.onClick as () => void)();
  };
  render();
  for (const effect of effects.splice(0)) effect();
  return { render, fields, click, calls, get: () => conversation, set: (patch: Partial<Conversation>) => { conversation = { ...conversation, ...patch }; }, fail: () => { failure = true; }, defer: () => { deferred = true; } };
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

test("live editor submits the explicit tuple only on Apply, defaults to conversation and preserves dirty drafts across SSE", async () => {
  i18n.setLocale("en");
  const ui = harness();
  await flush();
  const draft = { provider: "new", model: "two", thinking: "high" };
  (ui.fields().props.onChange as (value: unknown) => void)(draft);
  ui.set({ model: "remote" });
  assert.equal(ui.fields().props.value, draft);
  assert.equal(ui.calls.length, 0);
  ui.click("Apply settings");
  await flush();
  assert.deepEqual(ui.calls, [["chat", "new", "two", "high", "conversation"]]);
  assert.equal(ui.get().model, "two");
});

test("pending changes lock controls; failed retry dismisses first and retains draft on rejection; Durable hides editor", async () => {
  i18n.setLocale("en");
  const ui = harness();
  await flush();
  ui.set({ pending_configuration: { request_id: "request", provider: "new", model: "two", thinking: "high", scope: "preset", status: "pending" } });
  assert.equal(find(ui.render(), (node) => node.type === "fieldset")?.props.disabled, true);
  ui.set({ pending_configuration: { ...ui.get().pending_configuration!, status: "failed", error: "Rejected" } });
  ui.fail();
  ui.click("Retry settings");
  await flush();
  assert.deepEqual(ui.calls, [["dismiss"], ["chat", "new", "two", "high", "preset"]]);
  assert.equal((ui.fields().props.value as { model: string }).model, "two");
  ui.set({ runtime_kind: "durable" });
  assert.equal(ui.render(), null);
});

test("202 response is reconciled with readback when an applied SSE may have arrived first", async () => {
  i18n.setLocale("en");
  const ui = harness();
  await flush();
  ui.defer();
  ui.click("Apply settings");
  await flush();
  assert.equal(ui.get().pending_configuration, null);
});

test("configuration copy covers English and French with distinct scope and future-default labels", () => {
  for (const locale of ["en", "fr"] as const) {
    i18n.setLocale(locale);
    assert.notEqual(i18n.t("configuration.conversation"), i18n.t("configuration.preset"));
    assert.ok(i18n.t("configuration.future"));
    assert.ok(i18n.t("configuration.failed"));
  }
});

// Controlled GET/SSE ordering against the real screen handlers.
function screenHarness(groupView: boolean) {
  const base = (id: string): Conversation => ({ id, agent_id: id, workspace_id: null, provider: "old", model: "one", thinking: "low", session_file: null, title: id, status: "idle", updated_at: "", runtime_kind: "classic", pending_configuration: null });
  const slots: unknown[] = [];
  let cursor = 0;
  let mounted = false;
  const effects: Array<() => void> = [];
  const timers: Array<() => void> = [];
  let onEvent: (event: unknown) => void = () => {};
  let onOpen: () => void = () => {};
  const reads: Array<{ id: string; resolve: (value: unknown) => void }> = [];
  const stopped: string[] = [];
  let sends = 0;
  const modules = new Map<string, Record<string, unknown>>();
  const jsx = (type: Node["type"], props: Node["props"]): Node => {
    if (typeof type === "function" && type.name === "QueueRecovery") return (type as (props: unknown) => Node)(props);
    return { type, props };
  };
  function load(path: string): Record<string, unknown> {
    if (modules.has(path)) return modules.get(path)!;
    const exports: Record<string, unknown> = {};
    modules.set(path, exports);
    let source = readFileSync(path, "utf8");
    if (path.endsWith("Bots.tsx")) source += "\nexport { GroupView };";
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, {
      exports, setTimeout: (callback: () => void) => { timers.push(callback); return 0; }, clearTimeout() {},
      require(name: string): unknown {
        if (name.endsWith("/i18n")) return i18n;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name.endsWith("/types")) return { THINKING_LEVELS };
        if (name === "react") return {
          useState(initial: unknown) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = initial;
            return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
          },
          useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
          useCallback(callback: unknown) { return callback; },
          useEffect(effect: () => void) { if (!mounted) effects.push(effect); },
        };
        if (name === "../api") return {
          openEvents: (_url: string, event: typeof onEvent, options: { onOpen: () => void }) => { onEvent = event; onOpen = options.onOpen; return () => {}; },
          api: {
            conversation: (id: string) => new Promise((resolve) => reads.push({ id, resolve })),
            history: async () => ({ entries: [] }), conversationFiles: async () => ({ files: [] }), skills: async () => ({ skills: [] }),
            groupMessages: async () => ({ messages: [] }), stopConversation: async (id: string) => { stopped.push(id); },
            sendMessage: async () => { sends++; }, sendGroupMessage: async () => { sends++; },
          },
        };
        if (name === "../ModelConfiguration") return { LiveConfiguration: "LiveConfiguration" };
        if (name === "../QueueRecovery") return load("web/src/QueueRecovery.tsx");
        if (name === "./Conversations") return load("web/src/screens/Conversations.tsx");
        if (name === "../ui") return { useToast: () => () => {}, statusColor: () => "" };
        if (name.endsWith("/generative-ui")) return { parseUIResponse: () => null };
        return {};
      },
    });
    return exports;
  }
  const module = load(`web/src/screens/${groupView ? "Bots" : "Conversations"}.tsx`);
  const component = module[groupView ? "GroupView" : "ChatView"] as (props: unknown) => Node;
  const props = groupView ? { group: { id: "group", name: "Group", members: ["a", "b"].map((id) => ({ agent_id: id, conversation_id: id, name: id, slug: id, is_host: id === "a" ? 1 : 0 })) }, onClose() {} } : { conversation: base("a"), onClose() {}, onDeleted() {} };
  const render = () => { cursor = 0; return component(props); };
  render(); mounted = true; effects.forEach((effect) => effect());
  const emit = (event: unknown, id = "a") => onEvent(groupView ? { type: "group_activity", conversationId: id, agentId: id, event } : event);
  const configuration = (id: string) => find(render(), (node) => node.type === "LiveConfiguration" && (node.props.conversation as Conversation).id === id)?.props.conversation as Conversation | undefined;
  return { base, render, emit, reads, stopped, configuration, open: () => onOpen(), timers, sends: () => sends };
}

test("reconnect reads cannot replace newer configuration SSE in standalone or any group member", async () => {
  i18n.setLocale("en");
  for (const group of [false, true]) {
    const ui = screenHarness(group);
    ui.open();
    ui.emit({ type: "configuration_changed", conversation: { ...ui.base("a"), model: "applied" } });
    for (const request of ui.reads) request.resolve({ conversation: { ...ui.base(request.id), model: "stale" }, live: false });
    await flush();
    assert.equal(ui.configuration("a")?.model, "applied");
    if (group) assert.equal(ui.configuration("b")?.model, "stale", "unaffected member still hydrates");
  }
});

test("group configuration and queued-message events do not redirect Stop away from the streaming member", async () => {
  i18n.setLocale("en");
  const ui = screenHarness(true);
  ui.emit({ type: "agent_start" }, "a");
  ui.emit({ type: "configuration_changed", conversation: { ...ui.base("b"), model: "changed" } }, "b");
  ui.emit({ type: "queue_error", message: "retry B", error: "offline" }, "b");
  const stop = find(ui.render(), (node) => node.type === "button" && JSON.stringify(node.props.children).includes("Stop"))!;
  assert.ok(stop);
  (stop.props.onClick as () => void)();
  await flush();
  assert.deepEqual(ui.stopped, ["a"]);
});

test("queue cancellation/failure stays visible and restoration appends to drafts without sending, in both chat surfaces", async () => {
  i18n.setLocale("en");
  for (const group of [false, true]) {
    const ui = screenHarness(group);
    ui.emit({ type: "queue_cleared", count: 1, messages: ["canceled text"], reason: "stopped" }, "b");
    ui.emit({ type: "queue_error", message: "failed text", error: "offline" }, "b");
    const input = find(ui.render(), (node) => node.type === "textarea")!;
    (input.props.onChange as (event: unknown) => void)({ target: { value: "existing draft" } });
    const restore = find(ui.render(), (node) => node.type === "button" && node.props.children === "Add message to draft")!;
    assert.ok(restore);
    (restore.props.onClick as () => void)();
    assert.equal(find(ui.render(), (node) => node.type === "textarea")?.props.value, `existing draft\n\n${group ? "@b " : ""}canceled text`);
    assert.equal(ui.sends(), 0);
    ui.open(); // Group replay must retain recoverable failures.
    await flush();
    assert.ok(find(ui.render(), (node) => node.type === "p" && node.props.children === "Queued message failed before delivery. Restore it to edit and retry."));
  }
});
