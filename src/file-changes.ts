import { existsSync, readFileSync } from "node:fs";

export interface FileChange {
  path: string;
  kind: "edit" | "write";
  edits: number; // nombre d'opérations
  additions: number; // lignes ajoutées (approx.)
  deletions: number; // lignes supprimées (approx.)
  lastAt: string; // ISO timestamp de la dernière modification
}

function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s.split("\n").filter((l) => l.length > 0).length;
}

/**
 * Extrait les fichiers modifiés d'une session pi (.jsonl) depuis les toolcalls
 * edit/write. Agrégation par chemin, ordre anti-chronologique implicite (tri lastAt desc).
 */
export function readFileChanges(sessionFile: string, limit = 500): FileChange[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  let lines: string[];
  try {
    lines = readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
  const byPath = new Map<string, FileChange>();

  for (const line of lines.slice(-3000)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message as { role?: string; content?: unknown; toolCallId?: string };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : "";

    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block?.type !== "toolCall") continue;
      const name = block.name;
      if (name !== "edit" && name !== "write") continue;
      let args: Record<string, unknown> = {};
      try {
        args = typeof block.arguments === "string" ? (JSON.parse(block.arguments) as Record<string, unknown>) : (block.arguments as Record<string, unknown>);
      } catch {
        continue;
      }
      const path = typeof args.path === "string" ? args.path : null;
      if (!path) continue;

      let additions = 0;
      let deletions = 0;
      if (name === "edit") {
        // pi : { path, edits: [{ oldText, newText }] } (batch) ; variantes oldString/newString tolérées
        const editsList = Array.isArray(args.edits) ? args.edits : [args];
        for (const sub of editsList as Array<Record<string, unknown>>) {
          additions += countLines(typeof sub.newText === "string" ? sub.newText : typeof sub.newString === "string" ? sub.newString : undefined);
          deletions += countLines(typeof sub.oldText === "string" ? sub.oldText : typeof sub.oldString === "string" ? sub.oldString : undefined);
        }
      } else {
        additions = countLines(typeof args.content === "string" ? args.content : undefined);
      }

      const existing = byPath.get(path);
      if (existing) {
        existing.edits += 1;
        existing.additions += additions;
        existing.deletions += deletions;
        existing.kind = existing.kind === "write" ? "write" : name; // write prime sur edit
        if (at) existing.lastAt = at;
      } else {
        byPath.set(path, { path, kind: name as "edit" | "write", edits: 1, additions, deletions, lastAt: at });
      }
    }
  }

  return [...byPath.values()]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, limit);
}
