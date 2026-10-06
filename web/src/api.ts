import type {
  AgentPreset, Conversation, CronRun, CronTask, FeedEvent, FileChange, FileEvent, Health, ImageContentInput, ProviderView, SkillRef, Workspace,
} from "./types";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  health: () => req<Health>("GET", "/api/health"),

  providers: () => req<{ providers: ProviderView[] }>("GET", "/api/providers"),
  createProvider: (b: unknown) => req<{ ok: true }>("POST", "/api/providers", b),
  updateProvider: (id: string, b: unknown) => req<{ ok: true }>("PUT", `/api/providers/${id}`, b),
  deleteProvider: (id: string) => req<{ ok: true }>("DELETE", `/api/providers/${id}`),

  skills: () => req<{ skills: SkillRef[] }>("GET", "/api/skills"),
  importSkills: (source: string, overwrite?: boolean) =>
    req<{ imported: string[]; skipped: string[]; dest: string }>("POST", "/api/skills/import", { source, overwrite }),

  agents: () => req<{ agents: Omit<AgentPreset, "system_prompt" | "subagents">[] }>("GET", "/api/agents"),
  agent: (id: string) => req<{ agent: AgentPreset }>("GET", `/api/agents/${id}`),
  createAgent: (b: unknown) => req<{ agent: AgentPreset }>("POST", "/api/agents", b),
  updateAgent: (id: string, b: unknown) => req<{ agent: AgentPreset }>("PUT", `/api/agents/${id}`, b),
  deleteAgent: (id: string) => req<{ ok: true }>("DELETE", `/api/agents/${id}`),
  validateAgent: (id: string) => req<{ errors: string[]; warnings: string[] }>("POST", `/api/agents/${id}/validate`),
  setDefaultAgent: (id: string) => req<{ ok: true }>("POST", `/api/agents/${id}/default`),

  workspaces: () => req<{ workspaces: Workspace[] }>("GET", "/api/workspaces"),
  createWorkspace: (b: unknown) => req<{ workspace: Workspace }>("POST", "/api/workspaces", b),
  updateWorkspace: (id: string, b: unknown) => req<{ workspace: Workspace }>("PUT", `/api/workspaces/${id}`, b),
  deleteWorkspace: (id: string) => req<{ ok: true }>("DELETE", `/api/workspaces/${id}`),
  browse: (path?: string) =>
    req<{ path: string; parent: string | null; entries: Array<{ name: string; path: string; type: "dir" | "file" }> }>(
      "GET", `/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  workspaceActivity: (id: string) =>
    req<{ files: FileChange[]; totals: { additions: number; deletions: number }; conversations: number }>(
      "GET", `/api/workspaces/${id}/activity`,
    ),


  conversations: (workspaceId?: string) =>
    req<{ conversations: Conversation[] }>("GET", `/api/conversations${workspaceId ? `?workspace_id=${workspaceId}` : ""}`),
  conversation: (id: string) => req<{ conversation: Conversation; live: boolean }>("GET", `/api/conversations/${id}`),
  createConversation: (b: unknown) => req<{ conversation: Conversation }>("POST", "/api/conversations", b),
  deleteConversation: (id: string) => req<{ ok: true }>("DELETE", `/api/conversations/${id}`),
  sendMessage: (id: string, text: string, images?: ImageContentInput[]) =>
    req<{ ok: true }>("POST", `/api/conversations/${id}/messages`, { text, images }),
  stopConversation: (id: string) => req<{ ok: true }>("POST", `/api/conversations/${id}/stop`),
  switchModel: (id: string, provider: string, modelId: string) =>
    req<{ ok: true }>("POST", `/api/conversations/${id}/model`, { provider, id: modelId }),
  history: (id: string) =>
    req<{ messages: Array<{ role: string; text: string }>; entries: import("./types").HistoryEntry[] }>(
      "GET", `/api/conversations/${id}/history`,
    ),
  conversationFiles: (id: string) => req<{ files: FileChange[] }>("GET", `/api/conversations/${id}/files`),
  fileDetail: (id: string, path: string) =>
    req<{ path: string; operations: FileEvent[] }>("GET", `/api/conversations/${id}/file?path=${encodeURIComponent(path)}`),
  workspaceFeed: (id: string) =>
    req<{ events: FeedEvent[]; conversations: number }>("GET", `/api/workspaces/${id}/feed`),
  workspaceTree: (id: string) =>
    req<{ root: string; tree: import("./FileViews").TreeNode[] }>("GET", `/api/workspaces/${id}/tree`),
  workspaceFile: (id: string, path: string) =>
    req<{ file: { path: string; name: string; size: number; content: string; truncated: boolean } }>(
      "GET", `/api/workspaces/${id}/file?path=${encodeURIComponent(path)}`,
    ),

  schedules: () => req<{ schedules: CronTask[] }>("GET", "/api/schedules"),
  createSchedule: (b: unknown) => req<{ schedule: CronTask }>("POST", "/api/schedules", b),
  updateSchedule: (id: string, b: unknown) => req<{ schedule: CronTask }>("PUT", `/api/schedules/${id}`, b),
  deleteSchedule: (id: string) => req<{ ok: true }>("DELETE", `/api/schedules/${id}`),
  fireSchedule: (id: string) => req<{ ok: true }>("POST", `/api/schedules/${id}/run`),
  runs: (id: string) => req<{ runs: CronRun[] }>("GET", `/api/schedules/${id}/runs`),
};

/** SSE avec reconnexion native (le navigateur réessaie seul) ; onOpen à chaque (re)connexion
 *  pour réconcilier l'historique et combler les événements manqués pendant une coupure. */
export function openEvents(
  url: string,
  onEvent: (e: never) => void,
  opts?: { onOpen?: () => void; onClose?: () => void },
): () => void {
  const source = new EventSource(url);
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as never);
    } catch {
      /* événement non-JSON : ignoré */
    }
  };
  source.onopen = () => opts?.onOpen?.();
  // NE PAS fermer sur error : le navigateur rétablit la connexion tout seul
  source.onerror = () => undefined;
  return () => {
    source.onerror = null;
    source.close();
    opts?.onClose?.();
  };
}
