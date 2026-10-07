import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { SUBAGENT_NAME, THINKING_LEVELS, type AgentInput, type McpServerEntry, type SubagentInput } from "./schemas.js";
import { readCatalog } from "./registry.js";
import type { Paths } from "./paths.js";

export type { AgentInput, McpServerEntry, SubagentInput } from "./schemas.js";

export interface AgentPreset extends AgentInput {
  id: string;
  slug: string;
  created_at: string;
  updated_at: string;
  is_default?: number;
  subagents: Array<SubagentInput & { id: string }>;
}

// ---------- Slugs ----------

export function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 64) || "agent"
  );
}

// ---------- Mapping lignes SQLite ----------

interface PresetRow {
  id: string; slug: string; name: string; description: string; provider: string; model: string;
  thinking: string | null; system_prompt: string; skills: string; tools_allowlist: string | null;
  mcp_servers: string; created_at: string; updated_at: string; is_default: number;
}

interface SubRow {
  id: string; agent_id: string; name: string; description: string; provider: string; model: string;
  thinking: string | null; system_prompt: string; skills: string; mcp_servers: string;
}

const THINKING_SET = new Set<string>(THINKING_LEVELS);

/** Narrowing à la frontière DB : valeur invalide → null (la validation métier est dans validateAgent). */
function parseThinking(value: string | null): AgentPreset["thinking"] {
  return value !== null && THINKING_SET.has(value) ? (value as AgentPreset["thinking"]) : null;
}

/** Colonnes JSON des lignes SQLite : toute valeur illisible retombe sur un défaut sûr. */
function parseJsonArray<T>(raw: string | null, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function rowToPreset(row: PresetRow, subs: SubRow[]): AgentPreset {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    provider: row.provider,
    model: row.model,
    thinking: parseThinking(row.thinking),
    system_prompt: row.system_prompt,
    skills: parseJsonArray<string>(row.skills, []),
    tools_allowlist: row.tools_allowlist ? parseJsonArray<string>(row.tools_allowlist, []) : null,
    mcp_servers: parseJsonArray<McpServerEntry>(row.mcp_servers, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_default: row.is_default,
    subagents: subs.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      provider: s.provider,
      model: s.model,
      thinking: parseThinking(s.thinking),
      system_prompt: s.system_prompt,
      skills: parseJsonArray<string>(s.skills, []),
      mcp_servers: parseJsonArray<McpServerEntry>(s.mcp_servers, []),
    })),
  };
}

// ---------- CRUD ----------

/** Presets complets, subagents inclus : l'UI édite ces objets tels quels (un preset tronqué
 *  écraserait le prompt de scope et les subagents au save). */
export function listAgents(db: Db): AgentPreset[] {
  const rows = db.prepare("SELECT * FROM agent_preset ORDER BY is_default DESC, name").all() as unknown as PresetRow[];
  const subsFor = db.prepare("SELECT * FROM subagent_setup WHERE agent_id = ? ORDER BY name");
  return rows.map((r) => rowToPreset(r, subsFor.all(r.id) as unknown as SubRow[]));
}

