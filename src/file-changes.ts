import { parseJsonLine, readSessionLines } from "./session-lines.js";

export interface FileHunk {
  old: string;
  new: string;
}

/** Un événement de modification de fichier (une opération edit/write dans la session). */
export interface FileEvent {
  path: string;
  kind: "edit" | "write";
  at: string; // ISO timestamp de l'entrée de session
  additions: number;
  deletions: number;
  hunks: FileHunk[]; // edit : un hunk par sous-édition ; write : [{ old: "", new: content }]
}

export interface FileChange {
  path: string;
  kind: "edit" | "write";
  edits: number;
  additions: number;
  deletions: number;
  lastAt: string;
  lastConversationId?: string; // renseigné lors de l'agrégation multi-conversations
}

const TEXT_CAP = 3000;
/** Fenêtre de relecture du transcript pour les événements fichier. */
const FILE_EVENTS_LINES_SCAN = 3000;

/** Une opération edit/write reconnue par ses noms d'outils pi. */
const FILE_TOOLS = new Set(["edit", "write"]);

function cap(s: string): string {
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + "\n…" : s;
}

function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s.split("\n").filter((l) => l.length > 0).length;
}

/** Parse le .jsonl et retourne les événements edit/write dans l'ordre chronologique. */
export function readFileEvents(sessionFile: string, limit = 500): FileEvent[] {
  const events: FileEvent[] = [];

  for (const line of readSessionLines(sessionFile, FILE_EVENTS_LINES_SCAN)) {
    const entry = parseJsonLine(line);
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message as { role?: string; content?: unknown };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : "";

    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block?.type !== "toolCall") continue;
      const name = block.name;
      if (typeof name !== "string" || !FILE_TOOLS.has(name)) continue;
      let args: Record<string, unknown> = {};
      try {
        args = typeof block.arguments === "string"
          ? (JSON.parse(block.arguments) as Record<string, unknown>)
          : (block.arguments as Record<string, unknown>);
      } catch {
        continue;
      }
      const path = typeof args.path === "string" ? args.path : null;
      if (!path) continue;

      if (name === "write") {
        const content = typeof args.content === "string" ? args.content : "";
        events.push({
          path, kind: "write", at,
          additions: countLines(content), deletions: 0,
          hunks: [{ old: "", new: cap(content) }],
        });
      } else {
        // pi : { path, edits: [{ oldText, newText }] } ; variantes oldString/newString tolérées
        const subs = Array.isArray(args.edits) ? args.edits : [args];
        events.push({ path, kind: "edit", at, ...countEditHunks(subs as Array<Record<string, unknown>>) });
      }
    }
  }
  return events.slice(-limit);
}

/** Additionne les hunks d'une opération edit (additions/deletions par ligne nouvelle/ancienne). */
function countEditHunks(subs: Array<Record<string, unknown>>): { additions: number; deletions: number; hunks: FileHunk[] } {
  const hunks: FileHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const sub of subs) {
    const oldText = firstString(sub, "oldText", "oldString");
    const newText = firstString(sub, "newText", "newString");
    hunks.push({ old: cap(oldText), new: cap(newText) });
    additions += countLines(newText);
    deletions += countLines(oldText);
  }
  return { additions, deletions, hunks };
}

/** Première des clés présentes dont la valeur est une chaîne (variantes de nommage pi). */
function firstString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Agrège les événements par chemin (ordre anti-chronologique via lastAt). */
export function readFileChanges(sessionFile: string, limit = 500): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const e of readFileEvents(sessionFile, limit * 2)) {
    const existing = byPath.get(e.path);
    if (existing) {
      existing.edits += 1;
      existing.additions += e.additions;
      existing.deletions += e.deletions;
      existing.kind = existing.kind === "write" ? "write" : e.kind;
      if (e.at > existing.lastAt) existing.lastAt = e.at;
    } else {
      byPath.set(e.path, {
        path: e.path, kind: e.kind, edits: 1,
        additions: e.additions, deletions: e.deletions, lastAt: e.at,
      });
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, limit);
}

/** Détail d'un fichier : toutes les opérations qui le touchent (pour le diff). */
export function readFileDetail(sessionFile: string, path: string, limit = 50): FileEvent[] {
  return readFileEvents(sessionFile, limit * 3)
    .filter((e) => e.path === path)
    .slice(-limit);
}
