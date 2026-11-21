/**
 * Outils MCP Cogitator — source unique partagée par les deux transports :
 *  - stdio (`mcp-server.ts`, le Majordome lancé par pi) ;
 *  - Streamable HTTP (`mcp-http.ts`, agents externes : Claude, GPT, bots…).
 *
 * Chaque outil appelle l'API Cogitator via `call(method, path, body)`. Le transport
 * fournit `call` : requête propriétaire (stdio) ou dispatch interne autorisé (HTTP).
 * Le scope `read` n'enregistre que les outils en lecture ; `call` le refait respecter.
 */
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CARD_PRIORITIES, CARD_STATUSES, thinkingSchema } from "./schemas.js";

export type McpScope = "read" | "full";
export const MCP_SCOPES: readonly McpScope[] = ["read", "full"];

export type CogitatorCall = (method: string, path: string, body?: unknown) => Promise<unknown>;

export interface CogitatorToolOptions {
  call: CogitatorCall;
  /** Défaut : full. `read` n'expose aucun outil qui modifie l'état. */
  scope?: McpScope;
  /** Conversation appelante (stdio dans une session pi) : origine des messages team_send. */
  fromConversationId?: string;
  /** Auteur par défaut des commentaires de board. */
  author?: string;
  /** Intervalle de sondage de `cogitator_send_message` en attente (tests). */
  pollMs?: number;
}

interface ToolExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
}

type ToolFn = (args: Record<string, unknown>, extra: ToolExtra) => Promise<unknown>;

/** Segment d'URL sûr : un id ne peut jamais viser une autre route. */
const enc = (value: unknown): string => encodeURIComponent(String(value));

const DEFAULT_WAIT_S = 120;
const MAX_WAIT_S = 900;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 300;

interface HistoryEntry { type: string; text?: string; name?: string; args?: string; result?: string; isError?: boolean }

