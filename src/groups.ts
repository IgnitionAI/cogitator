import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

/** Taille d'un groupe (verrou produit, plan 0004 : 2–6 bots). */
export const GROUP_MIN = 2;
export const GROUP_MAX = 6;

export interface GroupRow {
  id: string;
  name: string;
  host_agent_id: string;
  default_workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  agent_id: string;
  name: string;
  slug: string;
  provider: string;
  model: string;
  conversation_id: string;
  is_host: number;
}

export interface GroupWithMembers extends GroupRow {
  members: GroupMember[];
}

export interface CreateGroupInput {
  name: string;
  memberAgentIds: string[]; // 2–6, ordre conservé (le 1er est l'hôte par défaut)
  hostAgentId?: string; // doit être un membre ; défaut : premier membre
  defaultWorkspaceId?: string | null;
}

export function getGroup(db: Db, id: string): GroupRow | null {
  const row = db.prepare("SELECT * FROM agent_group WHERE id = ?").get(id) as GroupRow | undefined;
  return row ?? null;
}

export function listGroupMembers(db: Db, groupId: string): GroupMember[] {
  return db
    .prepare(
      `SELECT c.agent_id, p.name, p.slug, p.provider, p.model, c.id AS conversation_id,
              (g.host_agent_id = c.agent_id) AS is_host
       FROM conversation c
       JOIN agent_preset p ON p.id = c.agent_id
       JOIN agent_group g ON g.id = c.group_id
       WHERE c.group_id = ?
       ORDER BY c.created_at`,
    )
    .all(groupId) as unknown as GroupMember[];
}

export function listGroups(db: Db): GroupWithMembers[] {
  const rows = db.prepare("SELECT * FROM agent_group ORDER BY updated_at DESC").all() as unknown as GroupRow[];
  return rows.map((g) => ({ ...g, members: listGroupMembers(db, g.id) }));
}

export function getGroupWithMembers(db: Db, id: string): GroupWithMembers | null {
  const row = getGroup(db, id);
  return row ? { ...row, members: listGroupMembers(db, id) } : null;
}

/** Insère le groupe ; les conversations membres sont créées par l'appelant (server) via createConversation. */
export function insertGroup(db: Db, input: CreateGroupInput): GroupRow {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO agent_group (id, name, host_agent_id, default_workspace_id) VALUES (?, ?, ?, ?)",
  ).run(id, input.name, input.hostAgentId!, input.defaultWorkspaceId ?? null);
  return getGroup(db, id)!;
}

export function deleteGroup(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM agent_group WHERE id = ?").run(id).changes > 0;
}

// ---------- Bus du fil de groupe (ADR-011 : log Cogitator, pas un jsonl pi partagé) ----------

export type GroupMessageRole = "user" | "assistant" | "tool";

export interface GroupMessageRow {
  id: string;
  group_id: string;
  conversation_id: string | null;
  agent_id: string | null;
  role: GroupMessageRole;
  text: string;
  /** JSON { args, result } pour role='tool' ; null sinon */
  detail: string | null;
  is_error: number;
  created_at: string;
}

export interface AppendGroupMessageInput {
  groupId: string;
  conversationId?: string | null;
  agentId?: string | null;
  role: GroupMessageRole;
  text: string;
  detail?: string | null;
  isError?: boolean;
}

export function appendGroupMessage(db: Db, input: AppendGroupMessageInput): GroupMessageRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO group_message (id, group_id, conversation_id, agent_id, role, text, detail, is_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.groupId,
    input.conversationId ?? null,
    input.agentId ?? null,
    input.role,
    input.text,
    input.detail ?? null,
    input.isError ? 1 : 0,
  );
  return db.prepare("SELECT * FROM group_message WHERE id = ?").get(id) as GroupMessageRow;
}

const GROUP_MESSAGES_LIMIT = 300;

export function listGroupMessages(db: Db, groupId: string, limit = GROUP_MESSAGES_LIMIT): GroupMessageRow[] {
  return db
    .prepare("SELECT * FROM group_message WHERE group_id = ? ORDER BY created_at, rowid LIMIT ?")
    .all(groupId, limit) as unknown as GroupMessageRow[];
}

/** Routage ADR-011 : la première mention @nom/@slug d'un membre le vise ; sinon l'hôte répond. */
export function routeGroupMessage(group: GroupWithMembers, text: string): GroupMember {
  const mention = text.match(/(?:^|\s)@([A-Za-z0-9][A-Za-z0-9_-]*)/);
  if (mention) {
    const token = mention[1]!.toLowerCase();
    const member = group.members.find(
      (m) => m.name.toLowerCase() === token || m.slug.toLowerCase() === token,
    );
    // ponytail: une seule mention visée par ligne ; mentions parallèles = ticket dédié
    if (member) return member;
  }
  return group.members.find((m) => m.is_host === 1)!;
}

/** Propriétaire groupe d'une conversation membre (fan-out bus), ou null pour un fil 1–1. */
export function conversationGroupOwner(db: Db, conversationId: string): { group_id: string; agent_id: string | null; session_file: string | null; name: string | null } | null {
  const row = db
    .prepare(
      `SELECT c.group_id, c.agent_id, c.session_file, p.name
       FROM conversation c LEFT JOIN agent_preset p ON p.id = c.agent_id
       WHERE c.id = ? AND c.group_id IS NOT NULL`,
    )
    .get(conversationId) as { group_id: string; agent_id: string | null; session_file: string | null; name: string | null } | undefined;
  return row ?? null;
}
