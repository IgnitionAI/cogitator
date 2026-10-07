import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Db } from "./db.js";
import type { WorkspaceUpdate } from "./schemas.js";

export interface WorkspaceRow {
  id: string;
  dir: string;
  name: string;
  default_agent_id: string | null;
  conversation_count?: number;
}

export function listWorkspaces(db: Db): WorkspaceRow[] {
  return db
    .prepare(
      `SELECT w.*, (SELECT COUNT(*) FROM conversation c WHERE c.workspace_id = w.id) AS conversation_count
       FROM workspace w ORDER BY w.name`,
    )
    .all() as unknown as WorkspaceRow[];
}

export function getWorkspace(db: Db, id: string): WorkspaceRow | null {
  const row = db.prepare("SELECT * FROM workspace WHERE id = ?").get(id) as WorkspaceRow | undefined;
  return row ?? null;
}

export function getWorkspaceByDir(db: Db, dir: string): WorkspaceRow | null {
  const row = db.prepare("SELECT * FROM workspace WHERE dir = ?").get(dir) as WorkspaceRow | undefined;
  return row ?? null;
}

export interface WorkspaceInput {
  dir: string;
  name?: string;
  default_agent_id?: string | null;
}

/** Un agent par défaut référencé doit exister (FK logique, pas de contrainte SQLite sur celui-ci). */
function agentExists(db: Db, id: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM agent_preset WHERE id = ?").get(id));
}

/** Crée un workspace. Invariant (domain model) : le dossier doit exister ; dir unique. */
export function createWorkspace(db: Db, input: WorkspaceInput): { workspace?: WorkspaceRow; error?: string } {
  if (!existsSync(input.dir)) return { error: `dossier introuvable: ${input.dir}` };
  if (!statSync(input.dir).isDirectory()) return { error: `n'est pas un dossier: ${input.dir}` };
  let dir: string;
  try {
    dir = realpathSync(input.dir); // canonicalise (symlinks, trailing /)
  } catch {
    return { error: `dossier illisible: ${input.dir}` };
  }
  if (getWorkspaceByDir(db, dir)) return { error: `workspace déjà enregistré pour ${dir}` };
  if (input.default_agent_id && !agentExists(db, input.default_agent_id)) {
    return { error: `agent par défaut introuvable: ${input.default_agent_id}` };
  }
  const id = randomUUID();
  const name = input.name?.trim() || basename(dir) || dir;
  db.prepare("INSERT INTO workspace (id, dir, name, default_agent_id) VALUES (?, ?, ?, ?)").run(
    id, dir, name, input.default_agent_id ?? null,
  );
  return { workspace: getWorkspace(db, id)! };
}

/** Renvoie null si le workspace ou l'agent par défaut visé n'existe pas. */
export function updateWorkspace(db: Db, id: string, input: WorkspaceUpdate): WorkspaceRow | null {
  const existing = getWorkspace(db, id);
  if (!existing) return null;
  if (input.default_agent_id && !agentExists(db, input.default_agent_id)) return null;
  db.prepare("UPDATE workspace SET name = ?, default_agent_id = ? WHERE id = ?").run(
    input.name?.trim() || existing.name,
    input.default_agent_id === undefined ? existing.default_agent_id : input.default_agent_id,
    id,
  );
  return getWorkspace(db, id);
}

export function deleteWorkspace(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM workspace WHERE id = ?").run(id).changes > 0;
}

// ---------- File-picker serveur ----------

export interface BrowseEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

export function browseDir(path: string | null): { path: string; parent: string | null; entries: BrowseEntry[] } | { error: string } {
  const target = path ?? process.env.HOME ?? "/";
  let resolved: string;
  try {
    resolved = realpathSync(target);
  } catch {
    return { error: `dossier introuvable: ${target}` };
  }
  if (!statSync(resolved).isDirectory()) return { error: `n'est pas un dossier: ${target}` };
  let entries: BrowseEntry[];
  try {
    entries = readdirSync(resolved, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: join(resolved, e.name), type: e.isDirectory() ? ("dir" as const) : ("file" as const) }));
  } catch {
    return { error: `dossier illisible: ${target}` };
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  const parent = resolved === "/" ? null : join(resolved, "..");
  return { path: resolved, parent, entries };
}
