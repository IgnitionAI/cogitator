import { z } from "zod";

/**
 * Schémas zod des entrées API — source unique de vérité (clean-code : dériver les
 * types des valeurs, valider à la frontière, jamais de `as` sur un body brut).
 */

export const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
export const MCP_NAME = /^[A-Za-z0-9_-]+$/;
export const SUBAGENT_NAME = /^[a-z][a-z0-9_-]*$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const thinkingSchema = z.enum(THINKING_LEVELS);

// ---------- MCP ----------

export const mcpServerEntrySchema = z.object({
  name: z.string().regex(MCP_NAME, "lettres, chiffres, _ et - uniquement"),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).refine((e) => e.command || e.url, { message: "command ou url requis" });
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

// ---------- Providers ----------

export const providerUpsertSchema = z.object({
  id: z.string().regex(PROVIDER_ID, "minuscules, chiffres et - ; commence par une lettre").optional(),
  baseUrl: z.string().url().or(z.string().startsWith("http")).optional(),
  api: z.string().optional(),
  apiKey: z.string().optional(),
  models: z.array(z.object({ id: z.string().min(1) })).optional(),
});
export type ProviderUpsert = z.infer<typeof providerUpsertSchema>;

// ---------- Agents ----------

export const subagentInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().regex(SUBAGENT_NAME, "minuscules, chiffres, - et _ ; commence par une lettre"),
  description: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  thinking: thinkingSchema.nullish(),
  system_prompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  mcp_servers: z.array(mcpServerEntrySchema).optional(),
});
export type SubagentInput = z.infer<typeof subagentInputSchema>;

export const agentInputSchema = z.object({
  name: z.string().min(1, "name requis"),
  description: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  thinking: thinkingSchema.nullish(),
  system_prompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  tools_allowlist: z.array(z.string()).nullable().optional(),
  mcp_servers: z.array(mcpServerEntrySchema).optional(),
  subagents: z.array(subagentInputSchema).optional(),
});
export type AgentInput = z.infer<typeof agentInputSchema>;

// ---------- Workspaces ----------

export const workspaceCreateSchema = z.object({
  dir: z.string().min(1, "dir requis"),
  name: z.string().optional(),
  default_agent_id: z.string().nullable().optional(),
});
export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

export const workspaceUpdateSchema = z.object({
  name: z.string().optional(),
  default_agent_id: z.string().nullable().optional(),
});
export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;

// ---------- Conversations ----------

export const conversationCreateSchema = z.object({
  workspace_id: z.string().optional(),
  prompt: z.string().optional(),
  agent_id: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thinking: thinkingSchema.nullish(),
  system_prompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(mcpServerEntrySchema).optional(),
});
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;

export const imageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string().max(15_000_000, "image > ~10 Mo (base64)"),
  mimeType: z.string().regex(/^image\//, "mimeType image/* requis"),
});
export type ImageContentInput = z.infer<typeof imageContentSchema>;

export const messageSchema = z.object({
  text: z.string().optional(),
  images: z.array(imageContentSchema).max(8, "8 images max par message").optional(),
}).refine((b) => (b.text?.trim() ?? "") !== "" || (b.images?.length ?? 0) > 0, {
  message: "text ou images requis",
});
export type MessageInput = z.infer<typeof messageSchema>;

export const modelSwitchSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export type ModelSwitch = z.infer<typeof modelSwitchSchema>;

// ---------- Schedules ----------

export const scheduleCreateSchema = z.object({
  name: z.string().min(1, "name requis"),
  cron_expr: z.string().min(1),
  prompt: z.string().min(1, "prompt requis"),
  agent_id: z.string().min(1),
  workspace_id: z.string().min(1),
  output_policy: z.enum(["append_session", "new_session"]).optional(),
  busy_policy: z.enum(["skip", "queue", "kill"]).optional(),
  catchup: z.boolean().optional(),
});
export type ScheduleCreate = z.infer<typeof scheduleCreateSchema>;

export const scheduleUpdateSchema = z.object({
  name: z.string().optional(),
  cron_expr: z.string().optional(),
  prompt: z.string().optional(),
  output_policy: z.enum(["append_session", "new_session"]).optional(),
  busy_policy: z.enum(["skip", "queue", "kill"]).optional(),
  catchup: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type ScheduleUpdate = z.infer<typeof scheduleUpdateSchema>;

// ---------- Skills ----------

export const skillImportSchema = z.object({
  source: z.string().min(1, "source requise (URL GitHub ou chemin local)"),
  overwrite: z.boolean().optional(),
});
export type SkillImport = z.infer<typeof skillImportSchema>;
