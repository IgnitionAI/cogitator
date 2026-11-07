import { entriesFromLines, type HistoryEntry } from "./history.js";
import { constants, realpathSync, closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Énumération des sous-agents d'une conversation, sans démon externe : l'extension
 * `@gotgenes/pi-subagents` écrit la session de chaque enfant dans
 * `<dir de la session parente>/<nom de la session parente>/tasks/<enfant>.jsonl`
 * (voir src/session/session-dir.ts de l'extension). Le serveur lit ce répertoire —
 * même source de vérité que pi, aucune supervision parallèle (ADR-013).
 *
 * Limite assumée : l'état vient du journal de l'enfant, pas d'une API. « en cours »
 * = dernière entrée sans message final (appel d'outil en attente, ou résultat d'outil
 * à consommer) ; « terminé » = dernier message assistant clos. Un enfant tué sans
 * message final reste donc « en cours » (voir MAX_AGE_MS).
 */

export type SubagentStatus = "working" | "done" | "unknown";

export interface SubagentView {
  /** Identifiant de session pi de l'enfant (en-tête du journal). */
  id: string;
  /** Première consigne utilisateur, tronquée : c'est le libellé le plus lisible. */
  label: string | null;
  /** `provider/model` déclaré dans le journal de l'enfant. */
  model: string | null;
  status: SubagentStatus;
  /** Horodatage d'ouverture de la session enfant. */
  started_at: string | null;
}

/** Au-delà de cette inactivité, un enfant « en cours » est traité comme inconnu (process tué). */
export const MAX_AGE_MS = 60 * 60 * 1000;
/** Nombre d'enfants listés au maximum (les plus récents). */
export const MAX_SUBAGENTS = 20;
const HEAD_WINDOWS = [64 * 1024, 1024 * 1024] as const;
const TAIL_BYTES = 65_536;
const HEADER_BYTES = 16 * 1024;

/** Les positions et tailles sont en octets, avant tout décodage UTF-8. */
function readWindow(fd: number, position: number, length: number): string {
  const buffer = Buffer.alloc(length);
  let bytes = 0;
  while (bytes < length) {
    const count = readSync(fd, buffer, bytes, length - bytes, position + bytes);
    if (!count) break;
    bytes += count;
  }
  return buffer.subarray(0, bytes).toString("utf8");
}

/** Répertoire des journaux enfants pour une session parente donnée. */
export function tasksDirFor(sessionFile: string): string {
  return join(dirname(sessionFile), basename(sessionFile).replace(/\.jsonl$/, ""), "tasks");
}

/** Identifiant de session porté par l'en-tête du journal parent, null si illisible. */
export function parentSessionIdOf(sessionFile: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const header = parseLines(readWindow(fd, 0, Math.min(stat.size, HEADER_BYTES)).split("\n")[0] ?? "")[0];
    return header?.type === "session" && typeof header.id === "string" && header.id ? header.id : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseLines(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) out.push(entry as Record<string, unknown>);
    } catch {
      // ligne tronquée (bornes head/tail) ou corrompue : ignorée
    }
  }
  return out;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part): part is { type: string; text: string } => Boolean(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .trim();
  return text || null;
}

/** Statut déduit de la dernière entrée significative du journal. */
export function statusOfEntries(entries: Record<string, unknown>[]): SubagentStatus {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const message = entry.message as { role?: string; stopReason?: string } | undefined;
    if (!message?.role) continue;
    if (message.role === "toolResult") return "working"; // l'agent va reprendre après l'outil
    if (message.role === "user") return "working";
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") return "unknown";
    return message.stopReason === "toolUse" ? "working" : "done";
  }
  return "unknown";
}

