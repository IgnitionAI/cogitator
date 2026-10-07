import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Element = { type: unknown; props: Record<string, unknown> };
type ReadApi = Record<string, () => Promise<unknown>>;
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Run the real component with local hooks and read-only API doubles; no backend requests.
function workspaceHarness(api: ReadApi) {
  const slots: unknown[] = [];
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  let cursor = 0;
  let effectCursor = 0;
  const queued: Array<() => void> = [];
  const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
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
    useId: () => "tabs",
    useCallback(callback: unknown, deps: unknown[]) {
      const index = cursor++;
      const previous = slots[index] as { callback: unknown; deps: unknown[] } | undefined;
      if (!previous || !same(previous.deps, deps)) slots[index] = { callback, deps };
      return (slots[index] as { callback: unknown }).callback;
    },
    useEffect(callback: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectCursor++;
      if (!effects[index] || !same(effects[index].deps, deps)) queued.push(() => {
        effects[index]?.cleanup?.();
        effects[index] = { deps, cleanup: callback() };
      });
    },
  };
  const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
  const exports: { default?: (props: unknown) => Element } = {};
  runInNewContext(ts.transpileModule(readFileSync("web/src/WorkspacePage.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "./api") return { api: new Proxy(api, { get(target, key: string) {
        assert.ok(key in target, `Unexpected API call: ${key}`);
        return target[key];
      } }) };
      if (name === "./ui") return { useToast: () => () => {}, statusColor: () => "", Empty: "Empty" };
      if (name === "./FeedList") return { FeedList: "FeedList" };
      if (name === "./FileViews") return { FileRow: "FileRow" };
      return {};
    },
  });
  function render() {
    cursor = effectCursor = 0;
    const tree = exports.default!({ workspace: { id: "w", name: "Test", dir: "/test" }, agents: [], onBack() {}, onOpenConversation() {} });
    while (queued.length) queued.shift()!();
    return tree;
  }
  function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) { const found = find(child, predicate); if (found) return found; }
      return;
    }
    const element = node as Element;
    return predicate(element) ? element : find(element.props?.children, predicate);
  }
  const click = (element: Element) => (element.props.onClick as () => void)();
  const select = (id: string) => {
    click(find(render(), (element) => element.props.id === `tabs-tab-${id}`)!);
    render(); // Commit the tab switch and its effect cleanup before resolving requests.
  };
  return { render, find, click, select, alert: () => find(render(), (element) => element.props.role === "alert") };
}

test("workspace tabs isolate reads and failures; team requires both dependencies and can retry", async () => {
  let boardFails = true;
  let conversationsFail = false;
  let activityFails = true;
  const calls: string[] = [];
  const api: ReadApi = {
    workspaceActivity: async () => { calls.push("activity"); if (activityFails) throw new Error("header offline"); return { files: [{ path: "a.ts" }], totals: {} }; },
    workspaceFeed: async () => { calls.push("feed"); return { events: [{ path: "feed.ts" }] }; },
    conversations: async () => { calls.push("conversations"); if (conversationsFail) throw new Error("conversations offline"); return { conversations: [{ id: "c", title: "Session", updated_at: "2026-01-01" }] }; },
    board: async () => { calls.push("board"); if (boardFails) throw new Error("board offline"); return { cards: [] }; },
  };
  const page = workspaceHarness(api);
  page.render(); await settle();
  assert.deepEqual(calls, ["activity"]); // BoardPanel owns board reads; header is optional.
  page.select("feed"); await settle();
  assert.ok(page.find(page.render(), (element) => element.type === "FeedList"));
  assert.equal(page.alert(), undefined);
  page.select("conversations"); await settle();
  assert.ok(page.find(page.render(), (element) => element.type === "h4" && element.props.children === "Session"));
  activityFails = false;
  page.select("activity"); await settle();
  assert.ok(page.find(page.render(), (element) => element.type === "FileRow"));
  assert.equal(calls.includes("board"), false);
  page.select("team"); await settle();
  assert.equal(page.alert()?.props.children && (page.alert()!.props.children as unknown[])[0], "board offline");
  boardFails = false;
  page.click(page.find(page.render(), (element) => element.type === "button" && element.props.children === "Réessayer")!);
  page.render(); await settle();
  assert.equal(page.alert(), undefined);
  conversationsFail = true;
  page.select("feed"); await settle();
  page.select("team"); await settle();
  assert.equal((page.alert()!.props.children as unknown[])[0], "conversations offline");
  page.select("feed"); await settle();
  assert.equal(page.alert(), undefined);
});

test("late errors from a previous tab cannot overwrite the selected tab", async () => {
  let rejectFeed!: (error: Error) => void;
  const page = workspaceHarness({
    workspaceActivity: async () => ({ files: [], totals: {} }),
    workspaceFeed: () => new Promise((_resolve, reject) => { rejectFeed = reject; }),
    conversations: async () => ({ conversations: [{ id: "c", title: "Current", updated_at: "2026-01-01" }] }),
  });
  page.render(); await settle();
  page.select("feed");
  page.select("conversations"); await settle();
  rejectFeed(new Error("stale failure")); await settle();
  assert.equal(page.alert(), undefined);
  assert.ok(page.find(page.render(), (element) => element.type === "h4" && element.props.children === "Current"));
  assert.equal(page.find(page.render(), (element) => element.props.role === "status"), undefined);
});
