import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, atomicWriteJson } from "./json-files.js";
import type { Paths } from "./paths.js";
import type { ProviderUpsert } from "./schemas.js";

// ---------- Types ----------

export interface ModelRef {
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface ProviderView {
  id: string;
  source: "builtin" | "custom";
  models: ModelRef[];
  auth: { configured: boolean; type: string | null; ready: boolean | null };
}

export interface SkillRef {
  name: string;
  description: string;
  path: string;
  descriptionTooLong?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, unknown>;
}

export const API_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "azure-openai-responses",
  "amazon-bedrock",
  "radius",
] as const;

// ---------- Pi catalog (read model) ----------

interface CatalogFile {
  [provider: string]: { models?: Array<Record<string, unknown>> };
}

interface ModelsJsonFile {
  providers?: Record<string, Record<string, unknown>>;
}

export function readCatalog(paths: Paths): Map<string, ModelRef[]> {
  const catalog = readJson<CatalogFile>(join(paths.piAgentDir, "models-store.json"), {});
  const customs = readJson<ModelsJsonFile>(paths.piModelsJson, {}).providers ?? {};
  const out = new Map<string, ModelRef[]>();
  for (const [id, entry] of Object.entries(catalog)) {
    out.set(id, (entry.models ?? []).map((m) => ({ id: String(m.id), name: m.name as string | undefined, reasoning: m.reasoning as boolean | undefined })));
  }
  for (const [id, entry] of Object.entries(customs)) {
    const models = Array.isArray(entry.models) ? (entry.models as Array<{ id?: string }>) : [];
    out.set(id, models.map((m) => ({ id: String(m.id) }))); // un custom écrase le built-in éponyme
  }
  return out;
}

// ---------- Auth status ----------

type AuthFile = Record<string, { type?: string; key?: string } | undefined>;

function readAuth(paths: Paths): AuthFile {
  return readJson<AuthFile>(paths.piAuthJson, {});
}

const authCache = new Map<string, { at: number; ready: boolean | null }>();
const AUTH_TTL_MS = 60_000;

function checkAuthReady(provider: string): Promise<boolean | null> {
  const cached = authCache.get(provider);
  if (cached && Date.now() - cached.at < AUTH_TTL_MS) return Promise.resolve(cached.ready);
  return new Promise((resolve) => {
    execFile("pi", ["auth", "check", "--provider", provider, "--json"], { timeout: 15_000 }, (err, stdout) => {
      let ready: boolean | null = null;
      try {
        ready = JSON.parse(stdout).status === "ready";
      } catch {
        ready = null;
      }
      if (err && ready === null) ready = false;
      authCache.set(provider, { at: Date.now(), ready });
      resolve(ready);
    });
  });
}

/** providers enrichis : catalogue + source + statut auth. Prêt pour GET /api/providers. */
export async function listProviders(paths: Paths): Promise<ProviderView[]> {
  const catalog = readCatalog(paths);
  const auth = readAuth(paths);
  const customs = readJson<ModelsJsonFile>(paths.piModelsJson, {}).providers ?? {};
  const views: ProviderView[] = [];
  for (const [id, models] of catalog) {
    const a = auth[id];
    views.push({
      id,
      source: customs[id] ? "custom" : "builtin",
      models,
      auth: { configured: Boolean(a), type: a?.type ?? null, ready: await checkAuthReady(id) },
    });
  }
  for (const id of Object.keys(customs)) {
    if (catalog.has(id)) continue;
    const a = auth[id];
    views.push({
      id,
      source: "custom",
      models: catalog.get(id) ?? [],
      auth: { configured: Boolean(a), type: a?.type ?? null, ready: await checkAuthReady(id) },
    });
  }
  return views.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- Providers (écriture models.json + auth.json, I1/O1 du contrat) ----------

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

export type ProviderInput = Omit<ProviderUpsert, "id">;

export function upsertProvider(paths: Paths, id: string, input: ProviderInput): { error?: string } {
  if (!PROVIDER_ID.test(id)) return { error: `id provider invalide: ${id}` };
  if (input.api && !(API_PROTOCOLS as readonly string[]).includes(input.api)) {
    return { error: `api inconnue: ${input.api} (protocoles: ${API_PROTOCOLS.join(", ")})` };
  }
  const file = readJson<ModelsJsonFile>(paths.piModelsJson, {});
  file.providers ??= {};
  const existing = file.providers[id] ?? {};
  const next: Record<string, unknown> = { ...existing };
  if (input.baseUrl !== undefined) next.baseUrl = input.baseUrl;
  if (input.api !== undefined) next.api = input.api;
  if (input.models !== undefined) next.models = input.models;
  file.providers[id] = next;
  atomicWriteJson(paths.piModelsJson, file);
  if (input.apiKey !== undefined) {
    const auth = readAuth(paths);
    auth[id] = { type: "api_key", key: input.apiKey };
    atomicWriteJson(paths.piAuthJson, auth);
  }
  return {};
}

export function deleteProvider(paths: Paths, id: string): void {
  const file = readJson<ModelsJsonFile>(paths.piModelsJson, {});
  if (file.providers) {
    delete file.providers[id];
    atomicWriteJson(paths.piModelsJson, file);
  }
  const auth = readAuth(paths);
  if (auth[id]) {
    delete auth[id];
    atomicWriteJson(paths.piAuthJson, auth);
  }
}

// ---------- Skills (scan) ----------

export function listSkills(paths: Paths): SkillRef[] {
  const out: SkillRef[] = [];
  for (const dir of paths.skillsDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name;
      const desc = (() => {
        const m = /^description:\s*([^\n]+)/m.exec(text);
        // description sur une ligne ; les descriptions multilignes ne sont pas supportées
        return m?.[1]?.trim() ?? "";
      })();
      out.push({ name, description: desc, path: join(dir, entry.name), descriptionTooLong: desc.length > 1024 });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- MCP user-level ----------

export function readMcp(paths: Paths): McpConfig {
  return readJson<McpConfig>(paths.piMcpJson, { mcpServers: {} });
}

export function validateMcpConfig(value: unknown): string | null {
  const v = value as McpConfig;
  if (!v || typeof v !== "object" || !v.mcpServers || typeof v.mcpServers !== "object" || Array.isArray(v.mcpServers)) {
    return "shape attendu: { mcpServers: { <name>: { command?, args?, env?, url?, headers? } } }";
  }
  for (const [name, server] of Object.entries(v.mcpServers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return `nom de serveur invalide: ${name}`;
    const s = server as Record<string, unknown>;
    if (!s.command && !s.url) return `serveur ${name}: command ou url requis`;
  }
  return null;
}

export function writeMcp(paths: Paths, config: McpConfig): void {
  atomicWriteJson(paths.piMcpJson, config);
}

// ---------- Détection pi-mcp-adapter (conséquence ADR-002) ----------

export function mcpAdapterDetected(paths: Paths): boolean {
  const settings = readJson<{ packages?: unknown[] }>(join(paths.piAgentDir, "settings.json"), {});
  return Array.isArray(settings.packages) && settings.packages.some((p) => String(p).includes("pi-mcp-adapter"));
}
