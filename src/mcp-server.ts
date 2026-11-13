#!/usr/bin/env node
/**
 * Serveur MCP Cogitator (stdio) — expose l'API Cogitator en outils pour les agents pi.
 * Transporte toutes les requêtes vers le serveur HTTP local (COGITATOR_URL).
 *
 * C'est le mécanisme du "Majordome" : un agent pi qui manipule Cogitator
 * (agents, crons, workspaces, conversations) via des outils MCP natifs.
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ownerRequest } from "./owner-transport.js";
import { packageVersion } from "./pi.js";
import { CARD_PRIORITIES, CARD_STATUSES, thinkingSchema } from "./schemas.js";

const call = ownerRequest;

/** Identifiants persistés : `crypto.randomUUID()` (agents, workspaces, cron, conversations). */
export const mcpPathIdSchema = z.string().uuid("identifiant UUID requis");

export function mcpEncodeId(id: unknown): string {
  return encodeURIComponent(mcpPathIdSchema.parse(id));
}

export function mcpAgentPath(id: unknown, extra: "" | "/validate" | "/default" = ""): string {
  return `/api/agents/${mcpEncodeId(id)}${extra}`;
}

export function mcpSchedulePath(id: unknown, extra: "" | "/run" | "/runs" = ""): string {
  return `/api/schedules/${mcpEncodeId(id)}${extra}`;
}

export function mcpWorkspacePath(id: unknown, extra = ""): string {
  return `/api/workspaces/${mcpEncodeId(id)}${extra}`;
}

export function mcpConversationsListPath(workspaceId?: unknown): string {
  if (workspaceId == null || workspaceId === "") return "/api/conversations";
  return `/api/conversations?workspace_id=${encodeURIComponent(mcpPathIdSchema.parse(workspaceId))}`;
}

const server = new McpServer({
  name: "cogitator",
  version: packageVersion(),
});

/** Enveloppe un outil : résultat JSON en texte, erreur remontée à l'agent (jamais d'exception brute). */
function addTool(
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodType>,
  fn: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(args), null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erreur: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });
}

// ---------- Agents ----------

addTool("cogitator_list_agents", "Liste les presets d'agents Cogitator (sans prompts).", {}, () => call("GET", "/api/agents"));

addTool("cogitator_get_agent", "Détail complet d'un agent (prompt, skills, MCP, subagents).",
  { id: mcpPathIdSchema },
  (a) => call("GET", mcpAgentPath(a.id)));

