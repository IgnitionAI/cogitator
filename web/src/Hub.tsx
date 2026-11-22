import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "./api";
import { formatDate, localizeText, t } from "./i18n";
import { Icon } from "./icons";
import { ErrorText, useToast } from "./ui";
import { ChatView, NewConversationModal } from "./screens/Conversations";
import { AgentFace, AgentHead3D, useAgentGenome } from "./AgentFace";
import type { AgentPreset, Conversation, Workspace } from "./types";
import "./hub.css";

// Le logo 3D (three.js) reste hors du premier rendu : même découpage que la barre latérale.
const BrandLogo3D = lazy(() => import("./BrandLogo3D"));

/** Écran d'accueil : agents comme des contacts (B), leurs fils, le chat (A). */
export type HubTarget = { agentId?: string | null; conversationId?: string | null; nonce: number };
const FREE = "__free__";
function relativeTime(iso: string): string {
  const then = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return t("hub.now");
  if (minutes < 60) return t("hub.minutes", { count: minutes });
  if (minutes < 24 * 60) return formatDate(then, { hour: "2-digit", minute: "2-digit" });
  return formatDate(then, { day: "numeric", month: "short" });
}

export default function Hub(props: {
  target?: HubTarget | null;
  onNavigate: (screen: "agents" | "workspaces" | "terminal" | "cron" | "bots") => void;
}) {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [showFreeModal, setShowFreeModal] = useState(false);

  const refresh = useCallback(() => {
    Promise.all([api.agents(), api.conversations()])
      .then(([a, c]) => { setAgents(a.agents); setConversations(c.conversations.filter((x) => !x.group_id)); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    refresh();
    api.workspaces().then((r) => setWorkspaces(r.workspaces)).catch(() => undefined);
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Agent par défaut à l'ouverture.
  useEffect(() => {
    if (!ready || agentId) return;
    const home = agents.find((a) => a.is_default) ?? agents[0];
    setAgentId(home ? home.id : FREE);
  }, [ready, agents, agentId]);

  // Navigation demandée de l'extérieur (palette ⌘K, page projet).
  useEffect(() => {
    if (!props.target) return;
    if (props.target.conversationId) {
      const conv = conversations.find((c) => c.id === props.target!.conversationId);
      if (!conv && ready) refresh();
      setAgentId(conv ? conv.agent_id ?? FREE : props.target.agentId ?? agentId);
      setThreadId(props.target.conversationId);
    } else if (props.target.agentId) {
      setAgentId(props.target.agentId);
      setThreadId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.target?.nonce]);

  const byAgent = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of conversations) {
      const key = c.agent_id && agents.some((a) => a.id === c.agent_id) ? c.agent_id : FREE;
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return map;
  }, [conversations, agents]);

  const statusOf = (key: string): "working" | "ready" | "idle" => {
    const threads = byAgent.get(key) ?? [];
    if (threads.some((c) => c.streaming)) return "working";
    return threads.some((c) => c.status === "active") ? "ready" : "idle";
  };
  // Un fil en échec récent fait passer la tête de l'agent en rouge.
  const failingOf = (key: string) => (byAgent.get(key) ?? []).some((c) => !c.streaming && (c.status === "error" || c.status === "failed" || c.pending_configuration?.status === "failed"));

  const selectedAgent = agents.find((a) => a.id === agentId) ?? null;
  const threads = byAgent.get(agentId ?? FREE) ?? [];
  const thread = conversations.find((c) => c.id === threadId) ?? null;
  const agentName = selectedAgent?.name ?? t("hub.free");

  const pickAgent = (id: string) => {
    setAgentId(id);
    const first = (byAgent.get(id) ?? [])[0];
    setThreadId(first ? first.id : null);
  };

  const view = thread ? "chat" : "home";
  return <div className={`hub is-${view}${agentId ? " has-agent" : ""}`}>
    <aside className="hub-agents" aria-label={t("hub.agents")}>
      <div className="hub-col-head">
        <h1>{t("hub.agents")}</h1>
        <button type="button" className="hub-round" aria-label={t("hub.newAgent")} title={t("hub.newAgent")} onClick={() => props.onNavigate("agents")}><Icon name="plus" size={14} /></button>
      </div>
      <ErrorText error={error} />
      <div className="hub-agent-list">
        {agents.map((a) => {
          const status = statusOf(a.id);
          const count = byAgent.get(a.id)?.length ?? 0;
          return <button key={a.id} type="button" className={`hub-agent${agentId === a.id ? " is-active" : ""}`} aria-current={agentId === a.id ? "true" : undefined} onClick={() => pickAgent(a.id)}>
            <AgentFace agent={a} status={status} />
            <span className="hub-agent-text">
              <span className="hub-agent-line"><span className="hub-agent-name">{a.name}</span>{count ? <span className="hub-count">{count}</span> : null}</span>
              <span className="hub-agent-sub">{t(`hub.status.${status}`)} · {a.model}</span>
            </span>
          </button>;
        })}
        <button type="button" className={`hub-agent${agentId === FREE ? " is-active" : ""}`} onClick={() => pickAgent(FREE)}>
          <span className="hub-avatar is-free" aria-hidden="true">#</span>
          <span className="hub-agent-text">
            <span className="hub-agent-line"><span className="hub-agent-name">{t("hub.free")}</span>{byAgent.get(FREE)?.length ? <span className="hub-count">{byAgent.get(FREE)!.length}</span> : null}</span>
            <span className="hub-agent-sub">{t("hub.freeSub")}</span>
          </span>
        </button>
      </div>
      <button type="button" className="hub-link" onClick={() => props.onNavigate("bots")}><Icon name="users" size={14} /> {t("hub.groups")}</button>
    </aside>

    <section className="hub-threads" aria-label={t("hub.threadsOf", { name: agentName })}>
      <div className="hub-col-head">
        {selectedAgent ? <AgentFace agent={selectedAgent} size={32} /> : <span className="hub-avatar is-free" style={{ width: 32, height: 32 }} aria-hidden="true">#</span>}
        <div className="hub-thread-agent"><h2>{agentName}</h2><p className="mono">{selectedAgent ? `${selectedAgent.provider} · ${selectedAgent.model}` : t("hub.freeSub")}</p></div>
      </div>
      <button type="button" className={`hub-new${view === "home" ? " is-active" : ""}`} onClick={() => agentId === FREE ? setShowFreeModal(true) : setThreadId(null)}>
        <Icon name="plus" size={14} /> {t("hub.newThread", { name: agentName })}
      </button>
      <p className="hub-label">{t("hub.threads")}</p>
      <div className="hub-thread-list">
        {threads.length === 0 && ready ? <p className="hub-empty">{t("hub.noThreads")}</p> : null}
        {threads.map((c) => <button key={c.id} type="button" className={`hub-thread${threadId === c.id ? " is-active" : ""}`} aria-current={threadId === c.id ? "true" : undefined} onClick={() => setThreadId(c.id)}>
          <span className="hub-thread-line"><span className="hub-thread-title">{c.title || t("chat.untitled")}</span><span className="hub-thread-time">{c.streaming ? t("hub.status.working") : relativeTime(c.updated_at)}</span></span>
          <span className="hub-thread-sub"><span className={`hub-dot${c.streaming ? " is-working" : ""}`} aria-hidden="true" />{c.workspace_dir ? c.workspace_dir.split("/").pop() : t("hub.noProject")}</span>
        </button>)}
      </div>
    </section>

    <div className="hub-main">
      {thread ? (
        <ChatView
          key={thread.id}
          conversation={thread}
          onClose={() => { setThreadId(null); refresh(); }}
          onDeleted={() => { setThreadId(null); refresh(); }}
        />
      ) : (
        <HubHome
          agent={selectedAgent}
          working={selectedAgent ? statusOf(selectedAgent.id) === "working" : false}
          failing={selectedAgent ? failingOf(selectedAgent.id) : false}
          free={agentId === FREE}
          workspaces={workspaces}
          onNavigate={props.onNavigate}
          onFree={() => setShowFreeModal(true)}
          onCreated={(conv) => { setConversations((list) => [conv, ...list]); setThreadId(conv.id); refresh(); }}
          onError={(m) => toast(localizeText(m), true)}
        />
      )}
    </div>
    {showFreeModal ? <NewConversationModal onClose={() => setShowFreeModal(false)} onCreated={(id) => { setShowFreeModal(false); setAgentId(FREE); setThreadId(id); refresh(); }} /> : null}
  </div>;
}

function HubHome(props: {
  agent: AgentPreset | null;
  working: boolean;
  failing: boolean;
  free: boolean;
  workspaces: Workspace[];
  onNavigate: (screen: "agents" | "workspaces" | "terminal" | "cron") => void;
  onFree: () => void;
  onCreated: (conversation: Conversation) => void;
  onError: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [workspaceId, setWorkspaceId] = useState(props.agent?.default_workspace_id ?? "");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const genome = useAgentGenome(props.agent);
  useEffect(() => { setWorkspaceId(props.agent?.default_workspace_id ?? ""); area.current?.focus(); }, [props.agent?.id]);

  const start = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    if (props.free || !props.agent) { props.onFree(); return; }
    setBusy(true);
    try {
      const created = await api.createConversation({ agent_id: props.agent.id, prompt: text, workspace_id: workspaceId || undefined });
      setPrompt("");
      props.onCreated(created.conversation);
    } catch (e) { props.onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className="hub-home">
    <div className="hub-home-inner">
      <div className="hub-hero">
        {genome ? <div className="hub-logo is-agent" aria-hidden="true">
          <Suspense fallback={<img src="/icon.png" alt="" width={96} height={96} />}><AgentHead3D genome={genome} working={props.working} error={props.failing} size={150} /></Suspense>
        </div> : <div className="hub-logo" aria-hidden="true">
          <Suspense fallback={<img src="/icon.png" alt="" width={96} height={96} />}><BrandLogo3D size={96} /></Suspense>
        </div>}
        <h2>{t("hub.ask")}</h2>
        <p>{props.agent ? t("hub.askWith", { name: props.agent.name }) : t("hub.askFree")}</p>
      </div>
      <form className="hub-composer" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <label htmlFor="hub-prompt" className="sr-only">{t("hub.promptLabel")}</label>
        <textarea id="hub-prompt" ref={area} rows={3} value={prompt} placeholder={t("hub.placeholder")} onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void start(); } }} />
        <div className="hub-composer-row">
          {props.agent ? <span className="hub-pill"><AgentFace agent={props.agent} size={20} />{props.agent.name}</span> : null}
          {!props.free ? <select className="hub-pill-select" aria-label={t("hub.project")} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">{t("hub.noProject")}</option>
            {props.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select> : null}
          <span className="hub-spacer" />
          <button type="submit" className="hub-send" aria-label={t("chat.send")} disabled={busy || !prompt.trim()}><Icon name="send" size={17} /></button>
        </div>
      </form>
      <div className="hub-chips">
        <button type="button" onClick={() => props.onNavigate("agents")}>{t("hub.chipAgent")}</button>
        <button type="button" onClick={() => props.onNavigate("workspaces")}>{t("hub.chipProject")}</button>
        <button type="button" onClick={() => props.onNavigate("terminal")}>{t("hub.chipTerminal")}</button>
        <button type="button" onClick={() => props.onNavigate("cron")}>{t("hub.chipCron")}</button>
      </div>
    </div>
  </div>;
}
