import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

function load(file: string, react: unknown = React, navigator: unknown = {}) {
  const exports: Record<string, React.ComponentType<Record<string, unknown>>> = {};
  const code = ts.transpileModule(readFileSync(`web/src/${file}.tsx`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(code, { exports, navigator, URL, require(name: string) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return runtime;
    if (name === "./icons") return load("icons");
    throw new Error(name);
  } });
  return exports;
}
const Markdown = load("markdown").Markdown!;
const ToolResult = load("ToolResult").ToolResult!;
const markdown = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { text }));
const tool = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(ToolResult, props));

test("Markdown keeps code inert, supports unfinished fences, and uses semantic reading blocks", () => {
  const html = markdown('# Titre\n## Sous-titre\n###### Détail\n> Citation\n\n- [x] Fait\n- [ ] À faire\n\n| Nom |\n| --- |\n| Valeur |\n\n```json\n{"kind":"form"}\n```\n~~~unknown\n<script>alert(1)</script>');
  assert.match(html, /<h2[^>]*>Titre/);
  assert.match(markdown('## Première section'), /<h2[^>]*>Première section/);
  assert.match(html, /<h3[^>]*>Sous-titre/);
  assert.doesNotMatch(html, /<h[1456]|<script>|<form/);
  assert.match(html, /<blockquote/);
  assert.match(html, /type="checkbox" disabled="" checked=""/);
  assert.match(html, /scope="col"/);
  assert.match(html, /Défilement horizontal/);
  assert.match(html, /Copier le code/);
  assert.match(html, /<pre[^>]*><code>/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /unknown/);
  assert.match(markdown('[oui](https://example.com) [non](javascript:alert)'), /href="https:\/\/example.com"/);
  assert.doesNotMatch(markdown('[non](javascript:alert)'), /href=/);
  assert.match(markdown('Texte en cours **incomplet'), /\*\*incomplet/);
});

test("ToolResult renders explicit states, complete results, JSON and requested diffs with raw args", () => {
  const args = JSON.stringify({ path: '/tmp/a', edits: [{ oldText: '<before>', newText: '<after>' }] });
  const html = tool({ name: 'edit', args, result: '{"ok":true}', state: 'done' });
  assert.match(html, /<details class="tool-chip done"/);
  assert.match(html, /<summary class="tool-head"/);
  assert.match(html, /Terminé/);
  assert.match(html, /&lt;before&gt;/);
  assert.match(html, /&lt;after&gt;/);
  assert.match(html, /Arguments bruts/);
  assert.match(html, /scope="row">ok/);
  assert.match(tool({ name: 'bash', args: '{"command":"pwd"}', result: 'partial', state: 'running' }), /En cours/);
  assert.match(tool({ name: 'read', args: '{broken', state: 'done', isError: true }), /Erreur/);
  assert.match(tool({ name: 'edit', args: '{"old_string":"old","new_string":"new"}', state: 'running' }), /diff-old/);
  const result = 'a'.repeat(50000) + 'END';
  assert.ok(tool({ name: 'read', result, state: 'done' }).includes(result));
  const nested = tool({ name: 'read', result: '{"nested":{"html":"<script>"}}', state: 'done' });
  assert.match(nested, /tool-result/);
  assert.doesNotMatch(nested, /<script>/);
});

test("copy waits for clipboard success and exposes a retry after failure", async () => {
  let state: unknown = 'idle';
  let fail = true;
  let copied = '';
  const component = load('markdown', { ...React, useState: () => [state, (value: unknown) => { state = value; }] }, {
    clipboard: { async writeText(text: string) { if (fail) throw new Error('denied'); copied = text; } },
  }).Markdown!;
  // Inspect the actual code block element, then execute its handler with a local hook double.
  type Element = React.ReactElement<Record<string, unknown>>;
  const root = (component as (props: { text: string }) => Element)({ text: '```js\nhello\n```' });
  const block = (root.props.children as Element[])[0]!;
  const render = () => (block.type as (props: unknown) => Element)(block.props);
  const button = () => {
    const header = (render().props.children as Element[])[0]!;
    return (header.props.children as Element[])[1]!;
  };
  const first = (button().props.onClick as () => Promise<void>)();
  assert.equal(state, 'pending');
  await first;
  assert.equal(state, 'error');
  assert.equal(button().props.children, 'Réessayer la copie');
  fail = false;
  await (button().props.onClick as () => Promise<void>)();
  assert.equal(state, 'done');
  assert.equal(copied, 'hello');
});
