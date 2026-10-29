import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/** Répertoire des journaux enfants pour une session parente donnée. */
export function tasksDirFor(sessionFile: string): string {
  return join(dirname(sessionFile), basename(sessionFile).replace(/\.jsonl$/, ""), "tasks");
}

/** Identifiant de session porté par l'en-tête du journal parent, null si illisible. */
export function parentSessionIdOf(sessionFile: string): string | null {
  try {
    const header = JSON.parse(readFileSync(sessionFile, "utf8").slice(0, 2_000).split("\n")[0]!) as { id?: string };
    return typeof header.id === "string" ? header.id : null;
  } catch {
    return null;
  }
}

function parseLines(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
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
export function readSubagent(file: string): SubagentView | null {
  let head: string;
  let headEntries: Record<string, unknown>[];
  let tail: string;
  let mtimeMs: number;
  try {
    const size = statSync(file).size;
    mtimeMs = statSync(file).mtimeMs;
    const raw = readFileSync(file, "utf8");
    // Le préambule système d'un enfant pèse ~120 Kio : on élargit la fenêtre jusqu'à la
    // première consigne utilisateur, bornée à 1 Mio (au-delà, libellé laissé vide).
    headEntries = [];
    head = "";
    for (const window of HEAD_WINDOWS) {
      head = raw.slice(0, window);
      headEntries = parseLines(head);
      if (size <= window || headEntries.some((entry) => (entry.message as { role?: string } | undefined)?.role === "user")) break;
    }
    tail = size > head.length ? raw.slice(Math.max(0, size - TAIL_BYTES)) : head;
  } catch {
    return null;
  }
  const header = headEntries.find((entry) => entry.type === "session") as { id?: string; timestamp?: string } | undefined;
  if (!header?.id) return null;
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
    started_at: header.timestamp ?? null,
  };
}

/**
 * Sous-agents d'une conversation. `live: false` ⇔ la conversation n'a pas de session pi
 * (rien à inspecter) ; un répertoire absent ou vide est un état normal → `live: true, []`.
 */
export function listSubagents(sessionFile: string | null): { live: boolean; subagents: SubagentView[] } {
  if (!sessionFile || !existsSync(sessionFile)) return { live: false, subagents: [] };
  const dir = tasksDirFor(sessionFile);
  if (!existsSync(dir)) return { live: true, subagents: [] };
  const parentId = parentSessionIdOf(sessionFile);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, MAX_SUBAGENTS);
  const subagents: SubagentView[] = [];
  for (const file of files) {
    // Le répertoire est dérivé du nom de la session parente ; le lien déclaré dans
    // l'enfant est revérifié pour qu'un dossier recyclé ne fuite pas vers une autre
    // conversation.
    const declared = readFileSync(file, "utf8").slice(0, 2_000);
    const parent = (parseLines(declared).find((entry) => entry.type === "session") as { parentSession?: string } | undefined)
      ?.parentSession;
    if (parentId && parent && parent !== parentId) continue;
    const view = readSubagent(file);
    if (view) subagents.push(view);
  }
  return { live: true, subagents };
}