addTool("cogitator_create_agent", "Crée un agent (preset) : provider+modèle+thinking+skills+MCP+prompt+subagents. Génère les définitions herdr au save.",
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

addTool("cogitator_update_agent", "Modifie un agent existant (mêmes champs que create, écrase la config).",
  {
    id: mcpPathIdSchema,
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
    return call("PUT", mcpAgentPath(id), body);
  });

addTool("cogitator_delete_agent", "Supprime un agent et ses définitions herdr noo-*.",
  { id: mcpPathIdSchema },
  (a) => call("DELETE", mcpAgentPath(a.id)));

addTool("cogitator_validate_agent", "Valide un agent (provider/modèle du catalogue, skills, MCP, auth).",
  { id: mcpPathIdSchema },
  (a) => call("POST", mcpAgentPath(a.id, "/validate")));

addTool("cogitator_set_default_agent", "Définit l'agent par défaut global (utilisé quand une conversation ne précise rien).",
  { id: mcpPathIdSchema },
  (a) => call("POST", mcpAgentPath(a.id, "/default")));

// ---------- Schedules (cron) ----------

addTool("cogitator_list_schedules", "Liste les tâches cron (avec prochain run calculé).", {}, () => call("GET", "/api/schedules"));

addTool("cogitator_create_schedule", "Crée une tâche cron : un prompt tiré contre un agent à heure fixe.",
  {
    name: z.string(),
    cron_expr: z.string().describe("5 champs: min heure jour mois jour-sem — ex: '0 9 * * 1-5'"),
    prompt: z.string(),
    agent_id: mcpPathIdSchema,
    workspace_id: mcpPathIdSchema,
    output_policy: z.enum(["append_session", "new_session"]).optional(),
    busy_policy: z.enum(["skip", "queue", "kill"]).optional(),
    catchup: z.boolean().optional(),
  },
  (a) => call("POST", "/api/schedules", a));

addTool("cogitator_update_schedule", "Modifie une tâche cron (champs partiels, enabled inclus).",
  {
    id: mcpPathIdSchema,
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
    return call("PUT", mcpSchedulePath(id), body);
  });

addTool("cogitator_delete_schedule", "Supprime une tâche cron et l'historique de ses runs.",
  { id: mcpPathIdSchema },
  (a) => call("DELETE", mcpSchedulePath(a.id)));

addTool("cogitator_fire_schedule", "Déclenche immédiatement une tâche cron.",
  { id: mcpPathIdSchema },
  (a) => call("POST", mcpSchedulePath(a.id, "/run")));

addTool("cogitator_list_runs", "Historique des runs d'une tâche cron (status, session, erreur).",
  { id: mcpPathIdSchema },
  (a) => call("GET", mcpSchedulePath(a.id, "/runs")));

// ---------- Workspaces ----------

addTool("cogitator_list_workspaces", "Liste les workspaces (dossiers + nb de conversations).", {}, () => call("GET", "/api/workspaces"));

addTool("cogitator_create_workspace", "Enregistre un dossier comme workspace.",
  { dir: z.string().describe("Chemin absolu du dossier (doit exister)"), name: z.string().optional() },
  (a) => call("POST", "/api/workspaces", a));

addTool("cogitator_delete_workspace", "Supprime un workspace (les conversations deviennent libres).",
  { id: mcpPathIdSchema },
  (a) => call("DELETE", mcpWorkspacePath(a.id)));

// ---------- Conversations ----------

addTool("cogitator_list_conversations", "Liste les conversations (toutes, ou filtrées par workspace).",
  { workspace_id: mcpPathIdSchema.optional() },
  (a) => call("GET", mcpConversationsListPath(a.workspace_id)));

addTool("cogitator_create_conversation", "Crée une conversation avec un agent (ou provider libre) et un prompt initial optionnel.",
  {
    agent_id: mcpPathIdSchema.optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    workspace_id: mcpPathIdSchema.optional(),
    prompt: z.string().optional(),
  },
  (a) => call("POST", "/api/conversations", a));

addTool("team_send", "Envoie un message durable à une conversation (file lane/queue_item, limite de sauts, idempotence).",
  {
    conversation_id: mcpPathIdSchema.describe("Conversation destinataire"),
    body: z.string(),
    idempotency_key: z.string().optional(),
  },
  (a) => call("POST", "/api/team/send", {
    conversation_id: a.conversation_id,
    body: a.body,
    idempotency_key: a.idempotency_key,
    from_conversation_id: process.env.COGITATOR_CONVERSATION_ID,
  }));

// ---------- Registry ----------

addTool("cogitator_list_providers", "Liste les providers pi (catalogue + statut auth + modèles).", {}, () => call("GET", "/api/providers"));

addTool("cogitator_list_skills", "Liste les skills disponibles (name, description, path).", {}, () => call("GET", "/api/skills"));

addTool("cogitator_import_skills", "Importe des skills : repo GitHub (ex: IgnitionAI/skills), dossier local, ou commande CLI (ex: 'npx aiblueprint-cli@latest skills update'). Les dossiers contenant un SKILL.md sont copiés vers ~/.agents/skills/.",
  {
    source: z.string().describe("URL GitHub (https://github.com/owner/repo) ou chemin absolu d'un dossier local"),
    overwrite: z.boolean().optional().describe("Écrase les skills existants du même nom (défaut: skip)"),
  },
  (a) => call("POST", "/api/skills/import", a));

addTool("cogitator_health", "État du serveur Cogitator (version, pi, sessions, base).", {}, () => call("GET", "/api/health"));

// ---------- Board kanban (gestion de projet du workspace) ----------

addTool("cogitator_board_list", "Liste les cartes du board kanban d'un workspace (statut, priorité, labels, assigné, relations).",
  { workspace_id: mcpPathIdSchema },
  (a) => call("GET", mcpWorkspacePath(a.workspace_id, "/board")));

addTool("cogitator_board_create_card", "Crée une carte sur le board : titre, description, statut, priorité, labels, assigné (agent id), conversations liées, relations blocks/blocked_by.",
  {
    workspace_id: mcpPathIdSchema,
    title: z.string(),
    description: z.string().optional(),
    status: z.enum(CARD_STATUSES).optional(),
    priority: z.enum(CARD_PRIORITIES).optional(),
    labels: z.array(z.string()).optional(),
    assignee_agent_id: mcpPathIdSchema.nullable().optional(),
    conversation_ids: z.array(mcpPathIdSchema).optional(),
  },
  (a) => call("POST", mcpWorkspacePath(a.workspace_id, "/board/cards"), a));

addTool("cogitator_board_update_card", "Met à jour une carte (mêmes champs que create ; écrase la config). Relations : blocks/blocked_by (ids de cartes).",
  {
    workspace_id: mcpPathIdSchema,
    card_id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(CARD_STATUSES).optional(),
    priority: z.enum(CARD_PRIORITIES).optional(),
    labels: z.array(z.string()).optional(),
    assignee_agent_id: mcpPathIdSchema.nullable().optional(),
    conversation_ids: z.array(mcpPathIdSchema).optional(),
    blocks: z.array(z.string()).optional(),
    blocked_by: z.array(z.string()).optional(),
  },
  (a) => {
    const { workspace_id, card_id, ...body } = a;
    return call("PUT", mcpWorkspacePath(workspace_id, `/board/cards/${encodeURIComponent(String(card_id))}`), body);
  });

addTool("cogitator_board_move", "Déplace une carte vers une colonne (statut).",
  {
    workspace_id: mcpPathIdSchema,
    card_id: z.string(),
    status: z.enum(CARD_STATUSES),
  },
  (a) => call("POST", mcpWorkspacePath(a.workspace_id, `/board/cards/${encodeURIComponent(String(a.card_id))}/move`), { status: a.status }));

addTool("cogitator_board_start_work", "Lance l'agent Cogitator assigné sur un ticket : spawn une conversation dans le workspace avec le contenu de la carte, lie la conversation (rollup activité) et passe la carte en in_progress. Nécessite un assignee_agent_id (extra Cogitator) sur la carte.",
  {
    workspace_id: mcpPathIdSchema,
    card_id: z.string(),
    extra: z.string().optional().describe("Précision complémentaire à ajouter au prompt"),
  },
  (a) => call("POST", mcpWorkspacePath(a.workspace_id, `/board/cards/${encodeURIComponent(String(a.card_id))}/start`), { extra: a.extra }));

addTool("cogitator_board_comment", "Ajoute un commentaire à une carte (append-only). Auteur par défaut : Majordome.",
  {
    workspace_id: mcpPathIdSchema,
    card_id: z.string(),
    text: z.string(),
    author: z.string().optional(),
  },
  (a) => call("POST", mcpWorkspacePath(a.workspace_id, `/board/cards/${encodeURIComponent(String(a.card_id))}/comments`), { text: a.text, author: a.author ?? "Majordome" }));

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[cogitator-mcp] connecté (stdio)");
}
