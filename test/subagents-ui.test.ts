import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as i18n from "../web/src/i18n.js";

type Node = { type: unknown; props: Record<string, unknown> };
type Snapshot = { live: boolean; subagents: Array<{ id: string; label: string; model: string; status: string }> };

// Composant réel, doubles de hooks/API/horloge : aucune preuve navigateur ou fournisseur.
function harness() {
  const hooks: Array<{ value?: unknown; setter?: unknown; deps?: unknown[]; cleanup?: () => void }> = [];
  const effects: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  const requests: Array<{ id: string; signal: AbortSignal; resolve: (data: Snapshot) => void; reject: (error: Error) => void }> = [];
  const counts: number[] = [];
  const onCountChange = (count: number) => counts.push(count);
  let cursor = 0;
  let timerId = 0;
  const exports: { SubagentsPanel?: (props: unknown) => Node } = {};
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  const code = ts.transpileModule(readFileSync("web/src/SubagentsPanel.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(code, {
    exports, AbortController, Error,
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "./i18n") return i18n;
      if (name === "./ui") return { Empty: "Empty" };
      if (name === "./api") return { api: { conversationSubagents: (id: string, signal: AbortSignal) =>
        new Promise<Snapshot>((resolve, reject) => requests.push({ id, signal, resolve, reject })) } };
      if (name === "react") return {
        useState(initial: unknown) {
          const slot = hooks[cursor++] ??= { value: initial };
          slot.setter ??= (value: unknown) => { slot.value = typeof value === "function" ? value(slot.value) : value; };
          return [slot.value, slot.setter];
        },
        useEffect(effect: () => (() => void), deps: unknown[]) {
          const slot = hooks[cursor++] ??= {};
          if (slot.deps && deps.every((value, i) => value === slot.deps![i])) return;
          effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
          slot.deps = deps;
        },
      };
      throw new Error(name);
    },
  });
  function render(id = "a") {
    cursor = 0;
    const tree = exports.SubagentsPanel!({ conversationId: id, onCountChange });
    for (const effect of effects.splice(0)) effect();
    return tree;
  }
  const unmount = () => hooks.forEach((hook) => hook.cleanup?.());
  const poll = () => { const [id, callback] = timers.entries().next().value!; timers.delete(id); callback(); };
  return { render, requests, counts, timers, poll, unmount };
}

function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node !== "object") return String(node);
  return text((node as Node).props?.children);
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
const data: Snapshot = { live: true, subagents: [{ id: "child-a", label: "Inspect the build", model: "provider/model", status: "working" }] };

test("subagent panel: loading, model/status, visible refresh failure, explicit retry and recovery in both languages", async () => {
  for (const locale of ["en", "fr"] as const) {
    i18n.setLocale(locale);
    const ui = harness();
    assert.ok(text(ui.render()).includes(i18n.t("common.loading")));
    assert.ok(!text(ui.render()).includes(i18n.t("chat.noSubagents")));
    assert.equal(ui.requests.length, 1, "no overlapping request on re-render");
    ui.requests[0]!.resolve(data);
    await flush();
    const rendered = text(ui.render());
    for (const label of ["Inspect the build", "provider/model", i18n.t("chat.subagentWorking")]) assert.ok(rendered.includes(label));
    assert.equal(ui.counts.at(-1), 1);
    ui.poll();
    assert.equal(ui.timers.size, 0, "next poll waits for the active request");
    ui.requests[1]!.reject(new Error("HTTP 503"));
    await flush();
    const failed = ui.render();
    assert.ok(text(failed).includes(i18n.t("chat.subagentsRefreshError")));
    assert.ok(text(failed).includes("Inspect the build"), "last list remains visible with its stale warning");
    const alert = (failed.props.children as Node[]).find((node) => node?.props?.role === "alert")!;
    const button = (alert.props.children as Node[]).find((node) => node?.type === "button")!;
    (button.props.onClick as () => void)();
    ui.render();
    assert.equal(ui.requests.length, 3);
    assert.equal(ui.requests[1]!.signal.aborted, true);
    ui.requests[2]!.resolve({ live: true, subagents: [] });
    await flush();
    assert.ok(text(ui.render()).includes(i18n.t("chat.noSubagents")));
    assert.ok(!text(ui.render()).includes(i18n.t("chat.subagentsRefreshError")));
    ui.unmount();
    assert.equal(ui.timers.size, 0);
  }
});

test("subagent panel: changing conversations or closing aborts requests and ignores late responses", async () => {
  const ui = harness();
  ui.render("a");
  ui.render("b");
  assert.equal(ui.requests[0]!.signal.aborted, true);
  ui.requests[1]!.resolve({ live: false, subagents: [] });
  await flush();
  ui.requests[0]!.resolve(data);
  await flush();
  assert.ok(!text(ui.render("b")).includes("Inspect the build"));
  assert.ok(text(ui.render("b")).includes(i18n.t("chat.subagentsUnavailable")));
  ui.poll();
  ui.unmount();
  assert.equal(ui.requests[2]!.signal.aborted, true);
  ui.requests[2]!.resolve(data);
  await flush();
  assert.equal(ui.timers.size, 0, "closing does not restart polling");
  assert.equal(ui.counts.at(-1), 0);
});