export function registerCogitatorTools(server: McpServer, opts: CogitatorToolOptions): string[] {
  const scope = opts.scope ?? "full";
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const call: CogitatorCall = (method, path, body) => {
    if (scope === "read" && method !== "GET") return Promise.reject(new Error("Scope read : écriture refusée"));
    return opts.call(method, path, body);
  };
  const names: string[] = [];

  function addTool(name: string, description: string, inputSchema: Record<string, z.ZodType>, readOnly: boolean, fn: ToolFn, destructive = false): void {
    if (scope === "read" && !readOnly) return;
    names.push(name);
    server.registerTool(name, {
      description,
      inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && destructive, openWorldHint: false },
    }, async (args: Record<string, unknown>, extra: unknown) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await fn(args, extra as ToolExtra), null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Erreur: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    });
  }
  const read = (name: string, description: string, inputSchema: Record<string, z.ZodType>, fn: ToolFn) => addTool(name, description, inputSchema, true, fn);
  const write = (name: string, description: string, inputSchema: Record<string, z.ZodType>, fn: ToolFn) => addTool(name, description, inputSchema, false, fn);
  const destroy = (name: string, description: string, inputSchema: Record<string, z.ZodType>, fn: ToolFn) => addTool(name, description, inputSchema, false, fn, true);

  // ---------- Agents ----------

  read("cogitator_list_agents", "Liste les presets d'agents Cogitator (sans prompts).", {}, () => call("GET", "/api/agents"));

  read("cogitator_get_agent", "Détail complet d'un agent (prompt, skills, MCP, subagents).",
    { id: z.string() },
    (a) => call("GET", `/api/agents/${enc(a.id)}`));

  write("cogitator_create_agent", "Crée un agent (preset) : provider+modèle+thinking+skills+MCP+prompt+subagents. Génère les définitions herdr au save.",
    {
      name: z.string().describe("Nom d'affichage"),
      provider: z.string().describe("ex: openai, deepseek, kimi-coding"),
      model: z.string().describe("id du modèle dans le provider"),
      description: z.string().optional(),
      thinking: thinkingSchema.optional(),
      system_prompt: z.string().optional().describe("Prompt de scope de l'agent"),
      skills: z.array(z.string()).optional().describe("Chemins absolus de skills"),
      tools: z.array(z.string()).optional().describe("Allowlist d'outils (absent = tous)"),
    },
    (a) => call("POST", "/api/agents", a));

  write("cogitator_update_agent", "Modifie un agent existant (mêmes champs que create, écrase la config).",
    {
      id: z.string(),
      name: z.string(),
      provider: z.string(),
      model: z.string(),
      description: z.string().optional(),
      thinking: thinkingSchema.nullable().optional(),
      system_prompt: z.string().optional(),
      skills: z.array(z.string()).optional(),
      tools: z.array(z.string()).nullable().optional(),
    },
    (a) => {
      const { id, ...body } = a;
      return call("PUT", `/api/agents/${enc(id)}`, body);
    });

  destroy("cogitator_delete_agent", "Supprime un agent et ses définitions herdr noo-*.",
    { id: z.string() },
    (a) => call("DELETE", `/api/agents/${enc(a.id)}`));

  write("cogitator_validate_agent", "Valide un agent (provider/modèle du catalogue, skills, MCP, auth).",
    { id: z.string() },
    (a) => call("POST", `/api/agents/${enc(a.id)}/validate`));

  write("cogitator_set_default_agent", "Définit l'agent par défaut global (utilisé quand une conversation ne précise rien).",
    { id: z.string() },
    (a) => call("POST", `/api/agents/${enc(a.id)}/default`));

  // ---------- Schedules (cron) ----------

  read("cogitator_list_schedules", "Liste les tâches cron (avec prochain run calculé).", {}, () => call("GET", "/api/schedules"));

  write("cogitator_create_schedule", "Crée une tâche cron : un prompt tiré contre un agent à heure fixe.",
    {
      name: z.string(),
      cron_expr: z.string().describe("5 champs: min heure jour mois jour-sem — ex: '0 9 * * 1-5'"),
      prompt: z.string(),
      agent_id: z.string(),
      workspace_id: z.string(),
      output_policy: z.enum(["append_session", "new_session"]).optional(),
      busy_policy: z.enum(["skip", "queue", "kill"]).optional(),
      catchup: z.boolean().optional(),
    },
    (a) => call("POST", "/api/schedules", a));

  write("cogitator_update_schedule", "Modifie une tâche cron (champs partiels, enabled inclus).",
    {
      id: z.string(),
      name: z.string().optional(),
      cron_expr: z.string().optional(),
      prompt: z.string().optional(),
      output_policy: z.enum(["append_session", "new_session"]).optional(),
      busy_policy: z.enum(["skip", "queue", "kill"]).optional(),
      catchup: z.boolean().optional(),
      enabled: z.boolean().optional(),
    },
    (a) => {
      const { id, ...body } = a;
      return call("PUT", `/api/schedules/${enc(id)}`, body);
    });

  destroy("cogitator_delete_schedule", "Supprime une tâche cron et l'historique de ses runs.",
    { id: z.string() },
    (a) => call("DELETE", `/api/schedules/${enc(a.id)}`));

  write("cogitator_fire_schedule", "Déclenche immédiatement une tâche cron.",
    { id: z.string() },
    (a) => call("POST", `/api/schedules/${enc(a.id)}/run`));

  read("cogitator_list_runs", "Historique des runs d'une tâche cron (status, session, erreur).",
    { id: z.string() },
    (a) => call("GET", `/api/schedules/${enc(a.id)}/runs`));

  // ---------- Workspaces ----------

  read("cogitator_list_workspaces", "Liste les workspaces (dossiers + nb de conversations).", {}, () => call("GET", "/api/workspaces"));

  write("cogitator_create_workspace", "Enregistre un dossier comme workspace.",
    { dir: z.string().describe("Chemin absolu du dossier (doit exister)"), name: z.string().optional() },
    (a) => call("POST", "/api/workspaces", a));

  destroy("cogitator_delete_workspace", "Supprime un workspace (les conversations deviennent libres).",
    { id: z.string() },
    (a) => call("DELETE", `/api/workspaces/${enc(a.id)}`));

  // ---------- Conversations ----------

  read("cogitator_list_conversations", "Liste les conversations (toutes, ou filtrées par workspace).",
    { workspace_id: z.string().optional() },
    (a) => call("GET", `/api/conversations${a.workspace_id ? `?workspace_id=${enc(a.workspace_id)}` : ""}`));

  read("cogitator_get_conversation", "État d'une conversation : agent, modèle, workspace, runtime, live/streaming (tour en cours).",
    { conversation_id: z.string() },
    (a) => call("GET", `/api/conversations/${enc(a.conversation_id)}`));

  read("cogitator_read_conversation", "Lit le transcript d'une conversation : messages user/assistant, et optionnellement réflexion et appels d'outils (résultats tronqués).",
    {
      conversation_id: z.string(),
      limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional().describe(`Nombre d'entrées les plus récentes (défaut ${DEFAULT_READ_LIMIT})`),
      include_tools: z.boolean().optional().describe("Inclut les appels d'outils et la réflexion (défaut false)"),
    },
    async (a) => {
      const limit = typeof a.limit === "number" ? a.limit : DEFAULT_READ_LIMIT;
      const entries = await historyEntries(call, String(a.conversation_id));
      const filtered = a.include_tools ? entries : entries.filter((e) => e.type === "user" || e.type === "assistant");
      return { entries: filtered.slice(-limit) };
    });

  write("cogitator_create_conversation", "Crée une conversation avec un agent (ou provider libre) et un prompt initial optionnel. Utilise cogitator_send_message avec wait=true pour obtenir une réponse.",
    {
      agent_id: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      workspace_id: z.string().optional(),
      prompt: z.string().optional(),
    },
    (a) => call("POST", "/api/conversations", a));

  write("cogitator_send_message", "Envoie un message utilisateur à une conversation. Avec wait=true (défaut), attend la fin du tour de l'agent en émettant des notifications de progression, puis renvoie sa réponse.",
    {
      conversation_id: z.string(),
      text: z.string().min(1),
      wait: z.boolean().optional().describe("Attendre la réponse de l'agent (défaut true)"),
      timeout_seconds: z.number().int().min(1).max(MAX_WAIT_S).optional().describe(`Attente maximale (défaut ${DEFAULT_WAIT_S} s). Au-delà : status=running, relire avec cogitator_read_conversation.`),
    },
    async (a, extra) => {
      const id = String(a.conversation_id);
      const before = a.wait === false ? [] : await historyEntries(call, id);
      await call("POST", `/api/conversations/${enc(id)}/messages`, { text: a.text, requestId: randomUUID() });
      if (a.wait === false) return { ok: true, status: "sent" };
      const timeoutMs = (typeof a.timeout_seconds === "number" ? a.timeout_seconds : DEFAULT_WAIT_S) * 1000;
      return waitForTurn(call, id, before, timeoutMs, pollMs, extra);
    });

  write("cogitator_stop_conversation", "Interrompt le tour en cours d'une conversation.",
    { conversation_id: z.string() },
    (a) => call("POST", `/api/conversations/${enc(a.conversation_id)}/stop`));

  write("team_send", "Envoie un message durable à une conversation (file lane/queue_item, limite de sauts, idempotence).",
    {
      conversation_id: z.string().describe("Conversation destinataire"),
      body: z.string(),
      idempotency_key: z.string().optional(),
    },
    (a) => call("POST", "/api/team/send", {
      conversation_id: a.conversation_id,
      body: a.body,
      idempotency_key: a.idempotency_key,
      from_conversation_id: opts.fromConversationId,
    }));

  // ---------- Registry ----------

  read("cogitator_list_providers", "Liste les providers pi (catalogue + statut auth + modèles).", {}, () => call("GET", "/api/providers"));

  read("cogitator_list_skills", "Liste les skills disponibles (name, description, path).", {}, () => call("GET", "/api/skills"));

  write("cogitator_import_skills", "Importe des skills : repo GitHub (ex: IgnitionAI/skills), dossier local, ou commande CLI (ex: 'npx aiblueprint-cli@latest skills update'). Les dossiers contenant un SKILL.md sont copiés vers ~/.agents/skills/.",
    {
      source: z.string().describe("URL GitHub (https://github.com/owner/repo) ou chemin absolu d'un dossier local"),
      overwrite: z.boolean().optional().describe("Écrase les skills existants du même nom (défaut: skip)"),
    },
    (a) => call("POST", "/api/skills/import", a));

  read("cogitator_health", "État du serveur Cogitator (version, pi, sessions, base).", {}, () => call("GET", "/api/health"));

  // ---------- Board kanban (gestion de projet du workspace) ----------

  read("cogitator_board_list", "Liste les cartes du board kanban d'un workspace (statut, priorité, labels, assigné, relations).",
    { workspace_id: z.string() },
    (a) => call("GET", `/api/workspaces/${enc(a.workspace_id)}/board`));

  write("cogitator_board_create_card", "Crée une carte sur le board : titre, description, statut, priorité, labels, assigné (agent id), conversations liées, relations blocks/blocked_by.",
    {
      workspace_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(CARD_STATUSES).optional(),
      priority: z.enum(CARD_PRIORITIES).optional(),
      labels: z.array(z.string()).optional(),
      assignee_agent_id: z.string().nullable().optional(),
      conversation_ids: z.array(z.string()).optional(),
    },
    (a) => call("POST", `/api/workspaces/${enc(a.workspace_id)}/board/cards`, a));

  write("cogitator_board_update_card", "Met à jour une carte (mêmes champs que create ; écrase la config). Relations : blocks/blocked_by (ids de cartes).",
    {
      workspace_id: z.string(),
      card_id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(CARD_STATUSES).optional(),
      priority: z.enum(CARD_PRIORITIES).optional(),
      labels: z.array(z.string()).optional(),
      assignee_agent_id: z.string().nullable().optional(),
      conversation_ids: z.array(z.string()).optional(),
      blocks: z.array(z.string()).optional(),
      blocked_by: z.array(z.string()).optional(),
    },
    (a) => {
      const { workspace_id, card_id, ...body } = a;
      return call("PUT", `/api/workspaces/${enc(workspace_id)}/board/cards/${enc(card_id)}`, body);
    });

  write("cogitator_board_move", "Déplace une carte vers une colonne (statut).",
    {
      workspace_id: z.string(),
      card_id: z.string(),
      status: z.enum(CARD_STATUSES),
    },
    (a) => call("POST", `/api/workspaces/${enc(a.workspace_id)}/board/cards/${enc(a.card_id)}/move`, { status: a.status }));

  write("cogitator_board_start_work", "Lance l'agent Cogitator assigné sur un ticket : spawn une conversation dans le workspace avec le contenu de la carte, lie la conversation (rollup activité) et passe la carte en in_progress. Nécessite un assignee_agent_id (extra Cogitator) sur la carte.",
    {
      workspace_id: z.string(),
      card_id: z.string(),
      extra: z.string().optional().describe("Précision complémentaire à ajouter au prompt"),
    },
    (a) => call("POST", `/api/workspaces/${enc(a.workspace_id)}/board/cards/${enc(a.card_id)}/start`, { extra: a.extra }));

  write("cogitator_board_comment", `Ajoute un commentaire à une carte (append-only). Auteur par défaut : ${opts.author ?? "Majordome"}.`,
    {
      workspace_id: z.string(),
      card_id: z.string(),
      text: z.string(),
      author: z.string().optional(),
    },
    (a) => call("POST", `/api/workspaces/${enc(a.workspace_id)}/board/cards/${enc(a.card_id)}/comments`, { text: a.text, author: a.author ?? opts.author ?? "Majordome" }));

  return names;
}

