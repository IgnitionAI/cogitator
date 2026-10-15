// Types miroirs du contrat API — cf. docs/architecture/api-contract.md

/** Niveaux de raisonnement acceptés par pi (miroir de src/schemas.ts). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ProviderView {
  id: string;
  source: "builtin" | "custom";
  models: Array<{ id: string; name?: string; reasoning?: boolean }>;
  auth: { configured: boolean; type: string | null; ready: boolean | null };
}

export interface SkillRef {
  name: string;
  description: string;
  path: string;
  descriptionTooLong?: boolean;
}

export interface McpServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface SubagentInput {
  id?: string;
  name: string;
  description?: string;
  provider: string;
  model: string;
  thinking?: string | null;
  system_prompt?: string;
  skills?: string[];
  mcp_servers?: McpServerEntry[];
}

export interface AgentPreset {
  id: string;
  slug: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  thinking: string | null;
  system_prompt: string;
  skills: string[];
  tools_allowlist: string[] | null;
  mcp_servers: McpServerEntry[];
  created_at: string;
  updated_at: string;
  is_default?: number;
  default_workspace_id?: string | null;
  subagents: Array<SubagentInput & { id: string }>;
}

export interface Workspace {
  id: string;
  dir: string;
  name: string;
  default_agent_id: string | null;
  conversation_count?: number;
}

export interface Conversation {
  id: string;
  workspace_id: string | null;
  agent_id: string | null;
  provider: string;
  model: string;
  thinking: string | null;
  session_file: string | null;
  title: string;
  status: string;
  updated_at: string;
  group_id?: string | null;
  workspace_dir?: string | null;
}

export interface GroupMember {
  agent_id: string;
  name: string;
  slug: string;
  provider: string;
  model: string;
  conversation_id: string;
  is_host: number;
}

/** Agrégat groupe (ADR-011) — le fil visible est le groupe, pas les conversations membres. */
export interface Group {
  id: string;
  name: string;
  host_agent_id: string;
  default_workspace_id: string | null;
  created_at: string;
  updated_at: string;
  members: GroupMember[];
}

/** Ligne du bus du fil de groupe (ADR-011) — rejeu persistant ; le streaming passe par le SSE. */
export interface GroupMessage {
  id: string;
  group_id: string;
  conversation_id: string | null;
  agent_id: string | null;
  role: "user" | "assistant" | "tool";
  text: string;
  /** JSON { result } pour role='tool' ; null sinon */
  detail: string | null;
  is_error: number;
  created_at: string;
}

export interface CronTask {
  id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  agent_id: string | null;
  workspace_id: string;
  output_policy: string;
  busy_policy: string;
  catchup: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
  next_run_at: string | null;
}

export interface CronRun {
  id: string;
  task_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  session_file: string | null;
  error: string | null;
}

export interface Health {
  ok: boolean;
  version: string;
  pi_version: string | null;
  sessions_active: number;
  mcp_adapter_detected: boolean;
  db: { path: string; version: number };
}

export interface ImageContentInput {
  type: "image";
  data: string; // base64 sans préfixe data:
  mimeType: string;
}

