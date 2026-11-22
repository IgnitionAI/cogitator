/**
 * Assistant du terminal web : trois aides courtes, jamais d'exécution.
 *  - `command`  : langage naturel → une commande shell (insérée, pas lancée) ;
 *  - `complete` : suite probable de la commande en cours (texte fantôme) ;
 *  - `explain`  : explication d'un échec + correctif proposé.
 *
 * Le modèle est celui d'un agent Cogitator (défaut : l'agent par défaut), appelé en une
 * passe avec les identifiants du fournisseur déjà configurés pour pi (auth.json / models.json).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piAiRoot, piCodingAgent } from "./host-pi.js";
import type { Paths } from "./paths.js";
import { fileCredentialStore } from "./provider-login.js";

export type AssistMode = "command" | "complete" | "explain";

export interface AssistRequest {
  mode: AssistMode;
  /** Demande (command), ligne en cours (complete) ou commande échouée (explain). */
  input: string;
  /** Dernières lignes visibles du terminal (bornées côté serveur). */
  output?: string;
  cwd?: string;
  shell?: string;
  exitCode?: number;
}

export interface AssistResult {
  text: string;
  /** explain : commande corrigée, si le modèle en propose une. */
  fix?: string;
}

export interface ModelTarget { provider: string; model: string }

/** Appel brut au modèle : injectable (tests), production via pi-ai. */
export type CompleteFn = (target: ModelTarget, system: string, user: string, opts: { maxTokens: number; signal: AbortSignal }) => Promise<string>;

const OUTPUT_CAP = 4000;
const INPUT_CAP = 2000;
const LIMITS: Record<AssistMode, { maxTokens: number; timeoutMs: number }> = {
  command: { maxTokens: 300, timeoutMs: 30_000 },
  complete: { maxTokens: 80, timeoutMs: 8_000 },
  explain: { maxTokens: 600, timeoutMs: 45_000 },
};

const SYSTEM: Record<AssistMode, string> = {
  command: "You turn requests into shell commands for a Linux server. Reply with exactly one shell command on a single line (use && or pipes if needed). No explanation, no markdown, no code fences. Prefer safe, non-destructive commands; never add sudo unless the request requires it.",
  complete: "You autocomplete shell commands. Given the partial command line, reply with ONLY the characters to append to complete it (no repetition of the existing text, no explanation, no markdown). Reply with an empty answer if unsure.",
  explain: "You are a concise Linux expert. Explain in 1-3 short sentences why the command failed, in the user's language when it is evident from the output, otherwise in English. If a corrected command exists, add a last line exactly in the form `FIX: <command>`. No markdown headings, no code fences.",
};

function tail(text: string | undefined, cap: number): string {
  if (!text) return "";
  return text.length > cap ? text.slice(-cap) : text;
}

export function buildPrompt(req: AssistRequest): string {
  const context = [
    `Shell: ${req.shell ?? "bash"}`,
    req.cwd ? `Working directory: ${req.cwd}` : "",
    req.exitCode !== undefined ? `Exit code: ${req.exitCode}` : "",
  ].filter(Boolean).join("\n");
  const output = tail(req.output, OUTPUT_CAP);
  const input = tail(req.input, INPUT_CAP);
  const label = req.mode === "command" ? "Request" : req.mode === "complete" ? "Partial command line" : "Failed command";
  return `${context}\n${output ? `\nRecent terminal output:\n${output}\n` : ""}\n${label}: ${input}`;
}

/** Retire clôtures markdown, préfixes de prompt et lignes superflues. */
export function cleanCommand(raw: string): string {
  let text = raw.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  text = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return text.replace(/^\$\s+/, "").replace(/^`(.*)`$/, "$1").trim();
}

export function parseExplain(raw: string): AssistResult {
  const lines = raw.trim().replace(/```[a-z]*\n?|```/gi, "").split("\n");
  const fixIndex = lines.findIndex((l) => /^\s*FIX:\s*/i.test(l));
  const fix = fixIndex >= 0 ? cleanCommand(lines[fixIndex]!.replace(/^\s*FIX:\s*/i, "")) : undefined;
  const text = lines.filter((_, i) => i !== fixIndex).join("\n").trim();
  return { text, ...(fix ? { fix } : {}) };
}

export async function runAssist(complete: CompleteFn, target: ModelTarget, req: AssistRequest, signal?: AbortSignal): Promise<AssistResult> {
  const limit = LIMITS[req.mode];
  const timeout = AbortSignal.timeout(limit.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const raw = await complete(target, SYSTEM[req.mode], buildPrompt(req), { maxTokens: limit.maxTokens, signal: combined });
  if (req.mode === "explain") return parseExplain(raw);
  if (req.mode === "command") return { text: cleanCommand(raw) };
  // complete : la suite seule ; si le modèle a répété la ligne, on retire le préfixe.
  let suffix = raw.replace(/```[a-z]*\n?|```/gi, "").split("\n")[0] ?? "";
  if (suffix.trimStart().startsWith(req.input.trim()) && req.input.trim()) suffix = suffix.trimStart().slice(req.input.trim().length);
  return { text: suffix.replace(/\s+$/, "") };
}

interface CompatModule {
  completeSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string }>;
}
let compat: Promise<CompatModule> | undefined;

/** Appel réel : ModelRuntime de pi (mêmes fichiers que les sessions), puis completeSimple. */
export function piComplete(paths: Paths): CompleteFn {
  return async (target, system, user, opts) => {
    compat ??= import(pathToFileURL(join(piAiRoot, "dist/compat.js")).href) as Promise<CompatModule>;
    const { completeSimple } = await compat;
    const runtime = await piCodingAgent.ModelRuntime.create({
      credentials: fileCredentialStore(paths.piAuthJson),
      modelsPath: paths.piModelsJson,
      allowModelNetwork: false,
    });
    const model = runtime.getModel(target.provider, target.model);
    if (!model) throw new Error(`Modèle introuvable : ${target.provider}/${target.model}`);
    const resolved = await runtime.getAuth(model, { signal: opts.signal });
    if (!resolved || (!resolved.auth.apiKey && !resolved.auth.headers)) throw new Error(`Fournisseur non connecté : ${target.provider}`);
    const requestModel = resolved.auth.baseUrl ? { ...model, baseUrl: resolved.auth.baseUrl } : model;
    const message = await completeSimple(requestModel, {
      systemPrompt: system,
      messages: [{ role: "user", content: user, timestamp: Date.now() }],
    }, { apiKey: resolved.auth.apiKey, headers: resolved.auth.headers, env: resolved.env, maxTokens: opts.maxTokens, signal: opts.signal });
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "Échec de l'appel au modèle");
    return message.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  };
}
