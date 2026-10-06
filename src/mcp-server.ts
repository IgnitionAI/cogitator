#!/usr/bin/env node
/**
 * Serveur MCP Cogitator (stdio) — expose l'API Cogitator en outils pour les agents pi.
 * Transporte toutes les requêtes vers le serveur HTTP local (COGITATOR_URL).
 *
 * C'est le mécanisme du "Majordome" : un agent pi qui manipule Cogitator
 * (agents, crons, workspaces, conversations) via des outils MCP natifs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.COGITATOR_URL ?? "http://127.0.0.1:5320";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data as T;
}

const server = new McpServer({
  name: "cogitator",
  version: "0.1.0",
});

function addTool(
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  fn: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const result = await fn(args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erreur: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });
}

// ---------- Agents ----------

addTool("cogitator_list_agents", "Liste les presets d'agents Cogitator (sans prompts).", {}, () => call("GET", "/api/agents"));

addTool("cogitator_get_agent", "Détail complet d'un agent (prompt, skills, MCP, subagents).",
  { id: z.string() },
  (a) => call("GET", `/api/agents/${a.id}`));

addTool("cogitator_create_agent", "Crée un agent (preset) : provider+modèle+thinking+skills+MCP+prompt+subagents. Génère les définitions herdr au save.",
  {
    name: z.string().describe("Nom d'affichage"),
    provider: z.string().describe("ex: openai, deepseek, kimi-coding"),
    model: z.string().describe("id du modèle dans le provider"),
    description: z.string().optional(),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    system_prompt: z.string().optional().describe("Prompt de scope de l'agent"),
    skills: z.array(z.string()).optional().describe("Chemins absolus de skills"),
    tools: z.array(z.string()).optional().describe("Allowlist d'outils (absent = tous)"),
  },
  (a) => call("POST", "/api/agents", a));

addTool("cogitator_update_agent", "Modifie un agent existant (mêmes champs que create, écrase la config).",
  {
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    model: z.string(),
    description: z.string().optional(),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable().optional(),
    system_prompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
    tools: z.array(z.string()).nullable().optional(),
  },
  (a) => {
    const { id, ...body } = a;
    return call("PUT", `/api/agents/${id}`, body);
  });

addTool("cogitator_delete_agent", "Supprime un agent et ses définitions herdr noo-*.",
  { id: z.string() },
  (a) => call("DELETE", `/api/agents/${a.id}`));

addTool("cogitator_validate_agent", "Valide un agent (provider/modèle du catalogue, skills, MCP, auth).",
  { id: z.string() },
  (a) => call("POST", `/api/agents/${a.id}/validate`));

addTool("cogitator_set_default_agent", "Définit l'agent par défaut global (utilisé quand une conversation ne précise rien).",
  { id: z.string() },
  (a) => call("POST", `/api/agents/${a.id}/default`));

// ---------- Schedules (cron) ----------

addTool("cogitator_list_schedules", "Liste les tâches cron (avec prochain run calculé).", {}, () => call("GET", "/api/schedules"));

addTool("cogitator_create_schedule", "Crée une tâche cron : un prompt tiré contre un agent à heure fixe.",
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

addTool("cogitator_update_schedule", "Modifie une tâche cron (champs partiels, enabled inclus).",
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
    return call("PUT", `/api/schedules/${id}`, body);
  });

addTool("cogitator_delete_schedule", "Supprime une tâche cron et l'historique de ses runs.",
  { id: z.string() },
  (a) => call("DELETE", `/api/schedules/${a.id}`));

addTool("cogitator_fire_schedule", "Déclenche immédiatement une tâche cron.",
  { id: z.string() },
  (a) => call("POST", `/api/schedules/${a.id}/run`));

addTool("cogitator_list_runs", "Historique des runs d'une tâche cron (status, session, erreur).",
  { id: z.string() },
  (a) => call("GET", `/api/schedules/${a.id}/runs`));

// ---------- Workspaces ----------

addTool("cogitator_list_workspaces", "Liste les workspaces (dossiers + nb de conversations).", {}, () => call("GET", "/api/workspaces"));

addTool("cogitator_create_workspace", "Enregistre un dossier comme workspace.",
  { dir: z.string().describe("Chemin absolu du dossier (doit exister)"), name: z.string().optional() },
  (a) => call("POST", "/api/workspaces", a));

addTool("cogitator_delete_workspace", "Supprime un workspace (les conversations deviennent libres).",
  { id: z.string() },
  (a) => call("DELETE", `/api/workspaces/${a.id}`));

// ---------- Conversations ----------

addTool("cogitator_list_conversations", "Liste les conversations (toutes, ou filtrées par workspace).",
  { workspace_id: z.string().optional() },
  (a) => call("GET", `/api/conversations${a.workspace_id ? `?workspace_id=${a.workspace_id}` : ""}`));

addTool("cogitator_create_conversation", "Crée une conversation avec un agent (ou provider libre) et un prompt initial optionnel.",
  {
    agent_id: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    workspace_id: z.string().optional(),
    prompt: z.string().optional(),
  },
  (a) => call("POST", "/api/conversations", a));

// ---------- Registry ----------

addTool("cogitator_list_providers", "Liste les providers pi (catalogue + statut auth + modèles).", {}, () => call("GET", "/api/providers"));

addTool("cogitator_list_skills", "Liste les skills disponibles (name, description, path).", {}, () => call("GET", "/api/skills"));

addTool("cogitator_import_skills", "Importe des skills depuis un repo GitHub (ex: IgnitionAI/skills) ou un dossier local vers ~/.agents/skills/. Les dossiers contenant un SKILL.md sont copiés.",
  {
    source: z.string().describe("URL GitHub (https://github.com/owner/repo) ou chemin absolu d'un dossier local"),
    overwrite: z.boolean().optional().describe("Écrase les skills existants du même nom (défaut: skip)"),
  },
  (a) => call("POST", "/api/skills/import", a));

addTool("cogitator_health", "État du serveur Cogitator (version, pi, sessions, base).", {}, () => call("GET", "/api/health"));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[cogitator-mcp] connecté à ${BASE}`);
