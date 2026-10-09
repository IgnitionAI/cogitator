import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { diagnosticMessages } from "../web/src/locales/diagnostics.js";
import { getLocale, localizeText, setLocale } from "../web/src/i18n.js";
import { agentInputSchema, boardCardSchema, messageSchema, providerUpsertSchema } from "../src/schemas.js";
import { parseUI, serializeUIResponse, type UISpec } from "../src/generative-ui.js";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
const sample = (text: string) => text.replace(/\{(\w+)\}/g, (_, name: string) => `sample_${name}`);

// Both source languages must remain recognizable after a stored error/toast has
// already been displayed once; captures must survive the reverse translation.
test("diagnostic catalogs have matching placeholders and translate in both directions", () => {
  const previous = getLocale();
  try {
    for (const [key, entry] of Object.entries(diagnosticMessages)) {
      assert.deepEqual(placeholders(entry.fr), placeholders(entry.en), key);
      for (const locale of ["en", "fr"] as const) {
        setLocale(locale);
        for (const source of ["en", "fr"] as const) {
          assert.equal(localizeText(sample(entry[source])), sample(entry[locale]), `${key}: ${source} -> ${locale}`);
        }
      }
    }
  } finally { setLocale(previous); }
});

test("owned diagnostics preserve paths, labels, IDs, technical bounds and external tails", () => {
  const previous = getLocale();
  try {
    const cases = [
      ["dossier introuvable: /tmp/agent introuvable/a:b", "directory not found: /tmp/agent introuvable/a:b"],
      ["Erreur: agent introuvable", "Error: agent not found"],
      ["Erreur: timeout d'attente de fin d'agent (900000ms)", "Error: timeout waiting for agent to finish (900000ms)"],
      ["gh issue edit a échoué: HTTP 403: Forbidden\nrequest-id: abc", "gh issue edit failed: HTTP 403: Forbidden\nrequest-id: abc"],
      ["gh issue create a échoué: agent introuvable", "gh issue create failed: agent introuvable"],
      ["commande exécutée mais aucun skill nouveau détecté — sortie: stderr: ENOENT | npm ERR!", "command executed but no new skill detected — output: stderr: ENOENT | npm ERR!"],
      ["subagent worker-1: modèle o3-mini inconnu pour openai", "subagent worker-1: unknown model o3-mini for openai"],
      ["provider custom-api: auth non prête (pi auth check)", "provider custom-api: auth not ready (pi auth check)"],
      ["agent introuvable : valeur requise", "agent introuvable: value required"],
      ["run 123e4567 encore actif (policy skip)", "run 123e4567 still active (policy skip)"],
      ["extension non affichable en texte: (aucune)", "extension cannot be displayed as text: (none)"],
      ["Trop grand : array doit contenir <=8 éléments", "Too big: expected array to have <=8 items"],
    ];
    for (const [fr, en] of cases) {
      setLocale("en");
      assert.equal(localizeText(fr!), en);
      setLocale("fr");
      assert.equal(localizeText(en!), fr);
    }
    for (const locale of ["en", "fr"] as const) {
      setLocale(locale);
      for (const unknown of [
        "ENOENT: no such file or directory, open '/tmp/a'",
        "HTTP 429: provider-specific limit 9876",
        "My note says agent introuvable but it is user text.",
        'const diagnostic = "agent introuvable";',
        "# User transcript\nagent introuvable\nKeep my text.",
      ]) assert.equal(localizeText(unknown), unknown);
    }
  } finally { setLocale(previous); }
});

test("all application-owned schema messages have exact diagnostic catalog entries", () => {
  const known = new Set<string>(Object.values(diagnosticMessages).flatMap((entry) => [entry.fr, entry.en]));
  const schemas = readFileSync(new URL("../src/schemas.ts", import.meta.url), "utf8");
  for (const match of schemas.matchAll(/(?:message:\s*|\.(?:min|max|regex)\([^,\n]+,\s*)"([^"]+)"/g)) {
    assert.ok(known.has(match[1]!), `missing schema diagnostic: ${match[1]}`);
  }
});

test("real API schema error arrays localize every message without discarding validation detail", () => {
  const previous = getLocale();
  try {
    setLocale("fr");
    const results = [
      agentInputSchema.safeParse({ name: "", provider: 7, model: "", thinking: "bogus", mcp_servers: [{ name: "bad space" }] }),
      boardCardSchema.safeParse({ title: "", labels: Array(9).fill("x"), status: "bogus", github_issue: 1.5 }),
      messageSchema.safeParse({ images: [{ type: "text", data: "", mimeType: "text/plain" }] }),
      providerUpsertSchema.safeParse({ id: "UPPER", baseUrl: "bad-url" }),
    ];
    for (const result of results) {
      assert.equal(result.success, false);
      if (result.success) continue;
      for (const issue of result.error.issues) {
        const translated = localizeText(issue.message);
        if (!/[éèà]|requis|uniquement|minuscules/.test(issue.message)) assert.notEqual(translated, issue.message, issue.message);
        setLocale("en");
        const english = localizeText(translated);
        setLocale("fr");
        assert.equal(localizeText(english), translated);
      }
    }
  } finally { setLocale(previous); }
});

test("shared UI validation localizes its wrapper, never its authored field label", () => {
  const previous = getLocale();
  try {
    setLocale("en");
    const invalid = parseUI("{");
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(localizeText(invalid.error), "Invalid JSON.");
    const form: UISpec = { version: 1, id: "test", kind: "form", title: "User title", fields: [{ id: "field", label: "agent introuvable", type: "number", required: true }] };
    assert.throws(() => serializeUIResponse(form, {}), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(localizeText(error.message), "agent introuvable: value required");
      setLocale("fr");
      assert.equal(localizeText("agent introuvable: value required"), error.message);
      return true;
    });
  } finally { setLocale(previous); }
});