export function getDefaultAgentId(db: Db): string | null {
  const row = db.prepare("SELECT id FROM agent_preset WHERE is_default = 1 LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

/** Définit l'agent par défaut global (un seul — transaction). */
export function setDefaultAgent(db: Db, id: string): boolean {
  const existing = getAgent(db, id);
  if (!existing) return false;
  db.transaction(() => {
    db.prepare("UPDATE agent_preset SET is_default = 0").run();
    db.prepare("UPDATE agent_preset SET is_default = 1 WHERE id = ?").run(id);
  })();
  return true;
}

export function getAgent(db: Db, id: string): AgentPreset | null {
  const row = db.prepare("SELECT * FROM agent_preset WHERE id = ?").get(id) as PresetRow | undefined;
  if (!row) return null;
  const subs = db.prepare("SELECT * FROM subagent_setup WHERE agent_id = ? ORDER BY name").all(id) as unknown as SubRow[];
  return rowToPreset(row, subs);
}

function uniqueSlug(db: Db, name: string, excludeId?: string): string {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (db.prepare("SELECT 1 FROM agent_preset WHERE slug = ? AND id != ?").get(slug, excludeId ?? "")) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

export function createAgent(db: Db, input: AgentInput): AgentPreset {
  const id = randomUUID();
  const slug = uniqueSlug(db, input.name);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_preset (id, slug, name, description, provider, model, thinking, system_prompt, skills, tools_allowlist, mcp_servers, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, slug, input.name, input.description ?? "", input.provider, input.model, input.thinking ?? null,
    input.system_prompt ?? "", JSON.stringify(input.skills ?? []),
    input.tools_allowlist ? JSON.stringify(input.tools_allowlist) : null,
    JSON.stringify(input.mcp_servers ?? []), now, now,
  );
  replaceSubagents(db, id, input.subagents ?? []);
  return getAgent(db, id)!;
}

export function updateAgent(db: Db, id: string, input: AgentInput): AgentPreset | null {
  const existing = getAgent(db, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE agent_preset SET slug = ?, name = ?, description = ?, provider = ?, model = ?, thinking = ?,
       system_prompt = ?, skills = ?, tools_allowlist = ?, mcp_servers = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    uniqueSlug(db, input.name, id), input.name, input.description ?? "", input.provider, input.model,
    input.thinking ?? null, input.system_prompt ?? "", JSON.stringify(input.skills ?? []),
    input.tools_allowlist ? JSON.stringify(input.tools_allowlist) : null,
    JSON.stringify(input.mcp_servers ?? []), new Date().toISOString(), id,
  );
  replaceSubagents(db, id, input.subagents ?? []);
  return getAgent(db, id);
}

export function deleteAgent(db: Db, id: string): boolean {
  const res = db.prepare("DELETE FROM agent_preset WHERE id = ?").run(id);
  return res.changes > 0;
}

function replaceSubagents(db: Db, agentId: string, subs: SubagentInput[]): void {
  db.prepare("DELETE FROM subagent_setup WHERE agent_id = ?").run(agentId);
  const insert = db.prepare(
    `INSERT INTO subagent_setup (id, agent_id, name, description, provider, model, thinking, system_prompt, skills, mcp_servers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of subs) {
    insert.run(
      randomUUID(), agentId, s.name, s.description ?? "",
      s.provider, s.model, s.thinking ?? null, s.system_prompt ?? "",
      JSON.stringify(s.skills ?? []), JSON.stringify(s.mcp_servers ?? []),
    );
  }
}

// ---------- Validation ----------

export type AuthChecker = (provider: string) => Promise<boolean | null>;

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export async function validateAgent(paths: Paths, preset: AgentInput, checkAuth: AuthChecker): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const catalog = readCatalog(paths);

  const checkModel = (where: string, provider: string, model: string): void => {
    const models = catalog.get(provider);
    if (!models) {
      errors.push(`${where}: provider inconnu dans le catalogue pi: ${provider}`);
    } else if (!models.some((m) => m.id === model)) {
      errors.push(`${where}: modèle ${model} inconnu pour ${provider}`);
    }
  };

  if (!preset.name.trim()) errors.push("name requis");
  checkModel("agent", preset.provider, preset.model);
  if (preset.thinking && !THINKING_SET.has(preset.thinking)) errors.push(`thinking invalide: ${preset.thinking}`);
  for (const skill of preset.skills ?? []) {
    const p = skill.startsWith("~") ? join(process.env.HOME ?? "~", skill.slice(1)) : skill;
    if (!existsSync(p)) errors.push(`skill introuvable: ${skill}`);
  }
  for (const m of preset.mcp_servers ?? []) {
    if (!/^[A-Za-z0-9_-]+$/.test(m.name)) errors.push(`MCP: nom invalide ${m.name}`);
    if (!m.command && !m.url) errors.push(`MCP ${m.name}: command ou url requis`);
  }
  const ready = await checkAuth(preset.provider);
  if (ready === false) warnings.push(`provider ${preset.provider}: auth non prête (pi auth check)`);
  if (ready === null) warnings.push(`provider ${preset.provider}: statut auth indéterminé`);

  const seen = new Set<string>();
  for (const sub of preset.subagents ?? []) {
    if (!SUBAGENT_NAME.test(sub.name)) errors.push(`subagent: nom invalide ${sub.name} (minuscules, chiffres, -, _)`);
    if (seen.has(sub.name)) errors.push(`subagent: nom dupliqué ${sub.name}`);
    seen.add(sub.name);
    checkModel(`subagent ${sub.name}`, sub.provider, sub.model);
  }
  return { errors, warnings };
}

// ---------- Apply → registre herdr (O1/O2 du contrat) ----------

function subagentFileName(agentSlug: string, subName: string): string {
  return `noo-${agentSlug}-${subName}.md`;
}

function renderSubagent(sub: SubagentInput & { id: string }, agentSlug: string): { file: string; content: string } {
  const lines = [
    "---",
    `name: noo-${agentSlug}-${sub.name}`,
    `description: ${(sub.description ?? "").replace(/\n/g, " ")}`,
    "kind: pi",
    `model: ${sub.provider}/${sub.model}`,
  ];
  if (sub.thinking) lines.push(`thinking: ${sub.thinking}`);
  if (sub.skills?.length) lines.push(`skills: ${JSON.stringify(sub.skills)}`);
  lines.push("---", "", sub.system_prompt ?? "");
  return { file: subagentFileName(agentSlug, sub.name), content: lines.join("\n") + "\n" };
}

export interface ApplyResult {
  written: string[];
  deleted: string[];
}

export function applyAgent(paths: Paths, preset: AgentPreset): ApplyResult {
  mkdirSync(paths.piAgentsDir, { recursive: true });
  const prefix = `noo-${preset.slug}-`;
  const desired = new Map<string, string>();
  for (const sub of preset.subagents) {
    const { file, content } = renderSubagent(sub, preset.slug);
    desired.set(file, content);
  }

  const written: string[] = [];
  const deleted: string[] = [];
  for (const [file, content] of desired) {
    const path = join(paths.piAgentsDir, file);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (existing !== content) {
      writeFileSync(path, content);
      written.push(file);
    }
  }
  for (const entry of readdirSync(paths.piAgentsDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".md")) continue; // O2 : on ne touche qu'à nos fichiers
    if (!desired.has(entry)) {
      rmSync(join(paths.piAgentsDir, entry));
      deleted.push(entry);
    }
  }
  return { written, deleted };
}

/** Supprime les définitions herdr d'un preset supprimé (uniquement ses fichiers noo-<slug>-*). */
export function unapplyAgent(paths: Paths, slug: string): string[] {
  if (!existsSync(paths.piAgentsDir)) return [];
  const prefix = `noo-${slug}-`;
  const deleted: string[] = [];
  for (const entry of readdirSync(paths.piAgentsDir)) {
    if (entry.startsWith(prefix) && entry.endsWith(".md")) {
      rmSync(join(paths.piAgentsDir, entry));
      deleted.push(entry);
    }
  }
  return deleted;
}
