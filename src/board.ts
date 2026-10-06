import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, atomicWriteJson } from "./json-files.js";
import type { BoardCardInput } from "./schemas.js";

/**
 * Board kanban du workspace — Linear/GitHub Projects style.
 * Source de vérité : `cogitator.board.json` à la racine du workspace.
 * Single-writer : toutes les écritures passent par ce module (atomic + .bak) ;
 * les lectures sont libres (agents, arborescence, git).
 */

export interface BoardComment {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface BoardCard {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  labels: string[];
  assignee_agent_id: string | null;
  conversation_ids: string[];
  blocks: string[];
  blocked_by: string[];
  comments: BoardComment[];
  created_at: string;
  updated_at: string;
}

export interface BoardFile {
  version: 1;
  cards: BoardCard[];
}

export function boardPath(wsDir: string): string {
  return join(wsDir, "cogitator.board.json");
}

export function readBoard(wsDir: string): BoardFile {
  const board = readJson<BoardFile>(boardPath(wsDir), { version: 1, cards: [] });
  if (!Array.isArray(board.cards)) return { version: 1, cards: [] };
  return board;
}

function saveBoard(wsDir: string, board: BoardFile): void {
  atomicWriteJson(boardPath(wsDir), board);
}

export function getCard(board: BoardFile, cardId: string): BoardCard | null {
  return board.cards.find((c) => c.id === cardId) ?? null;
}

export function createCard(wsDir: string, input: BoardCardInput): BoardCard {
  const board = readBoard(wsDir);
  const now = new Date().toISOString();
  const card: BoardCard = {
    id: randomUUID(),
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "backlog",
    priority: input.priority ?? "medium",
    labels: input.labels ?? [],
    assignee_agent_id: input.assignee_agent_id ?? null,
    conversation_ids: input.conversation_ids ?? [],
    blocks: input.blocks ?? [],
    blocked_by: input.blocked_by ?? [],
    comments: [],
    created_at: now,
    updated_at: now,
  };
  board.cards.push(card);
  saveBoard(wsDir, board);
  return card;
}

export function updateCard(wsDir: string, cardId: string, patch: BoardCardInput): BoardCard | null {
  const board = readBoard(wsDir);
  const card = getCard(board, cardId);
  if (!card) return null;
  card.title = patch.title;
  card.description = patch.description ?? card.description;
  card.status = patch.status ?? card.status;
  card.priority = patch.priority ?? card.priority;
  card.labels = patch.labels ?? card.labels;
  card.assignee_agent_id = patch.assignee_agent_id === undefined ? card.assignee_agent_id : patch.assignee_agent_id;
  card.conversation_ids = patch.conversation_ids ?? card.conversation_ids;
  // pas d'auto-référence dans les relations
  card.blocks = (patch.blocks ?? card.blocks).filter((id) => id !== cardId);
  card.blocked_by = (patch.blocked_by ?? card.blocked_by).filter((id) => id !== cardId);
  card.updated_at = new Date().toISOString();
  saveBoard(wsDir, board);
  return card;
}

export function moveCard(wsDir: string, cardId: string, status: string): BoardCard | null {
  const board = readBoard(wsDir);
  const card = getCard(board, cardId);
  if (!card) return null;
  card.status = status;
  card.updated_at = new Date().toISOString();
  saveBoard(wsDir, board);
  return card;
}

export function addComment(wsDir: string, cardId: string, text: string, author = "user"): BoardCard | null {
  const board = readBoard(wsDir);
  const card = getCard(board, cardId);
  if (!card) return null;
  card.comments.push({ id: randomUUID(), author, text, at: new Date().toISOString() });
  card.updated_at = new Date().toISOString();
  saveBoard(wsDir, board);
  return card;
}

export function deleteCard(wsDir: string, cardId: string): boolean {
  const board = readBoard(wsDir);
  const before = board.cards.length;
  board.cards = board.cards.filter((c) => c.id !== cardId);
  if (board.cards.length === before) return false;
  // nettoyage des relations pointant vers la carte supprimée
  for (const c of board.cards) {
    c.blocks = c.blocks.filter((id) => id !== cardId);
    c.blocked_by = c.blocked_by.filter((id) => id !== cardId);
  }
  saveBoard(wsDir, board);
  return true;
}

/** Vrai si le board existe déjà sur disque (carte affichée dans l'UI). */
export function boardExists(wsDir: string): boolean {
  return existsSync(boardPath(wsDir));
}
