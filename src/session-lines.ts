import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Lecture best-effort des transcripts `.jsonl` pi — partagée par l'historique et le suivi
 * des fichiers (un transcript absent ou illisible ne doit jamais faire échouer une route).
 */

/** Fenêtre d'octets lue depuis la fin du fichier (les gros .jsonl ne sont pas relus en entier). */
export const DEFAULT_SESSION_TAIL_BYTES = 2 * 1024 * 1024;

/** Dernières lignes non vides du transcript, plafonnées en lignes et en octets. */
export function readSessionLines(sessionFile: string, maxLines: number, maxBytes = DEFAULT_SESSION_TAIL_BYTES): string[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, constants.O_RDONLY);
    const stat = fstatSync(fd);
    const window = Math.min(stat.size, Math.max(0, maxBytes));
    if (!window) return [];
    const buf = Buffer.alloc(window);
    const offset = stat.size - window;
    let read = 0;
    while (read < window) {
      const n = readSync(fd, buf, read, window - read, offset + read);
      if (!n) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    if (offset > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? text : text.slice(nl + 1);
    }
    return text.split("\n").filter((line) => line.trim()).slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Parse une ligne de transcript en objet ; null si la ligne n'est pas un objet JSON. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}
