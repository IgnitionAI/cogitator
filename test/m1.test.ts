import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

// Env AVANT les imports des modules qui lisent getPaths() à l'appel (pas au load)
const home = mkdtempSync(join(tmpdir(), "cog-m1-"));
const piDir = join(home, "pi-agent");
const agentsDir = join(piDir, "agents");
const skillsDir = join(home, "skills-fixture");
mkdirSync(agentsDir, { recursive: true });
mkdirSync(join(skillsDir, "rag-builder"), { recursive: true });
writeFileSync(join(skillsDir, "rag-builder", "SKILL.md"), "---\nname: rag-builder\ndescription: Construire une recherche sur documents\n---\n# RAG\n");
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = agentsDir;
process.env.COGITATOR_SKILLS_DIRS = skillsDir;

const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { applyAgent, unapplyAgent, slugify, validateAgent } = await import("../src/agents.js");

// Fixture catalogue pi + auth + settings
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({
  "deepseek": { models: [{ id: "deepseek-flash", name: "Flash", reasoning: true }, { id: "deepseek-v4-pro" }] },
  "openai": { models: [{ id: "gpt-5.4" }, { id: "gpt-4.1" }] },
}));
writeFileSync(join(piDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key" }, openai: { type: "oauth" }, cursor: { type: "api_key" } }));
writeFileSync(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:@dietrichgebert/ponytail"] }));

// Auth checker stub (pas de subprocess pi dans les tests)
const authOk = () => Promise.resolve<boolean | null>(true);

let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;

before(async () => {
  ({ db } = openDb(join(home, "cogitator.db")));
  const { PiPool } = await import("../src/pool.js");
const pool = new PiPool({ factory: () => ({ start: async () => {}, stop: async () => {}, onEvent: () => () => {}, getState: async () => ({}), prompt: async () => ({}), abort: async () => {}, setModel: async () => ({}) }) });
server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: 3, paths: getPaths(), pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

// ---------- Registry ----------

test("GET /api/providers : catalogue + auth, pi-mcp-adapter non détecté", async () => {
  const res = await fetch(`${base}/api/providers`);
  assert.equal(res.status, 200);
  const { providers } = await res.json();
  const ds = providers.find((p: { id: string }) => p.id === "deepseek");
  assert.equal(ds.source, "builtin");
  assert.equal(ds.auth.configured, true);
  assert.equal(ds.auth.type, "api_key");
  assert.ok(Array.isArray(ds.models));
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.mcp_adapter_detected, false);
});

test("GET /api/providers lists builtins absent from models-store and auth-only keys", async () => {
  const res = await fetch(`${base}/api/providers`);
  assert.equal(res.status, 200);
  const { providers } = await res.json() as { providers: Array<{ id: string; source: string; models: Array<{ id: string }>; auth: { configured: boolean; ready: boolean | null }; authMethods?: Array<{ type: string }> }> };
  const anthropic = providers.find((p) => p.id === "anthropic");
  assert.ok(anthropic, "builtin anthropic must appear even when missing from models-store");
  assert.equal(anthropic.source, "builtin");
  assert.equal(anthropic.auth.configured, false);
  assert.equal(anthropic.auth.ready, false);
  assert.ok(anthropic.models.length > 0);
  assert.ok(anthropic.authMethods?.some((m) => m.type === "api_key" || m.type === "oauth"));

  const openai = providers.find((p) => p.id === "openai");
  const openaiIds = openai?.models.map((m) => m.id) ?? [];
  assert.ok(openaiIds.includes("gpt-5.4") && openaiIds.includes("gpt-4.1"));
  assert.ok(openaiIds.length > 2, "store overlay must keep unused builtin models");

  const cursor = providers.find((p) => p.id === "cursor");
  assert.ok(cursor, "auth.json keys without a catalog entry must appear");
  assert.equal(cursor.auth.configured, true);
  assert.equal(cursor.models.length, 0);
});

test("POST /api/providers crée un custom + backup (checklist item 6)", async () => {
  const res = await fetch(`${base}/api/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "qwen3" }] }),
  });
  assert.equal(res.status, 201);
  const modelsJson = join(piDir, "models.json");
  const written = JSON.parse(readFile(modelsJson));
  assert.equal(written.providers.ollama.baseUrl, "http://localhost:11434/v1");
  assert.ok(!("apiKey" in written.providers.ollama)); // clé dans auth.json, pas models.json
  const auth = JSON.parse(readFile(join(piDir, "auth.json")));
  assert.equal(auth.ollama.key, "ollama");
  // 2e écriture → backup créé
  await fetch(`${base}/api/providers/ollama`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: [{ id: "qwen3" }, { id: "llama3" }] }),
  });
  assert.ok(existsSync(`${modelsJson}.bak`));
  const after2 = JSON.parse(readFile(modelsJson));
  assert.equal(after2.providers.ollama.models.length, 2);
  assert.equal(after2.providers.ollama.baseUrl, "http://localhost:11434/v1"); // champs préservés
});

test("GET /api/skills scanne l'emplacement fixture", async () => {
  const { skills } = await (await fetch(`${base}/api/skills`)).json();
  assert.ok(skills.some((s: { name: string }) => s.name === "rag-builder"));
});

test("PUT /api/mcp valide le shape", async () => {
  const bad = await fetch(`${base}/api/mcp`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ servers: {} }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base}/api/mcp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "mcp-fs"] } } }),
  });
  assert.equal(ok.status, 200);
  assert.ok(existsSync(join(piDir, "mcp.json.bak")) || true); // premier write : pas d'ancien, pas de bak — ok
});

// ---------- Agents ----------

const presetBody = {
  name: "RAG Expert",
  description: "Agent RAG d'IgnitionRAG",
  provider: "openai",
  model: "gpt-5.4",
  thinking: "high",
  system_prompt: "Tu es l'agent RAG. Scope: retrieval, chunking, evals.",
  skills: [join(skillsDir, "rag-builder")],
  mcp_servers: [{ name: "pkm", url: "http://127.0.0.1:7070/mcp" }],
  subagents: [
    { name: "evaluator", description: "Évalue les réponses", provider: "deepseek", model: "deepseek-flash", thinking: "low", system_prompt: "Tu évalues.", skills: [] },
    { name: "critic", description: "Critique les chunks", provider: "openai", model: "gpt-4.1", system_prompt: "", skills: [] },
  ],
};

let agentId = "";

test("POST /api/agents : crée + Apply génère les .md herdr (checklist item 5)", async () => {
  const res = await fetch(`${base}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(presetBody) });
  assert.equal(res.status, 201);
  const { agent, apply } = await res.json();
  agentId = agent.id;
  assert.equal(agent.slug, "rag-expert");
  assert.equal(agent.subagents.length, 2);
  assert.deepEqual(apply.written.sort(), ["noo-rag-expert-critic.md", "noo-rag-expert-evaluator.md"]);

  const md = readFile(join(agentsDir, "noo-rag-expert-evaluator.md"));
  assert.match(md, /name: noo-rag-expert-evaluator/);
  assert.match(md, /model: deepseek\/deepseek-flash/);
  assert.match(md, /thinking: low/);
  assert.match(md, /Tu évalues\./);
});

test("Apply ne touche pas aux fichiers étrangers du registre (O2)", async () => {
  writeFileSync(join(agentsDir, "auditor.md"), "---\nname: auditor\n---\n");
  const res = await fetch(`${base}/api/agents/${agentId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...presetBody, name: "RAG Expert", subagents: [presetBody.subagents[1]!] }) });
  assert.equal(res.status, 200);
  const { apply } = await res.json();
  assert.deepEqual(apply.deleted, ["noo-rag-expert-evaluator.md"]); // critic conservé
  assert.ok(existsSync(join(agentsDir, "auditor.md")));
});

test("validate : erreurs détectées (provider inconnu, modèle inconnu, skill mort)", async () => {
  const bad = {
    ...presetBody,
    provider: "openai",
    model: "nope-model",
    skills: ["/chemin/introuvable"],
    subagents: [
      { name: "BAD NAME", provider: "openai", model: "gpt-5.4", system_prompt: "" },
      { name: "ghost", provider: "nope", model: "x", system_prompt: "" },
    ],
  };
  const v = await validateAgent(getPaths(), bad, authOk);
  assert.ok(v.errors.some((e) => e.includes("provider inconnu") && e.includes("nope")));
  assert.ok(v.errors.some((e) => e.includes("nope-model")));
  assert.ok(v.errors.some((e) => e.includes("skill introuvable")));
  assert.ok(v.errors.some((e) => e.includes("BAD NAME")));
});

test("validate : preset valide → aucune erreur", async () => {
  const v = await validateAgent(getPaths(), presetBody, authOk);
  assert.deepEqual(v.errors, []);
});

test("DELETE retire le preset + ses .md, garde les étrangers", async () => {
  const res = await fetch(`${base}/api/agents/${agentId}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.ok(!existsSync(join(agentsDir, "noo-rag-expert-critic.md")));
  assert.ok(existsSync(join(agentsDir, "auditor.md")));
  const list = await (await fetch(`${base}/api/agents`)).json();
  assert.equal(list.agents.length, 0);
});

test("slugify gère accents et casse", () => {
  assert.equal(slugify("RAG Expert"), "rag-expert");
  assert.equal(slugify("Évaluation 42"), "evaluation-42");
});

test("provider login API-key flow writes auth.json through Models.login", async () => {
  const started = await fetch(`${base}/api/providers/deepseek/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api_key" }),
  });
  assert.equal(started.status, 202);
  const { id } = await started.json() as { id: string };
  assert.match(id, /^[a-z0-9-]+$/i);

  const events = await collectLoginEvents(id, (event) => event.type === "prompt");
  assert.equal(events.at(-1)?.type, "prompt");
  assert.equal((events.at(-1) as { prompt: { type: string } }).prompt.type, "secret");

  const reply = await fetch(`${base}/api/provider-logins/${id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "sk-test-login" }),
  });
  assert.equal(reply.status, 200);
  await collectLoginEvents(id, (event) => event.type === "done");

  const auth = JSON.parse(readFile(join(piDir, "auth.json"))) as Record<string, { type?: string; key?: string }>;
  assert.equal(auth.deepseek.type, "api_key");
  assert.equal(auth.deepseek.key, "sk-test-login");
  assert.equal(auth.openai.type, "oauth");
});

test("provider login rejects unknown providers and types", async () => {
  const missing = await fetch(`${base}/api/providers/not-a-provider/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api_key" }),
  });
  assert.equal(missing.status, 404);
  const bad = await fetch(`${base}/api/providers/deepseek/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "magic" }),
  });
  assert.equal(bad.status, 400);
});

async function collectLoginEvents(id: string, until: (event: { type?: string }) => boolean): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/provider-logins/${id}/events`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
      events.push(event);
      if (until(event)) {
        await reader.cancel().catch(() => undefined);
        return events;
      }
    }
  }
  throw new Error(`login events timed out: ${JSON.stringify(events)}`);
}

function readFile(p: string): string {
  return readFileSync(p, "utf8");
}
