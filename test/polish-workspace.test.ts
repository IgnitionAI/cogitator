import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Node = { type: unknown; props: Record<string, unknown> };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// Execute actual component handlers against fixture APIs, without user data or a browser.
function harness(file: string, component: string, api: Record<string, (...args: unknown[]) => Promise<unknown>>, props: Record<string, unknown> = {}) {
  const slots: unknown[] = [];
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  const queued: Array<() => void> = [];
  let cursor = 0;
  let effectCursor = 0;
  let confirmed = false;
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback: (callback: unknown) => callback,
    useEffect(callback: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectCursor++;
      if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index].deps[i]))) queued.push(() => {
        effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: callback() };
      });
    },
  };
  const jsx = (type: unknown, props: Node["props"]): Node => ({ type, props });
  const exports: Record<string, (props: unknown) => Node> = {};
  runInNewContext(ts.transpileModule(`${readFileSync(file, "utf8")}\nexport { ${component} as Subject };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, confirm: () => confirmed,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name.endsWith("/api")) return { api };
      if (name.endsWith("/ui")) return { useToast: () => () => {}, Field: "Field", Modal: "Modal" };
      if (name.endsWith("/types")) return { THINKING_LEVELS: [] };
      return {};
    },
  });
  function render() {
    cursor = effectCursor = 0;
    const node = exports.Subject(props);
    while (queued.length) queued.shift()!();
    return node;
  }
  function find(node: unknown, predicate: (node: Node) => boolean): Node | undefined {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return; }
    const element = node as Node;
    return predicate(element) ? element : find(element.props?.children, predicate);
  }
  const get = (predicate: (node: Node) => boolean) => find(render(), predicate)!;
  return { render, get, confirm: (value: boolean) => { confirmed = value; } };
}

const click = (node: Node) => (node.props.onClick as () => void)();
const change = (node: Node, value: string) => (node.props.onChange as (event: unknown) => void)({ target: { value } });

test("new conversation blocks missing prerequisites, exposes retry, and prevents duplicate creation", async () => {
  let fails = true;
  let creates = 0;
  let resolve!: (value: unknown) => void;
  const modal = harness("web/src/screens/Conversations.tsx", "NewConversationModal", {
    agents: async () => { if (fails) throw new Error("offline"); return { agents: [{ id: "agent", name: "Agent" }] }; },
    providers: async () => ({ providers: [] }), workspaces: async () => ({ workspaces: [] }),
    createConversation: () => { creates++; return new Promise((done) => { resolve = done; }); },
  }, { onClose() {}, onCreated() {} });
  const create = () => modal.get((n) => n.type === "button" && n.props.className === "btn btn-primary");
  assert.equal(create().props.disabled, true);
  click(create()); assert.equal(creates, 0);
  await settle();
  assert.ok(modal.get((n) => n.props.role === "alert"));
  fails = false;
  click(modal.get((n) => n.props.children === "Réessayer")); modal.render(); await settle();
  assert.equal(create().props.disabled, false);
  click(create()); click(create()); assert.equal(creates, 1);
  assert.equal(create().props.disabled, true);
  resolve({ conversation: { id: "fixture" } }); await settle();
  change(modal.get((n) => n.type === "select" && n.props.value === "agent"), "free");
  assert.equal(create().props.disabled, true);
  click(create()); assert.equal(creates, 1);
});

test("card edits require a title, confirm discard, and serialize deletion", async () => {
  let closed = 0;
  let saves = 0;
  let deletes = 0;
  let resolveDelete!: (value: unknown) => void;
  const card = { id: "card", title: "Fixture", description: "", priority: "medium", status: "todo", labels: [], assignee_agent_id: null, conversation_ids: [], blocks: [], blocked_by: [], comments: [] };
  const modal = harness("web/src/Board.tsx", "CardDetail", {
    boardUpdateCard: async () => { saves++; return { card }; },
    boardDeleteCard: () => { deletes++; return new Promise((done) => { resolveDelete = done; }); },
  }, { card, cards: [card], agents: [], conversations: [], workspaceId: "fixture", onClose() { closed++; }, onDeleted() {}, onChanged() {} });
  const title = () => modal.get((n) => n.type === "input" && n.props.value === "Fixture");
  change(title(), "");
  const save = modal.get((n) => n.type === "button" && n.props.className === "btn btn-primary");
  assert.equal(save.props.disabled, true); click(save); assert.equal(saves, 0);
  (modal.render().props.onClose as () => void)(); assert.equal(closed, 0);
  modal.confirm(true); (modal.render().props.onClose as () => void)(); assert.equal(closed, 1);
  const remove = () => modal.get((n) => n.type === "button" && n.props.className === "btn btn-danger");
  click(remove()); click(remove()); assert.equal(deletes, 1);
  (modal.render().props.onClose as () => void)(); assert.equal(closed, 1);
  resolveDelete({}); await settle();
});

test("dialog mutation failures remain visible inline and preserve form values for retry", async () => {
  const card = harness("web/src/Board.tsx", "NewCardModal", {
    boardCreateCard: async () => { throw new Error("Création refusée"); },
  }, { workspaceId: "fixture", onClose() {}, onCreated() {} });
  change(card.get((n) => n.type === "input"), "Carte à conserver");
  click(card.get((n) => n.type === "button")); await settle();
  assert.equal(card.get((n) => n.props.role === "alert").props.children, "Création refusée");
  assert.equal(card.get((n) => n.type === "input").props.value, "Carte à conserver");
  assert.equal(card.get((n) => n.type === "button").props.disabled, false);

  const conversation = harness("web/src/screens/Conversations.tsx", "NewConversationModal", {
    agents: async () => ({ agents: [{ id: "agent", name: "Agent" }] }),
    providers: async () => ({ providers: [] }), workspaces: async () => ({ workspaces: [] }),
    createConversation: async () => { throw new Error("Agent indisponible"); },
  }, { onClose() {}, onCreated() {} });
  conversation.render(); await settle();
  change(conversation.get((n) => n.type === "textarea"), "Consigne conservée");
  click(conversation.get((n) => n.type === "button")); await settle();
  assert.equal(conversation.get((n) => n.props.role === "alert").props.children, "Agent indisponible");
  assert.equal(conversation.get((n) => n.type === "textarea").props.value, "Consigne conservée");
  assert.equal(conversation.get((n) => n.type === "button").props.disabled, false);
});
