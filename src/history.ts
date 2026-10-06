import { existsSync, readFileSync } from "node:fs";

export interface HistoryMessage {
  role: string;
  text: string;
}

/** Lit les messages texte d'un fichier de session pi (.jsonl) — les transcripts restent la source de vérité (I5). */
export function readHistory(sessionFile: string, limit = 200): HistoryMessage[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  let lines: string[];
  try {
    lines = readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
  const out: HistoryMessage[] = [];
  for (const line of lines.slice(-1000)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message as { role?: string; content?: unknown } | undefined;
    if (!msg?.role || !Array.isArray(msg.content)) continue;
    const text = (msg.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("");
    if (text.trim()) out.push({ role: msg.role, text });
  }
  return out.slice(-limit);
}
