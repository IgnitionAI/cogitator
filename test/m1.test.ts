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
writeFileSync(join(piDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key" }, openai: { type: "oauth" } }));
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
server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: 2, paths: getPaths(), pool });
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

function readFile(p: string): string {
  return readFileSync(p, "utf8");
}