/** Lecture bornée d'un journal enfant : en-tête (id, modèle, consigne) + queue (statut). */
export function readSubagent(file: string, expectedParentId?: string): SubagentView | null {
  let headEntries: Record<string, unknown>[];
  let tail: string;
  let mtimeMs: number;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const { size } = stat;
    mtimeMs = stat.mtimeMs;
    // Le préambule système d'un enfant pèse ~120 Kio : on élargit la fenêtre jusqu'à la
    // première consigne utilisateur, bornée à 1 Mio (au-delà, libellé laissé vide).
    headEntries = [];
    for (const window of HEAD_WINDOWS) {
      headEntries = parseLines(readWindow(fd, 0, Math.min(size, window)));
      if (size <= window || headEntries.some((entry) => (entry.message as { role?: string } | undefined)?.role === "user")) break;
    }
    const offset = Math.max(0, size - TAIL_BYTES);
    tail = readWindow(fd, Math.max(0, offset - 1), Math.min(size, TAIL_BYTES + (offset > 0 ? 1 : 0)));
    // Si la fenêtre commence au milieu d'une entrée, seule sa suite est ignorée.
    if (offset > 0) {
      const newline = tail.indexOf("\n");
      tail = newline < 0 ? "" : tail.slice(newline + 1);
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const header = headEntries[0];
  if (header?.type !== "session" || typeof header.id !== "string" || !header.id) return null;
  if (expectedParentId !== undefined && header.parentSession !== expectedParentId) return null;
  const modelChange = headEntries.find((entry) => entry.type === "model_change") as
    | { provider?: string; modelId?: string }
    | undefined;
  const firstUser = headEntries.find((entry) => {
    const message = entry.message as { role?: string } | undefined;
    return message?.role === "user";
  });
  const label = firstUser ? textOf((firstUser.message as { content?: unknown }).content) : null;
  const status = statusOfEntries(parseLines(tail));
  return {
    id: header.id,
    label: label ? label.split("\n")[0]!.slice(0, 120) : null,
    model: modelChange?.provider && modelChange.modelId ? `${modelChange.provider}/${modelChange.modelId}` : null,
    status: status === "working" && Date.now() - mtimeMs > MAX_AGE_MS ? "unknown" : status,
    started_at: typeof header.timestamp === "string" ? header.timestamp : null,
  };
}

/**
 * Sous-agents d'une conversation. `live: false` ⇔ la conversation n'a pas de session pi
 * (rien à inspecter) ; un répertoire absent ou vide est un état normal → `live: true, []`.
 */
export function listSubagents(sessionFile: string | null): { live: boolean; subagents: SubagentView[] } {
  if (!sessionFile) return { live: false, subagents: [] };
  const parentId = parentSessionIdOf(sessionFile);
  if (!parentId) return { live: false, subagents: [] };
  const dir = tasksDirFor(sessionFile);
  let files: Array<{ file: string; mtimeMs: number }>;
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .flatMap((entry) => {
        const file = join(dir, entry.name);
        try {
          return [{ file, mtimeMs: statSync(file).mtimeMs }];
        } catch {
          return []; // Un journal supprimé pendant le rafraîchissement n'interrompt pas la liste.
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SUBAGENTS);
  } catch {
    return { live: true, subagents: [] };
  }
  const subagents: SubagentView[] = [];
  for (const { file } of files) {
    // Le répertoire est dérivé du nom de la session parente ; le lien déclaré dans
    // l'enfant est revérifié pour qu'un dossier recyclé ne fuite pas vers une autre
    // conversation.
    const view = readSubagent(file, parentId);
    if (view) subagents.push(view);
  }
  return { live: true, subagents };
}

export interface SubagentTranscript { subagent: SubagentView; entries: HistoryEntry[]; truncated: boolean }
/** Resolve by verified session id, never a client-supplied path; read a bounded snapshot on one fd. */
export function readSubagentTranscript(sessionFile: string | null, id: string): SubagentTranscript | null {
  if (!sessionFile || !id || id.length > 200) return null;
  const parentId = parentSessionIdOf(sessionFile);
  if (!parentId) return null;
  const dir = tasksDirFor(sessionFile);
  try {
    const expected = join(realpathSync(dirname(sessionFile)), basename(sessionFile).replace(/\.jsonl$/, ""), "tasks");
    if (realpathSync(dir) !== expected) return null;
    const files = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(".jsonl")).slice(0, 500);
    for (const file of files) {
      let fd: number | undefined;
      try {
        const path = join(dir, file.name);
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile()) continue;
        const header = parseLines(readWindow(fd, 0, Math.min(stat.size, HEADER_BYTES)).split("\n")[0] ?? "")[0];
        if (header?.type !== "session" || header.id !== id || header.parentSession !== parentId) continue;
        const cap = 4 * 1024 * 1024;
        const offset = Math.max(0, stat.size - cap);
        let raw = readWindow(fd, offset, Math.min(stat.size, cap));
        if (offset) raw = raw.slice(raw.indexOf("\n") + 1);
        const all = entriesFromLines(raw.split("\n"), 100_000);
        const head = parseLines(readWindow(fd, 0, Math.min(stat.size, HEAD_WINDOWS[1])));
        const model = head.find(e => e.type === "model_change");
        const user = head.find(e => (e.message as { role?: string } | undefined)?.role === "user");
        const label = textOf((user?.message as { content?: unknown } | undefined)?.content);
        const status = statusOfEntries(parseLines(raw));
        const subagent: SubagentView = {
          id, label: label ? label.split("\n")[0]!.slice(0, 120) : null,
          model: typeof model?.provider === "string" && typeof model.modelId === "string" ? `${model.provider}/${model.modelId}` : null,
          status: status === "working" && Date.now() - stat.mtimeMs > MAX_AGE_MS ? "unknown" : status,
          started_at: typeof header.timestamp === "string" ? header.timestamp : null,
        };
        return { subagent, entries: all.slice(-300), truncated: offset > 0 || all.length > 300 };
      } catch { /* a changing or unreadable journal is unavailable */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  } catch { /* no valid child directory */ }
  return null;
}
