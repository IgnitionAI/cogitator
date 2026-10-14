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
