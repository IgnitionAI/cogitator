import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { SpawnConfig } from "./spawn.js";
import { UI_INSTRUCTIONS } from "./generative-ui.js";

/** Longueur max du titre dérivé d'un message (contrainte d'affichage de l'UI). */
const TITLE_MAX = 80;

export interface ConversationRow {
  id: string;
  workspace_id: string | null;
  agent_id: string | null;
  provider: string;
  model: string;
  thinking: string | null;
  session_file: string | null;
  spawn_args: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  /** conversation privée d'un membre de groupe (ADR-011) — jamais un fil 1–1 */
  group_id?: string | null;
  /** jointure workspace */
  workspace_dir?: string | null;
}

export interface CreateConversationInput {
  workspaceId?: string | null;
  agentId?: string | null;
  groupId?: string | null;
  spawn: SpawnConfig;
}

export function listConversations(db: Db, workspaceId?: string, agentId?: string): ConversationRow[] {
  const where = [
    workspaceId ? "c.workspace_id = ?" : "",
    agentId ? "c.agent_id = ?" : "",
    "c.group_id IS NULL", // les sessions membres ne sont pas des fils 1–1 (resume-last, ADR-011)
  ].filter(Boolean).join(" AND ");
  const sql = `
    SELECT c.*, w.dir AS workspace_dir FROM conversation c
    LEFT JOIN workspace w ON w.id = c.workspace_id
    ${where ? `WHERE ${where}` : ""}
    ORDER BY c.updated_at DESC`;
  const params = [workspaceId, agentId].filter((v): v is string => Boolean(v));
  return (params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all()) as unknown as ConversationRow[];
}

export function getConversation(db: Db, id: string): ConversationRow | null {
  const row = db
    .prepare(
      `SELECT c.*, w.dir AS workspace_dir FROM conversation c
       LEFT JOIN workspace w ON w.id = c.workspace_id WHERE c.id = ?`,
    )
    .get(id) as ConversationRow | undefined;
  return row ?? null;
}

export function createConversation(db: Db, input: CreateConversationInput): ConversationRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO conversation (id, workspace_id, agent_id, group_id, provider, model, thinking, spawn_args, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
  ).run(
    id,
    input.workspaceId ?? null,
    input.agentId ?? null,
    input.groupId ?? null,
    input.spawn.provider,
    input.spawn.model,
    input.spawn.thinking ?? null,
    JSON.stringify({ ...input.spawn, uiInstructions: UI_INSTRUCTIONS }),
  );
  return getConversation(db, id)!;
}

export function setConversationStatus(db: Db, id: string, status: string): void {
  db.prepare("UPDATE conversation SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

export function setConversationSession(db: Db, id: string, sessionFile: string): void {
  db.prepare("UPDATE conversation SET session_file = ?, updated_at = datetime('now') WHERE id = ?").run(sessionFile, id);
}

export function setConversationTitle(db: Db, id: string, title: string): void {
  db.prepare(
    "UPDATE conversation SET title = CASE WHEN title = '' THEN ? ELSE title END, updated_at = datetime('now') WHERE id = ?",
  ).run(title.slice(0, TITLE_MAX), id);
}

export function setConversationModel(db: Db, id: string, provider: string, model: string, spawn: SpawnConfig): void {
  db.prepare(
    "UPDATE conversation SET provider = ?, model = ?, spawn_args = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(provider, model, JSON.stringify(spawn), id);
}

export function deleteConversation(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM conversation WHERE id = ?").run(id).changes > 0;
}
