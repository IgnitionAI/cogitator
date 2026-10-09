import * as i18n from "../web/src/i18n.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as contract from "../src/generative-ui.js";
import { parseUI, parseUIResponse, serializeUIResponse, splitUIBlocks, uiRequestKey, type UISpec, type UIResponse } from "../src/generative-ui.js";

i18n.setLocale("fr");

const form: UISpec = { version: 1, id: "step", kind: "form", title: "Projet", fields: [
  { id: "name", label: "Nom", type: "text", required: true },
  { id: "notes", label: "Notes", type: "textarea" },
  { id: "count", label: "Quantité", type: "number" },
  { id: "color", label: "Couleur", type: "select", options: [{ id: "blue", label: "Bleu" }] },
] };
const choices: UISpec = { version: 1, id: "step", kind: "choices", title: "Choix", options: [{ id: "yes", label: "Oui", description: "Continuer" }] };
const checklist: UISpec = { version: 1, id: "step", kind: "checklist", title: "Liste", items: [{ id: "first", label: "Premier" }] };
const table: UISpec = { version: 1, id: "step", kind: "table", title: "Tableau", columns: [{ id: "name", label: "Nom" }, { id: "count", label: "Nombre" }], rows: [{ name: "Item", count: 2 }, { name: null, count: false }] };
const parse = (value: unknown) => parseUI(JSON.stringify(value));

test("strict bounded discriminated schema accepts all four catalog entries", () => {
  for (const spec of [form, choices, checklist, table]) assert.equal(parse(spec).ok, true);
  assert.equal(parseUI("{").ok, false);
  for (const extra of [{ url: "javascript:alert(1)" }, { action: "delete" }, { style: {} }, { html: "<script/>" }, { version: 2 }, { kind: "html" }]) assert.equal(parse({ ...form, ...extra }).ok, false);
  for (const type of ["password", "email", "hidden", "date"]) assert.equal(parse({ ...form, fields: [{ id: "secret", label: "Secret", type }] }).ok, false);
  assert.equal(parse({ ...form, fields: [{ id: "x", label: "X", type: "text", options: [] }] }).ok, false);
  assert.equal(parse({ ...form, fields: [{ id: "x", label: "X", type: "select" }] }).ok, false);
  assert.equal(parse({ ...form, fields: [form.fields[0], form.fields[0]] }).ok, false);
  assert.equal(parse({ ...form, fields: Array.from({ length: 21 }, (_, i) => ({ id: `x${i}`, label: "X", type: "text" })) }).ok, false);
  assert.equal(parse({ ...choices, options: Array.from({ length: 51 }, (_, i) => ({ id: `x${i}`, label: "X" })) }).ok, false);
  assert.equal(parse({ ...table, rows: Array.from({ length: 201 }, () => ({ name: "X", count: 1 })) }).ok, false);
  assert.equal(parse({ ...form, title: "x".repeat(201) }).ok, false);
  assert.equal(parse({ ...form, description: "x".repeat(2001) }).ok, false);
  assert.equal(parseUI(" ".repeat(65537)).ok, false);
  assert.equal(parseUI("é".repeat(32769)).ok, false);
  assert.equal(parse({ ...table, rows: Array.from({ length: 20 }, () => ({ name: "x".repeat(4000), count: 1 })) }).ok, false);
});

test("rejects dangerous keys, malformed tables and non-finite numbers", () => {
  for (const id of ["__proto__", "constructor", "prototype", "a.b", "x x"]) assert.equal(parse({ ...form, id }).ok, false);
  assert.equal(parseUI('{"version":1,"id":"x","kind":"form","title":"X","fields":[],"__proto__":{}}').ok, false);
  for (const rows of [[{ name: "X" }], [{ name: "X", count: 1, extra: 2 }], [{ name: {}, count: 1 }]]) assert.equal(parse({ ...table, rows }).ok, false);
  assert.equal(parseUI(JSON.stringify(table).replace('"count":2', '"count":1e400')).ok, false);
});

test("responses validate against exact request and round-trip the whole envelope only", () => {
  const source = serializeUIResponse(form, { name: "Projet", count: 0, color: "blue", notes: "```\n<script>alert(1)</script>" });
  const response = parseUIResponse(source);
  assert.ok(response);
  assert.equal(response.values.count, 0);
  const parsed = parse(form);
  assert.ok(parsed.ok);
  assert.equal(uiRequestKey(response.request), uiRequestKey(parsed.value));
  assert.notEqual(uiRequestKey(response.request), uiRequestKey({ ...response.request, title: "Autre" }));
  for (const text of ["Préface\n" + source, source + "\nAutre", "```text\n" + source + "\n```", source.replace("Réponse à", "Autre à"), source.repeat(2), "```cogitator-response\n{}\n```", source.slice(0, -3)]) assert.equal(parseUIResponse(text), null);
  assert.equal(parseUIResponse(source.replace('"count":0', '"count":1e400')), null);
  assert.equal(parseUIResponse(source.replace('"values":{', '"unknown":true,"values":{')), null);
  for (const values of [{}, { name: " " }, { name: 1 }, { name: "X", extra: "Y" }, { name: "X", count: "3" }, { name: "X", count: "" }, { name: "X", color: "" }, { name: "X", count: Infinity }, { name: "X", color: "red" }, { name: "x".repeat(4001) }]) assert.throws(() => serializeUIResponse(form, values));
  assert.throws(() => serializeUIResponse(table, {}));
  assert.ok(parseUIResponse(serializeUIResponse(choices, { selection: "yes" })));
  assert.ok(parseUIResponse(serializeUIResponse(checklist, { selection: [] })));
  for (const values of [{ selection: "no" }, { selection: ["yes"] }, { selection: "yes", extra: true }]) assert.throws(() => serializeUIResponse(choices, values));
  for (const selection of [["no"], ["first", "first"], "first", false]) assert.throws(() => serializeUIResponse(checklist, { selection }));
});

