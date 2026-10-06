import { existsSync, readFileSync } from "node:fs";

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

function cap(s: string): string {
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + "\n… (tronqué)" : s;
}

function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s.split("\n").filter((l) => l.length > 0).length;
}

/** Parse le .jsonl et retourne les événements edit/write dans l'ordre chronologique. */
export function readFileEvents(sessionFile: string, limit = 500): FileEvent[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  let lines: string[];
  try {
    lines = readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
  const events: FileEvent[] = [];

  for (const line of lines.slice(-3000)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message as { role?: string; content?: unknown };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : "";

    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block?.type !== "toolCall") continue;
      const name = block.name;
      if (name !== "edit" && name !== "write") continue;
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
        const hunks: FileHunk[] = [];
        let additions = 0;
        let deletions = 0;
        for (const sub of subs as Array<Record<string, unknown>>) {
          const oldText = typeof sub.oldText === "string" ? sub.oldText : typeof sub.oldString === "string" ? sub.oldString : "";
          const newText = typeof sub.newText === "string" ? sub.newText : typeof sub.newString === "string" ? sub.newString : "";
          hunks.push({ old: cap(oldText), new: cap(newText) });
          additions += countLines(newText);
          deletions += countLines(oldText);
        }
        events.push({ path, kind: "edit", at, additions, deletions, hunks });
      }
    }
  }
  return events.slice(-limit);
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
