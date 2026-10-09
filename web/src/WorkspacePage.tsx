import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import { BoardPanel } from "./Board";
import { FileDiffModal, FileRow, TreePanel } from "./FileViews";
import { FeedList } from "./FeedList";
import type { AgentPreset, BoardCard, Conversation, FeedEvent, FileChange, Workspace } from "./types";
import { Badge, Empty, statusColor, useToast } from "./ui";
import { ChatView } from "./screens/Conversations";
import { Icon, type IconName } from "./icons";

const TABS: Array<{ id: string; label: string; icon: IconName }> = [
  { id: "board", label: "Tableau", icon: "board" },
  { id: "activity", label: "Activité", icon: "activity" },
  { id: "feed", label: "Journal", icon: "feed" },
  { id: "files", label: "Fichiers", icon: "tree" },
  { id: "conversations", label: "Conversations", icon: "chat" },
  { id: "team", label: "Équipe", icon: "users" },
  { id: "pm", label: "Chef de projet", icon: "bot" },
];

export default function WorkspacePage(props: {
  workspace: Workspace;
  agents: AgentPreset[];
  onBack: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const toast = useToast();
  const { workspace } = props;
  const [tab, setTab] = useState<string>("board");
  const [activity, setActivity] = useState<{ files: FileChange[]; totals: { additions: number; deletions: number } } | null>(null);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [diffFor, setDiffFor] = useState<{ convId: string; path: string } | null>(null);
  const [pmConv, setPmConv] = useState<Conversation | null>(null);
  const [cards, setCards] = useState<BoardCard[]>([]);

  const tabsId = useId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pmLoading, setPmLoading] = useState(false);
  const [pmError, setPmError] = useState<string | null>(null);
  const pmPending = useRef(false);
  const request = useRef(0);

  const [headActivity, setHeadActivity] = useState<typeof activity>(null);
  useEffect(() => {
    let active = true;
    setActivity(null);
    setHeadActivity(null);
    // Optional header stats must never block the selected tab.
    api.workspaceActivity(workspace.id)
      .then((result) => { if (active) setHeadActivity(result); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [workspace.id]);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    try {
      switch (tab) {
        case "activity": {
          const result = await api.workspaceActivity(workspace.id);
          if (current === request.current) setActivity(result);
          break;
        }
        case "feed": {
          const result = await api.workspaceFeed(workspace.id);
          if (current === request.current) setFeed(result.events);
          break;
        }
        case "conversations": {
          const result = await api.conversations(workspace.id);
          if (current === request.current) setConvs(result.conversations);
          break;
        }
        case "team": {
          const [boardResult, conversationResult] = await Promise.all([
            api.board(workspace.id), api.conversations(workspace.id),
          ]);
          if (current !== request.current) return;
          setCards(boardResult.cards);
          setConvs(conversationResult.conversations);
          break;
        }
      }
    } catch (e) {
      if (current === request.current) setError((e as Error).message);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [workspace.id, tab]);

  useEffect(() => {
    void refresh();
    return () => { request.current++; };
  }, [refresh]);

  const openPm = useCallback(async () => {
    if (pmConv || pmPending.current) return;
    const chef = props.agents.find((a) => a.slug === "chef-de-projet");
    if (!chef) {
      setPmError("Chef de Projet introuvable. Configure cet agent dans Équipe / Agents, puis réessaie.");
      return;
    }
    pmPending.current = true;
    setPmLoading(true);
    setPmError(null);
    try {
      const result = await api.conversations(workspace.id);
      const existing = result.conversations.find((c) => c.agent_id === chef.id);
      const conversation = existing ?? (await api.createConversation({ workspace_id: workspace.id, agent_id: chef.id })).conversation;
      setPmConv(conversation);
    } catch (e) {
      setPmError((e as Error).message);
    } finally {
      pmPending.current = false;
      setPmLoading(false);
    }
  }, [pmConv, props.agents, workspace.id]);

  useEffect(() => { if (tab === "pm") void openPm(); }, [tab, openPm]);

  const stats = activity ?? headActivity;
  const modified = new Set((stats?.files ?? []).map((f) => f.path));
  const LazyDiff = diffFor ? (
    <FileDiffModal conversationId={diffFor.convId} path={diffFor.path} onClose={() => setDiffFor(null)} />
  ) : null;

  return (
    <>
      <div className="ws-head">
        <button type="button" className="btn btn-sm" onClick={props.onBack}><Icon name="back" /> Workspaces</button>
        <h1>{workspace.name}</h1>
        <span className="muted mono" style={{ fontSize: 12 }}>{workspace.dir}</span>
        {stats && stats.files.length > 0 ? (
          <span className="file-stats" style={{ marginLeft: 12 }}>
            <span className="add">+{stats.totals.additions}</span>
            <span className="del">−{stats.totals.deletions}</span>
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-sm"
          title="Conversation de setup : le Majordome analyse le repo, propose conventions/règles/hooks/board, puis exécute"
          onClick={() => {
            const majordome = props.agents.find((a) => a.slug === "majordome");
            if (!majordome) {
              toast("Majordome introuvable", true);
              return;
            }
            api.createConversation({
              workspace_id: workspace.id,
              agent_id: majordome.id,
              prompt: "Initialise ce projet : analyse le repo et propose-moi le plan de setup (conventions, protections git, board initial, agents).",
            })
              .then((r) => props.onOpenConversation(r.conversation.id))
              .catch((e: Error) => toast(e.message, true));
          }}
        >
          <Icon name="spark" size={14} /> Initialiser le projet
        </button>
      </div>
      <div className="ws-tabs" role="tablist" aria-label="Workspace">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${tabsId}-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onKeyDown={(e) => {
              const index = TABS.findIndex((item) => item.id === t.id);
              const next = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1
                : e.key === "ArrowRight" ? (index + 1) % TABS.length
                : e.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : null;
              if (next === null) return;
              e.preventDefault();
              const id = TABS[next]!.id;
              setTab(id);
              document.getElementById(`${tabsId}-tab-${id}`)?.focus();
            }}
            className={`ws-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={14} /> {t.label}
            {t.id === "conversations" && convs.length > 0 ? ` (${convs.length})` : ""}
          </button>
        ))}
      </div>

      {TABS.map((t) => <div key={t.id} id={`${tabsId}-panel-${t.id}`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${t.id}`} hidden={tab !== t.id} tabIndex={0}>
      {tab === t.id ? <>
      {["activity", "feed", "team", "conversations"].includes(tab) ? <>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={refresh}>Actualiser</button>
        {loading ? <p role="status">Chargement…</p> : null}
        {error ? <div role="alert" className="error-text">{error} <button type="button" className="btn btn-sm" onClick={refresh}>Réessayer</button></div> : null}
      </> : null}
      {tab === "board" ? <BoardPanel workspaceId={workspace.id} agents={props.agents} onOpenConversation={props.onOpenConversation} /> : null}

      {tab === "activity" && !loading && !error ? (
        activity && activity.files.length > 0 ? (
          <div className="chat-side-list" style={{ maxWidth: 720 }}>
            {activity.files.map((f) => (
              <FileRow key={f.path} f={f} onClick={f.lastConversationId ? () => setDiffFor({ convId: f.lastConversationId!, path: f.path }) : undefined} />
            ))}
          </div>
        ) : <Empty>Aucune modification enregistrée sur ce projet.</Empty>
      ) : null}

      {tab === "feed" && !loading && !error ? (
        feed.length > 0 ? (
          <div style={{ maxWidth: 860 }}>
            <FeedList feed={feed} onOpenEvent={(e) => setDiffFor({ convId: e.conversationId, path: e.path })} />
          </div>
        ) : <Empty>Les modifications des agents apparaîtront ici.</Empty>
      ) : null}

      {tab === "files" ? <TreePanel workspaceId={workspace.id} modifiedPaths={modified} /> : null}

      {tab === "team" && !loading && !error ? (
        <TeamTab
          agents={props.agents}
          cards={cards}
          conversations={convs}
          onTalk={(agent) => {
            api.createConversation({ workspace_id: workspace.id, agent_id: agent.id })
              .then((r) => props.onOpenConversation(r.conversation.id))
              .catch(() => toast("Création de la conversation impossible", true));
          }}
        />
      ) : null}

      {tab === "pm" ? (
        pmConv ? (
          <div className="tab-chat">
            <ChatView
              conversation={pmConv}
              onClose={() => setTab("board")}
              onDeleted={() => { setPmConv(null); setTab("board"); }}
             
            />
          </div>
        ) : (
          <Empty>{pmLoading ? <span role="status">Préparation de la conversation avec le Chef de Projet…</span> : <>
            <span role="alert">{pmError || "Conversation indisponible."}</span>{" "}
            <button type="button" className="btn btn-sm" onClick={() => void openPm()}>Réessayer</button>
          </>}</Empty>
        )
      ) : null}

      {tab === "conversations" && !loading && !error ? (
        convs.length > 0 ? (
          <div className="cards" style={{ marginTop: 4 }}>
            {convs.map((c) => (
              <button type="button" key={c.id} className="card clickable" onClick={() => props.onOpenConversation(c.id)}>
                <h4>{c.title || "(sans titre)"}</h4>
                <div className="meta">
                  <span className="mono">{c.provider}/{c.model}{c.thinking ? `:${c.thinking}` : ""}</span>
                  <span><Badge color={statusColor(c.status)}>{c.status}</Badge>{" "}<span className="muted">{new Date(c.updated_at).toLocaleString()}</span></span>
                </div>
              </button>
            ))}
          </div>
        ) : <Empty>Aucune conversation dans ce workspace. Ouvre l’onglet Chef de projet pour commencer.</Empty>
      ) : null}
      </> : null}
      </div>)}
      {LazyDiff}
    </>
  );
}


/** Qui est sur le projet et qui fait quoi : par agent, cartes assignées (par colonne) + conversations. */
function TeamTab(props: {
  agents: AgentPreset[];
  cards: BoardCard[];
  conversations: Conversation[];
  onTalk: (agent: AgentPreset) => void;
}) {
  const members = props.agents
    .map((a) => ({
      agent: a,
      assigned: props.cards.filter((c) => c.assignee_agent_id === a.id),
      convs: props.conversations.filter((c) => c.agent_id === a.id),
    }))
    .filter((m) => m.assigned.length > 0 || m.convs.length > 0);

  if (members.length === 0) {
    return <Empty>Personne sur ce projet pour l’instant. Assigne un agent à une carte du tableau ou ouvre l’onglet Chef de projet.</Empty>;
  }

  const COLS: Array<{ id: string; label: string }> = [
    { id: "in_progress", label: "En cours" },
    { id: "todo", label: "À faire" },
    { id: "backlog", label: "À planifier" },
    { id: "done", label: "Terminé" },
  ];

  return (
    <div className="cards" style={{ marginTop: 4 }}>
      {members.map(({ agent, assigned, convs }) => {
        const active = assigned.filter((c) => c.status === "in_progress" || c.status === "todo");
        const lastActivity = Math.max(
          ...assigned.map((c) => Date.parse(c.updated_at) || 0),
          ...convs.map((c) => Date.parse(c.updated_at) || 0),
          0,
        );
        return (
          <div key={agent.id} className="card" style={{ cursor: "default" }}>
            <h4>
              {agent.name}{" "}
              <span className="muted mono" style={{ fontSize: 11 }}>{agent.provider}/{agent.model}</span>
            </h4>
            <div className="meta">
              <span className="team-stats">
                {COLS.map((col) => {
                  const n = assigned.filter((c) => c.status === col.id).length;
                  return n > 0 ? <span key={col.id} className="team-stat">{col.label} : <strong>{n}</strong></span> : null;
                })}
                {convs.length > 0 ? <span className="team-stat">{convs.length} conversation(s)</span> : null}
              </span>
              {active.length > 0 ? (
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {active.slice(0, 4).map((c) => (
                    <a key={c.id} className="team-ticket mono" href={c.url} target="_blank" rel="noreferrer" title={c.title}>
                      #{c.number} {c.title.slice(0, 42)}{c.title.length > 42 ? "…" : ""}
                    </a>
                  ))}
                  {active.length > 4 ? <span className="muted">+{active.length - 4} autre(s)…</span> : null}
                </span>
              ) : (
                <span className="muted">Aucun ticket actif</span>
              )}
              {lastActivity > 0 ? <span className="muted">activité : {new Date(lastActivity).toLocaleString()}</span> : null}
            </div>
            <div className="actions">
              <button className="btn btn-sm" onClick={() => props.onTalk(agent)}>Ouvrir une conversation</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
