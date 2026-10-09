import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { api } from "../web/src/api.js";
import {
  formatDate, formatNumber, formatTime, getLocale, interpolate, localizeText,
  messages, resolveLocale, setLocale, statusLabel, t, thinkingLabel,
} from "../web/src/i18n.js";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("every interface message has matching nonempty English/French translations and parameters", () => {
  assert.ok(Object.keys(messages).length > 300, "covers the entire interface, not only navigation");
  for (const [key, message] of Object.entries(messages)) {
    assert.ok(message.fr.trim(), `${key}: French`);
    assert.ok(message.en.trim(), `${key}: English`);
    assert.deepEqual(placeholders(message.en), placeholders(message.fr), `${key}: parameters`);
    const values = Object.fromEntries(placeholders(message.fr).map((name) => [name!, `VALUE_${name}`]));
    for (const locale of ["en", "fr"] as const) {
      setLocale(locale);
      assert.equal(t(key as keyof typeof messages, values), interpolate(message[locale], values));
    }
  }
});

test("locale resolution validates saved preferences and negotiates browser languages", () => {
  assert.equal(resolveLocale("fr", ["en-US"]), "fr");
  assert.equal(resolveLocale("en", ["fr-FR"]), "en");
  assert.equal(resolveLocale(null, ["fr-CA", "en"]), "fr");
  assert.equal(resolveLocale("invalid", ["de-DE", "en-GB", "fr"]), "en");
  assert.equal(resolveLocale(null, ["de-DE", "fr-FR"]), "fr");
  assert.equal(resolveLocale(null, []), "en");
  setLocale("fr");
  setLocale("invalid" as "en");
  assert.equal(getLocale(), "fr");
});

test("Intl dates, numbers and enum labels follow the selected language without changing data", () => {
  const date = "2026-05-02T15:04:05Z";
  for (const locale of ["fr", "en"] as const) {
    setLocale(locale);
    assert.equal(formatNumber(12345.6), new Intl.NumberFormat(locale).format(12345.6));
    assert.equal(formatNumber(0.00012345), locale === "fr" ? "0,00012345" : "0.00012345");
    assert.equal(formatNumber(1.2345678901234567), locale === "fr" ? "1,2345678901234567" : "1.2345678901234567");
    assert.equal(formatNumber(1.23456, { maximumFractionDigits: 2 }), locale === "fr" ? "1,23" : "1.23");
    assert.equal(formatDate(date, { dateStyle: "long", timeZone: "UTC" }), new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(date)));
    assert.equal(formatTime(date, { hour: "numeric", timeZone: "UTC" }), new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone: "UTC" }).format(new Date(date)));
    assert.equal(formatDate("invalid"), "—");
    assert.equal(statusLabel("running"), locale === "fr" ? "En cours" : "Running");
    assert.equal(thinkingLabel("high"), locale === "fr" ? "Élevé" : "High");
    assert.ok(statusLabel("future-state").includes("future-state"));
  }
  assert.equal(date, "2026-05-02T15:04:05Z");
});

test("interpolation preserves literal user values and stored notifications can change language", () => {
  assert.equal(interpolate("Hello {name}", { name: "$& <script>{other}</script>" }), "Hello $& <script>{other}</script>");
  setLocale("fr");
  const notification = t("common.refreshAgentsError", { error: "JSON invalide" });
  setLocale("en");
  assert.match(localizeText(notification), /Could not refresh agents/);
  assert.ok(!localizeText(notification).includes("JSON invalide"));
  const raw = "external-provider: opaque diagnostic 0xF00";
  assert.equal(localizeText(raw), raw);
  const cron = t("common.cronFinished", { name: "Mon projet", status: statusLabel("ok") });
  setLocale("fr");
  assert.equal(localizeText(cron), "Mon projet : exécution Réussie");
});

test("API validation keeps field details and translates the complete displayed error", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "entrée invalide", issues: ["name: name requis", "mcp_servers.0.name: lettres, chiffres, _ et - uniquement", 7] }), { status: 400 });
  try {
    await assert.rejects(api.health(), (error: unknown) => {
      assert.ok(error instanceof Error);
      setLocale("en");
      assert.equal(localizeText(error.message), "invalid input\nname: name required\nmcp_servers.0.name: letters, digits, _ and - only");
      setLocale("fr");
      assert.equal(localizeText(error.message), "entrée invalide\nname: name requis\nmcp_servers.0.name: lettres, chiffres, _ et - uniquement");
      return true;
    });
  } finally { globalThis.fetch = fetch; }
});

// UI-owned literals belong in catalogs. Technical examples and brand names are
// explicit exceptions; user/API content remains dynamic and is never rewritten.
const literalExceptions = new Set([
  "Cogitator", "Cogita", "tor", "Français", "English",
  "W", "E", "MCP", "JSON", "ID", "API", "OAuth", "HTTP", "pi",
  "IgnitionAI/skills", "pi-mcp-adapter", "(v", "~/.cogitator", "~/.pi/agent/mcp.json",
  "ollama", "http://localhost:11434/v1", "qwen3, llama3.1", "sk-…",
  "read, bash, edit, write", "https://github.com/org/repo/tree/main/skills/mon-skill", "0 9 * * *",
]);

test("JSX copy and accessible text use catalogs rather than hardcoded prose", () => {
  const failures: string[] = [];
  const dirs = ["web/src", "web/src/screens"];
  for (const dir of dirs) for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx"))) {
    const path = `${dir}/${file}`;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const check = (node: ts.Node, text: string) => {
      const clean = text.replace(/\s+/g, " ").trim();
      if (!/[\p{L}]/u.test(clean) || literalExceptions.has(clean)) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${path}:${line + 1}: ${clean}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) check(node, node.text);
      if (ts.isJsxAttribute(node) && /^(aria-label|title|placeholder|label|hint|alt)$/.test(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) check(node, node.initializer.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(failures, []);
  for (const file of ["web/src/styles.css", "web/src/chat.css"]) {
    const css = readFileSync(file, "utf8");
    assert.deepEqual([...css.matchAll(/content:\s*["']([^"']*[\p{L}][^"']*)["']/gu)].map((match) => match[1]), [], file);
  }
});
