// Types miroirs du contrat API — cf. docs/architecture/api-contract.md

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
  workspace_dir?: string | null;
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

// Événements SSE pi (sous-ensemble rendu par l'UI)
export interface SseEvent {
  type: string;
  sessionFile?: string;
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    toolName?: string;
  };
}