async function historyEntries(call: CogitatorCall, conversationId: string): Promise<HistoryEntry[]> {
  const data = await call("GET", `/api/conversations/${enc(conversationId)}/history`) as { entries?: HistoryEntry[] };
  return Array.isArray(data.entries) ? data.entries : [];
}

async function isStreaming(call: CogitatorCall, conversationId: string): Promise<boolean> {
  const data = await call("GET", `/api/conversations/${enc(conversationId)}`) as { streaming?: unknown };
  return data.streaming === true;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((done, reject) => {
  if (signal.aborted) return reject(new Error("Annulé"));
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); done(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new Error("Annulé")); };
  signal.addEventListener("abort", onAbort, { once: true });
});

/**
 * Attend la fin du tour : le transcript a grandi et la conversation ne streame plus.
 * Le transcript est fenêtré (dernières entrées) : on compare aussi le dernier élément.
 */
async function waitForTurn(call: CogitatorCall, id: string, before: HistoryEntry[], timeoutMs: number, pollMs: number, extra: ToolExtra): Promise<unknown> {
  const started = Date.now();
  const token = extra._meta?.progressToken;
  let tick = 0;
  let sawStreaming = false;
  for (;;) {
    await sleep(pollMs, extra.signal);
    tick++;
    const streaming = await isStreaming(call, id);
    sawStreaming ||= streaming;
    const entries = await historyEntries(call, id);
    const last = entries[entries.length - 1];
    const previous = before[before.length - 1];
    const grown = sawStreaming || entries.length > before.length || JSON.stringify(last) !== JSON.stringify(previous);
    if (!streaming && grown && last?.type === "assistant") {
      const lastUser = entries.map((e) => e.type).lastIndexOf("user");
      const turn = entries.slice(lastUser + 1);
      return {
        status: "completed",
        reply: turn.filter((e) => e.type === "assistant").map((e) => e.text ?? "").join("\n"),
        tools_used: turn.filter((e) => e.type === "tool").map((e) => ({ name: e.name, isError: e.isError === true })),
        elapsed_ms: Date.now() - started,
      };
    }
    if (token !== undefined) {
      await extra.sendNotification({ method: "notifications/progress", params: {
        progressToken: token, progress: tick,
        message: streaming ? `agent en cours (${Math.round((Date.now() - started) / 1000)} s)` : "en attente du démarrage du tour",
      } }).catch(() => undefined);
    }
    if (Date.now() - started >= timeoutMs) {
      return { status: "running", hint: "Le tour continue : relire avec cogitator_read_conversation ou rappeler plus tard.", elapsed_ms: Date.now() - started };
    }
  }
}
