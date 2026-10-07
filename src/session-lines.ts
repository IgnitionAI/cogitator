import { existsSync, readFileSync } from "node:fs";

/**
 * Lecture best-effort des transcripts `.jsonl` pi — partagée par l'historique et le suivi
 * des fichiers (un transcript absent ou illisible ne doit jamais faire échouer une route).
 */

/** Dernières lignes non vides du transcript, plafonnées (les gros .jsonl ne sont pas relus en entier). */
export function readSessionLines(sessionFile: string, maxLines: number): string[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  try {
    return readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim()).slice(-maxLines);
  } catch {
    return [];
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