test("extracts exact top-level UI fences, never executable code nested in ordinary fences", () => {
  const block = '```cogitator-ui\n{"version":1}\n```';
  assert.deepEqual(splitUIBlocks(`Before\n${block}\nAfter`), [{ kind: "markdown", text: "Before\n" }, { kind: "ui", source: '{"version":1}', complete: true }, { kind: "markdown", text: "After" }]);
  assert.deepEqual(splitUIBlocks('```cogitator-ui\n{"ver'), [{ kind: "ui", source: '{"ver', complete: false }]);
  assert.deepEqual(splitUIBlocks("```cogitator-ui"), [{ kind: "ui", source: "", complete: false }]);
  for (const text of [`\`\`\`\`markdown\n${block}\n\`\`\`\``, `~~~text\n${block}\n~~~`, `\`\`\`js\n${block}\n\`\`\``, block.replace("cogitator-ui", "cogitator-ui extra"), block.replace("cogitator-ui", "cogitator-ui "), block.split("\n").map((line) => "    " + line).join("\n"), block.split("\n").map((line) => "> " + line).join("\n")]) assert.ok(splitUIBlocks(text).every((entry) => entry.kind === "markdown"), text);
  assert.equal(splitUIBlocks(block.replaceAll("\n", "\r\n"))[0]?.kind, "ui");
});

// Compile the real browser module with its own JSX mode; root tsconfig is server-only.
const require = createRequire(import.meta.url);
const componentExports: {
  GenerativeUI: ComponentType<{ source: string; complete: boolean; disabled?: boolean; response?: UIResponse; onSubmit: (text: string) => Promise<void> }>;
  UIResponseSummary: ComponentType<{ response: UIResponse }>;
} = {} as typeof componentExports;
runInNewContext(ts.transpileModule(readFileSync("web/src/GenerativeUI.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
  exports: componentExports,
  require: (name: string) => name === "./i18n" ? i18n : name === "../../src/generative-ui" ? contract : require(name),
});
const render = (spec: unknown, props: { complete?: boolean; response?: UIResponse; disabled?: boolean } = {}) => renderToStaticMarkup(createElement(componentExports.GenerativeUI, { source: JSON.stringify(spec), complete: true, onSubmit: async () => {}, ...props }));

test("React SSR renders accessible catalog controls, escaped content, and noninteractive incomplete state", () => {
  const html = render(form);
  assert.match(html, /<fieldset/);
  assert.match(html, /<legend>Ta réponse/);
  assert.match(html, /type="number"/);
  assert.match(html, /<textarea/);
  assert.match(html, /<select/);
  assert.match(html, /Transmettre à l’agent/);
  assert.match(html, /Ne saisis aucun secret/);
  assert.match(render(choices), /type="radio"/);
  assert.match(render(checklist), /type="checkbox"/);
  assert.match(render(table), /aria-sort="none"/);
  assert.match(render(table), /type="search"/);
  assert.doesNotMatch(render(table), /type="submit"/);
  assert.match(render(form, { disabled: true }), /<fieldset disabled=""/);
  const incomplete = render(form, { complete: false, streaming: true });
  assert.match(incomplete, /Préparation/);
  assert.doesNotMatch(incomplete, /<input|<button|<form/);
  const interrupted = render(form, { complete: false, streaming: false });
  assert.match(interrupted, /bloc JSON est incomplet/);
  assert.match(interrupted, /Transmettre à l’agent/);
  assert.doesNotMatch(interrupted, /Préparation/);
  const invalid = render({ ...form, action: "execute" });
  assert.match(invalid, /Interface non disponible/);
  assert.match(invalid, /source JSON/i);
  assert.doesNotMatch(invalid, /<form/);
  const malicious = render({ ...form, title: "<script>alert(1)</script>" });
  assert.doesNotMatch(malicious, /<script>/);
  assert.match(malicious, /&lt;script&gt;/);
});

test("React SSR rehydrates only matching submissions as read-only summaries", () => {
  const response = parseUIResponse(serializeUIResponse(form, { name: "<img src=x onerror=alert(1)>", color: "blue" }));
  assert.ok(response);
  const submitted = render(form, { response });
  assert.match(submitted, /Transmis à l’agent/);
  assert.match(submitted, /Bleu/);
  assert.doesNotMatch(submitted, /<form|<input|<img/);
  assert.match(submitted, /&lt;img/);
  assert.match(render({ ...form, title: "Changed", id: form.id }, { response }), /<form/);
});
