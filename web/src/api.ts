import type {
  AgentPreset, BoardCard, Conversation, CronRun, CronTask, FeedEvent, FileChange, FileEvent, Health, ImageContentInput, ProviderView, SkillRef, Workspace, AgentWrite, CardWrite, ConversationWrite, ProviderWrite, ScheduleWrite, SseEvent, WorkspaceWrite } from "./types";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const failure = data as { error?: unknown; issues?: unknown };
    const message = typeof failure.error === "string" ? failure.error : `HTTP ${res.status}`;
    const issues = Array.isArray(failure.issues) ? failure.issues.filter((issue): issue is string => typeof issue === "string") : [];
    throw new Error([message, ...issues].join("\n"));
  }
  return data as T;
}

export const api = {
  health: () => req<Health>("GET", "/api/health"),
  mcp: () => req<{ mcpServers: Record<string, unknown> }>("GET", "/api/mcp"),
  saveMcp: (config: unknown) => req<{ ok: true }>("PUT", "/api/mcp", config),

  providers: () => req<{ providers: ProviderView[] }>("GET", "/api/providers"),
  createProvider: (b: ProviderWrite) => req<{ ok: true }>("POST", "/api/providers", b),
  updateProvider: (id: string, b: ProviderWrite) => req<{ ok: true }>("PUT", `/api/providers/${id}`, b),
  deleteProvider: (id: string) => req<{ ok: true }>("DELETE", `/api/providers/${id}`),

  skills: () => req<{ skills: SkillRef[] }>("GET", "/api/skills"),
  importSkills: (source: string, overwrite?: boolean) =>
    req<{ imported: string[]; skipped: string[]; dest: string }>("POST", "/api/skills/import", { source, overwrite }),

  agents: () => req<{ agents: AgentPreset[] }>("GET", "/api/agents"),
  agent: (id: string) => req<{ agent: AgentPreset }>("GET", `/api/agents/${id}`),
  createAgent: (b: AgentWrite) => req<{ agent: AgentPreset }>("POST", "/api/agents", b),
  updateAgent: (id: string, b: AgentWrite) => req<{ agent: AgentPreset }>("PUT", `/api/agents/${id}`, b),
  deleteAgent: (id: string) => req<{ ok: true }>("DELETE", `/api/agents/${id}`),
  validateAgent: (id: string) => req<{ errors: string[]; warnings: string[] }>("POST", `/api/agents/${id}/validate`),
  setDefaultAgent: (id: string) => req<{ ok: true }>("POST", `/api/agents/${id}/default`),

  workspaces: () => req<{ workspaces: Workspace[] }>("GET", "/api/workspaces"),
  createWorkspace: (b: WorkspaceWrite) => req<{ workspace: Workspace }>("POST", "/api/workspaces", b),
  updateWorkspace: (id: string, b: WorkspaceWrite) => req<{ workspace: Workspace }>("PUT", `/api/workspaces/${id}`, b),
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
  conversation: (id: string) => req<{ conversation: Conversation; live: boolean; streaming: boolean }>("GET", `/api/conversations/${id}`),
  createConversation: (b: ConversationWrite) => req<{ conversation: Conversation }>("POST", "/api/conversations", b),
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
  board: (id: string) => req<{ cards: BoardCard[] }>("GET", `/api/workspaces/${id}/board`),
  boardCreateCard: (id: string, b: CardWrite) => req<{ card: BoardCard }>("POST", `/api/workspaces/${id}/board/cards`, b),
  boardUpdateCard: (id: string, cardId: string, b: CardWrite) => req<{ card: BoardCard }>("PUT", `/api/workspaces/${id}/board/cards/${cardId}`, b),
  boardMove: (id: string, cardId: string, status: string) => req<{ card: BoardCard }>("POST", `/api/workspaces/${id}/board/cards/${cardId}/move`, { status }),
  boardComment: (id: string, cardId: string, b: { text: string; author?: string }) => req<{ card: BoardCard }>("POST", `/api/workspaces/${id}/board/cards/${cardId}/comments`, b),
  boardDeleteCard: (id: string, cardId: string) => req<{ ok: true }>("DELETE", `/api/workspaces/${id}/board/cards/${cardId}`),
  boardStartWork: (id: string, cardId: string) =>
    req<{ conversation: Conversation; card: BoardCard }>("POST", `/api/workspaces/${id}/board/cards/${cardId}/start`),
  boardCardActivity: (id: string, cardId: string) =>
    req<{ totals: { additions: number; deletions: number; files: number }; perConversation: Array<{ conversationId: string; additions: number; deletions: number }> }>(
      "GET", `/api/workspaces/${id}/board/cards/${cardId}/activity`,
    ),
  workspaceFile: (id: string, path: string) =>
    req<{ file: { path: string; name: string; size: number; content: string; truncated: boolean } }>(
      "GET", `/api/workspaces/${id}/file?path=${encodeURIComponent(path)}`,
    ),

  schedules: () => req<{ schedules: CronTask[] }>("GET", "/api/schedules"),
  createSchedule: (b: ScheduleWrite) => req<{ schedule: CronTask }>("POST", "/api/schedules", b),
  updateSchedule: (id: string, b: ScheduleWrite) => req<{ schedule: CronTask }>("PUT", `/api/schedules/${id}`, b),
  deleteSchedule: (id: string) => req<{ ok: true }>("DELETE", `/api/schedules/${id}`),
  fireSchedule: (id: string) => req<{ ok: true }>("POST", `/api/schedules/${id}/run`),
  runs: (id: string) => req<{ runs: CronRun[] }>("GET", `/api/schedules/${id}/runs`),
};

/** SSE avec reconnexion native (le navigateur réessaie seul) ; onOpen à chaque (re)connexion
 *  pour réconcilier l'historique et combler les événements manqués pendant une coupure. */
export type EventConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export function openEvents(
  url: string,
  onEvent: (event: SseEvent) => void,
  opts?: { onOpen?: () => void; onClose?: () => void; onStateChange?: (state: EventConnectionState) => void },
): () => void {
  const source = new EventSource(url);
  opts?.onStateChange?.("connecting");
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as SseEvent);
    } catch {
      /* événement non-JSON : ignoré */
    }
  };
  source.onopen = () => {
    opts?.onStateChange?.("connected");
    opts?.onOpen?.();
  };
  // NE PAS fermer sur error : le navigateur rétablit la connexion tout seul
  source.onerror = () => opts?.onStateChange?.(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
  return () => {
    source.onmessage = null;
    source.onopen = null;
    source.onerror = null;
    source.close();
    opts?.onStateChange?.("closed");
    opts?.onClose?.();
  };
}
