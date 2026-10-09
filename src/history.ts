import { parseJsonLine, readSessionLines } from "./session-lines.js";

export interface HistoryMessage {
  role: string;
  text: string;
}

/** Entrée structurée du transcript (thinking, toolcalls avec args + résultat). */
export type HistoryEntry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; args: string; result?: string; isError?: boolean };

const RESULT_CAP = 4000;
/** Fenêtre de relecture du transcript (nombre de lignes les plus récentes). */
const HISTORY_LINES_SCAN = 2000;

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
}

function prettyArgs(args: unknown): string {
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args, null, 2);
    return s.length > RESULT_CAP ? s.slice(0, RESULT_CAP) + "\n… (tronqué)" : s;
  } catch {
    return String(args);
  }
}

function blockIsError(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return (content as Array<{ type?: string; isError?: boolean }>).some((b) => b?.isError === true);
}

/** Parse le .jsonl pi en entrées ordonnées : user / assistant / thinking / tool (avec résultat). */
export function readEntries(sessionFile: string, limit = 300): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const pendingTools = new Map<string, number>(); // toolCallId → index dans out

  for (const line of readSessionLines(sessionFile, HISTORY_LINES_SCAN)) {
    const entry = parseJsonLine(line);
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      isError?: boolean;
    };
    const content = msg.content;

    if (msg.role === "user") {
      const text = extractText(content).trim();
      if (text) out.push({ type: "user", text });
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          out.push({ type: "thinking", text: block.thinking });
        } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          const last = out[out.length - 1];
          if (last?.type === "assistant") last.text += (last.text ? "\n" : "") + block.text;
          else out.push({ type: "assistant", text: block.text });
        } else if (block?.type === "toolCall") {
          const id = typeof block.id === "string" ? block.id : `tool-${out.length}`;
          pendingTools.set(id, out.length);
          out.push({
            type: "tool",
            id,
            name: typeof block.name === "string" ? block.name : "outil",
            args: prettyArgs(block.arguments),
          });
        }
      }
      continue;
    }
    if (msg.role === "toolResult" && Array.isArray(content)) {
      // pi stocke le toolCallId au niveau du message (pas du block)
      const callId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      const index = callId !== undefined ? pendingTools.get(callId) : undefined;
      const text = extractText(content);
      const capped = text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) + "\n… (tronqué)" : text;
      if (index !== undefined && out[index]?.type === "tool") {
        const tool = out[index] as Extract<HistoryEntry, { type: "tool" }>;
        tool.result = capped;
        tool.isError = msg.isError === true || entry.isError === true || blockIsError(content);
      }
    }
  }
  return out.slice(-limit);
}

/** Compat : liste plate role/text (user + assistant uniquement). */
export function readHistory(sessionFile: string, limit = 200): HistoryMessage[] {
  return readEntries(sessionFile, limit)
    .filter((e): e is Extract<HistoryEntry, { type: "user" | "assistant" }> => e.type === "user" || e.type === "assistant")
    .map((e) => ({ role: e.type, text: e.text }));
}
