import * as i18n from "../web/src/i18n.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

i18n.setLocale("fr");

type Element = { type: unknown; props: Record<string, unknown> };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Execute the screen's real handlers without a browser or writes to local pi config.
function harness(screen: string, api: object, fetch?: unknown, component = "default") {
  const slots: unknown[] = [];
  let cursor = 0;
  let mounted = false;
  const effects: Array<() => void> = [];
  const exports: Record<string, (props: unknown) => Element> = {};
  const jsx = (type: unknown, props: Element["props"]): Element => ({ type, props });
  const source = readFileSync(`web/src/screens/${screen}.tsx`, "utf8") + (component === "default" ? "" : `\nexport { ${component} };`);
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, fetch, window: { location: { origin: "http://localhost:9876" } },
    setInterval: () => 0, clearInterval() {},
    require(name: string) {
      if (name === "./i18n" || name === "../i18n") return i18n;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react") return {
        useState(initial: unknown) {
          const index = cursor++;
          if (!(index in slots)) slots[index] = initial;
          return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
        },
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => void) => { if (!mounted) effects.push(effect); },
      };
      if (name === "../api") return { api };
      if (name === "../ui") return { Modal: "Modal", PageHead: "PageHead", ErrorText: "ErrorText", Field: "Field", useToast: () => () => {} };
      return {};
    },
  });
  return (props = {}) => {
    cursor = 0;
    const tree = exports[component]!(props);
    mounted = true;
    while (effects.length) effects.shift()!();
    return tree;
  };
}

function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) { const match = find(child, predicate); if (match) return match; }
    return;
  }
  const element = node as Element;
  return predicate(element) ? element : find(element.props?.children, predicate);
}

test("MCP save locks the submitted draft until the request settles", async () => {
  let finish!: (value: unknown) => void;
  const render = harness("Settings", { health: async () => ({ db: {} }) }, (_url: string, options?: { method?: string }) => {
    if (options?.method === "PUT") return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve({ ok: true, json: async () => ({ mcpServers: {} }) });
  });
  render(); await settle();
  assert.equal(find(render(), (e) => e.type === "textarea")?.props.readOnly, false);
  const save = find(render(), (e) => e.type === "button" && e.props.className === "btn btn-primary")!;
  (save.props.onClick as () => void)();
  assert.equal(find(render(), (e) => e.type === "textarea")?.props.readOnly, true);
  finish({ ok: true }); await settle();
  assert.equal(find(render(), (e) => e.type === "textarea")?.props.readOnly, false);
});

test("Cron creation waits for agent and workspace options", async () => {
  const render = harness("Cron", {
    schedules: async () => ({ schedules: [] }),
    agents: async () => ({ agents: [] }),
    workspaces: async () => ({ workspaces: [] }),
  });
  const action = (tree: Element) => find(tree, (e) => e.type === "PageHead")!.props.actions as Element;
  assert.equal(action(render()).props.disabled, true);
  await settle();
  assert.equal(action(render()).props.disabled, false);
});

test("quick model switch displays the saved model even when absent from the catalog", () => {
  const render = harness("Agents", {}, undefined, "QuickModel");
  const tree = render({
    agent: { id: "a", name: "Agent", provider: "custom", model: "legacy" },
    providers: [{ id: "custom", auth: { ready: true }, models: [{ id: "new-model" }] }],
    onChanged() {},
  });
  assert.ok(find(tree, (e) => e.type === "option" && e.props.value === "legacy"));
  assert.ok(find(tree, (e) => e.type === "option" && e.props.value === "new-model"));
});

test("folder picker explains an empty root and retains a named add action", async () => {
  const render = harness("Workspaces", {
    browse: async () => ({ path: "/", parent: null, entries: [] }),
  }, undefined, "AddWorkspaceModal");
  render(); await settle();
  const tree = render();
  assert.ok(find(tree, (e) => e.type === "p" && e.props.children === "Aucun sous-dossier. Tu peux ajouter le dossier actuel."));
  assert.ok(find(tree, (e) => e.type === "button" && e.props.children === "Ajouter /"));
});

test("API key failures remain visible inside the dialog and preserve the entered key", async () => {
  const render = harness("Providers", {
    updateProvider: async () => { throw new Error("Clé refusée"); },
  }, undefined, "KeyModal");
  const props = { providerId: "custom", onClose() {}, onSaved() { assert.fail("Must not close on failure"); } };
  const input = find(render(props), (e) => e.type === "input")!;
  (input.props.onChange as (event: unknown) => void)({ target: { value: "test-key" } });
  const save = find(render(props), (e) => e.type === "button")!;
  (save.props.onClick as () => void)();
  await settle();
  const tree = render(props);
  assert.equal(find(tree, (e) => e.type === "ErrorText")?.props.error, "Clé refusée");
  assert.equal(find(tree, (e) => e.type === "input")?.props.value, "test-key");
  assert.equal(find(tree, (e) => e.type === "button")?.props.disabled, false);
});

test("pending key request blocks dialog dismissal and editing, then exposes delayed failure", async () => {
  let reject!: (error: Error) => void;
  let closed = 0;
  const render = harness("Providers", {
    updateProvider: () => new Promise((_resolve, fail) => { reject = fail; }),
  }, undefined, "KeyModal");
  const props = { providerId: "custom", onClose() { closed++; }, onSaved() { assert.fail("Failed writes must not close"); } };
  const change = find(render(props), (e) => e.type === "input")!.props.onChange as (event: unknown) => void;
  change({ target: { value: "test-key" } });
  (find(render(props), (e) => e.type === "button" && e.props.className === "btn btn-primary")!.props.onClick as () => void)();
  const pending = render(props);
  // Escape, backdrop and X all invoke this Modal callback.
  const close = find(pending, (e) => e.type === "Modal")!.props.onClose as () => void;
  close(); close(); close();
  assert.equal(closed, 0);
  assert.equal(find(pending, (e) => e.type === "fieldset" && e.props.className === "form-fields")?.props.disabled, true);
  assert.equal(find(pending, (e) => e.type === "button" && e.props.children === "Annuler")?.props.disabled, true);
  reject(new Error("Échec différé")); await settle();
  const failed = render(props);
  assert.equal(find(failed, (e) => e.type === "ErrorText")?.props.error, "Échec différé");
  assert.equal(find(failed, (e) => e.type === "fieldset")?.props.disabled, false);
  (find(failed, (e) => e.type === "Modal")!.props.onClose as () => void)();
  assert.equal(closed, 1);
});
