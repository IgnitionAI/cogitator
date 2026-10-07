import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { SpawnConfig } from "./spawn.js";

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
  /** jointure workspace */
  workspace_dir?: string | null;
}

export interface CreateConversationInput {
  workspaceId?: string | null;
  agentId?: string | null;
  spawn: SpawnConfig;
}

export function listConversations(db: Db, workspaceId?: string): ConversationRow[] {
  const sql = `
    SELECT c.*, w.dir AS workspace_dir FROM conversation c
    LEFT JOIN workspace w ON w.id = c.workspace_id
    ${workspaceId ? "WHERE c.workspace_id = ?" : ""}
    ORDER BY c.updated_at DESC`;
  return (workspaceId
    ? db.prepare(sql).all(workspaceId)
    : db.prepare(sql).all()) as unknown as ConversationRow[];
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
    `INSERT INTO conversation (id, workspace_id, agent_id, provider, model, thinking, spawn_args, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'idle')`,
  ).run(
    id,
    input.workspaceId ?? null,
    input.agentId ?? null,
    input.spawn.provider,
    input.spawn.model,
    input.spawn.thinking ?? null,
    JSON.stringify(input.spawn),
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
