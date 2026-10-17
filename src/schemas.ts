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

export const providerLoginSchema = z.object({
  type: z.enum(["api_key", "oauth"]),
});

export const providerLoginReplySchema = z.object({
  value: z.string().min(1),
});

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
  default_workspace_id: z.string().nullable().optional(),
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

// ---------- Groupes (ADR-011) ----------

export const groupCreateSchema = z.object({
  name: z.string().min(1, "name requis").max(80),
  member_agent_ids: z.array(z.string().min(1)).min(2, "2 bots minimum").max(6, "6 bots maximum"),
  host_agent_id: z.string().optional(),
  default_workspace_id: z.string().nullable().optional(),
});
export type GroupCreate = z.infer<typeof groupCreateSchema>;

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
  /** Runtime figé à la création (Plan 0002 §6) ; durable = harnais Durable du contrôleur. */
  runtime: z.enum(["classic", "durable"]).optional(),
});
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;

export const imageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string().max(15_000_000, "image > ~10 Mo (base64)"),
  mimeType: z.string().regex(/^image\//, "mimeType image/* requis"),
});
export type ImageContentInput = z.infer<typeof imageContentSchema>;

export const REQUEST_ID_MAX = 128;
export const requestIdSchema = z
  .string()
  .min(1)
  .max(REQUEST_ID_MAX, `requestId > ${REQUEST_ID_MAX} caractères`)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "requestId : lettres, chiffres, . _ - ; commence par une lettre ou un chiffre");

export const messageSchema = z.object({
  text: z.string().optional(),
  images: z.array(imageContentSchema).max(8, "8 images max par message").optional(),
  /** Mode durable (obligatoire là-bas) : identité stable et bornée de soumission. */
  requestId: requestIdSchema.optional(),
}).refine((b) => (b.text?.trim() ?? "") !== "" || (b.images?.length ?? 0) > 0, {
  message: "text ou images requis",
});
export type MessageInput = z.infer<typeof messageSchema>;

export const modelSwitchSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  thinking: thinkingSchema.optional(),
  scope: z.string().optional(),
});
export type ModelSwitch = z.infer<typeof modelSwitchSchema>;

// ---------- Approbations et budget des missions durables (#16) ----------

/**
 * Décision owner sur une action en attente créée côté SERVEUR : le client ne
 * choisit jamais l'action à approuver, seulement la décision ( approve/deny ).
 */
export const approvalDecisionSchema = z.object({
  pendingActionId: z.string().uuid("pendingActionId invalide"),
  decision: z.enum(["approved", "denied"]),
  denialReason: z.string().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

/**
 * Changement EXPLICITE de politique de budget par l'owner : c'est le seul
 * moyen de délier une limite de mission (aucun reset implicite, UA3).
 */
export const budgetUpdateSchema = z.object({
  missionCalls: z.number().int().min(0).max(1_000_000).optional(),
  missionTokens: z.number().int().min(0).max(10_000_000_000).optional(),
  dailyCalls: z.number().int().min(0).max(1_000_000).optional(),
  dailyTokens: z.number().int().min(0).max(10_000_000_000).optional(),
});
export type BudgetUpdateInput = z.infer<typeof budgetUpdateSchema>;

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

// ---------- Board (kanban workspace) ----------

export const CARD_STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export const CARD_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

export const boardCardSchema = z.object({
  title: z.string().min(1, "title requis").max(200),
  description: z.string().max(20_000).optional(),
  status: z.enum(CARD_STATUSES).optional(),
  priority: z.enum(CARD_PRIORITIES).optional(),
  labels: z.array(z.string().min(1).max(30)).max(8).optional(),
  assignee_agent_id: z.string().nullable().optional(),
  conversation_ids: z.array(z.string()).max(10).optional(),
  blocks: z.array(z.string()).max(20).optional(),
  blocked_by: z.array(z.string()).max(20).optional(),
  github_issue: z.number().int().nullable().optional(),
});
export type BoardCardInput = z.infer<typeof boardCardSchema>;

export const boardCommentSchema = z.object({
  text: z.string().min(1).max(5000),
  author: z.string().min(1).max(60).optional(), // défaut "user" ; le Majordome passe son nom
});
export type BoardCommentInput = z.infer<typeof boardCommentSchema>;

// ---------- Skills ----------

export const skillImportSchema = z.object({
  source: z.string().min(1, "source requise (URL GitHub ou chemin local)"),
  overwrite: z.boolean().optional(),
});
export type SkillImport = z.infer<typeof skillImportSchema>;