export interface BoardComment {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface BoardCard {
  id: string;
  number: number;
  url: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  labels: string[];
  assignee_agent_id: string | null;
  conversation_ids: string[];
  blocks: string[];
  blocked_by: string[];
  comments: BoardComment[];
  created_at: string;
  updated_at: string;
}

export interface FileChange {
  path: string;
  kind: "edit" | "write";
  edits: number;
  additions: number;
  deletions: number;
  lastAt: string;
  lastConversationId?: string;
}

export interface FileEvent {
  path: string;
  kind: "edit" | "write";
  at: string;
  additions: number;
  deletions: number;
  hunks: Array<{ old: string; new: string }>;
}

export interface FeedEvent extends FileEvent {
  conversationId: string;
  conversationTitle: string;
}

export interface HistoryEntryTool {
  type: "tool";
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
}
export type HistoryEntry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | HistoryEntryTool;

// Événements SSE pi (sous-ensemble rendu par l'UI)
// ---------- Missions durables : approbations, budget, admission (#16) ----------

/** Action sensible créée côté serveur, immuable dans ses champs de scope. */
export interface PendingActionView {
  id: string;
  operation: string;
  target: string;
  artifactDigest: string;
  argumentDigest: string;
  consequence: string;
  expiresAt: number;
  allowedUses: number;
  createdAt: number;
  decision: "pending" | "approved" | "denied";
  decidedAt: number;
  denialReason?: string;
}

export interface ApprovalGrantView {
  id: string;
  operation: string;
  target: string;
  artifactDigest: string;
  argumentDigest: string;
  expiresAt: number;
  remainingUses: number;
  revoked: boolean;
  decidedAt: number;
  valid: boolean;
}

export interface EffectReceiptView {
  intentKey: string;
  operation: string;
  target: string;
  status: "intent_committed" | "observed" | "unknown";
  observed?: { at: number; outcome: string; reference?: string };
  unknownReason?: string;
  updatedAt: number;
}

export interface MissionBudgetView {
  policy: { missionCalls?: number; missionTokens?: number; dailyCalls?: number; dailyTokens?: number };
  missionUsed: { calls: number; tokens: number };
  dailyUsed: { calls: number; tokens: number };
  binding?: { kind: string; limit: number; used: number; nextAction: string };
}

export interface MissionStatusView {
  state: "idle" | "running" | "queued" | "waiting_approval" | "budget_paused" | "needs_attention";
  reason?: string;
  queueLength: number;
  budget: MissionBudgetView;
  workspaceDir: string;
  workspaceClaimed: boolean;
  workspaceClaimedBy?: string;
}

export interface SseEvent {
  type: string;
  sessionFile?: string;
  /** notifications cron globales (cron_run_started / cron_run_finished) */
  name?: string;
  status?: string;
  error?: string;
  taskId?: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: Array<{ type: string; text?: string }> };
  partialResult?: { content?: Array<{ type: string; text?: string }> };
  isError?: boolean;
  /** État de mission durable (queued / budget_paused / waiting_approval / …). */
  mission?: MissionStatusView;
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    toolName?: string;
    id?: string;
    toolCall?: { id: string; name: string; arguments: unknown };
  };
}

// ---------- Corps d'écriture (ce que l'UI envoie au serveur) ----------

export interface ProviderWrite {
  id?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: Array<{ id: string }>;
}

export interface AgentWrite {
  name: string;
  description?: string;
  provider: string;
  model: string;
  thinking?: string | null;
  system_prompt?: string;
  skills?: string[];
  tools_allowlist?: string[] | null;
  mcp_servers?: McpServerEntry[];
  subagents?: SubagentInput[];
  default_workspace_id?: string | null;
}

export interface WorkspaceWrite {
  dir?: string;
  name?: string;
  default_agent_id?: string | null;
}

export interface ConversationWrite {
  workspace_id?: string;
  agent_id?: string;
  provider?: string;
  model?: string;
  thinking?: string | null;
  system_prompt?: string;
  skills?: string[];
  tools?: string[];
  mcp_servers?: McpServerEntry[];
  prompt?: string;
}

export interface GroupWrite {
  name: string;
  member_agent_ids: string[];
  host_agent_id?: string;
  default_workspace_id?: string | null;
}

export interface CardWrite {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee_agent_id?: string | null;
  conversation_ids?: string[];
  blocks?: string[];
  blocked_by?: string[];
}

export interface ScheduleWrite {
  name?: string;
  cron_expr?: string;
  prompt?: string;
  agent_id?: string;
  workspace_id?: string;
  output_policy?: string;
  busy_policy?: string;
  catchup?: boolean;
  enabled?: boolean;
}
