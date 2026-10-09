import { t, formatDate, formatNumber, localizeText, statusLabel, thinkingLabel } from "./i18n";
import type { workspaceMessages } from "./locales/workspace";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import { BoardPanel } from "./Board";
import { FileDiffModal, FileRow, TreePanel } from "./FileViews";
import { FeedList } from "./FeedList";
import type { AgentPreset, BoardCard, Conversation, FeedEvent, FileChange, Workspace } from "./types";
import { Badge, Empty, statusColor, useToast } from "./ui";
import { ChatView } from "./screens/Conversations";
import { Icon, type IconName } from "./icons";

const TABS: Array<{ id: string; label: keyof typeof workspaceMessages; icon: IconName }> = [
  { id: "board", label: "workspace.board", icon: "board" },
  { id: "activity", label: "workspace.activity", icon: "activity" },
  { id: "feed", label: "workspace.feed", icon: "feed" },
  { id: "files", label: "workspace.files", icon: "tree" },
  { id: "conversations", label: "workspace.conversations", icon: "chat" },
  { id: "team", label: "workspace.team", icon: "users" },
  { id: "pm", label: "workspace.pm", icon: "bot" },
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
      setPmError("workspace.pmMissing");
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
        <button type="button" className="btn btn-sm" onClick={props.onBack}><Icon name="back" /> {t("workspace.workspaces")}</button>
        <h1>{workspace.name}</h1>
        <span className="muted mono" style={{ fontSize: 12 }}>{workspace.dir}</span>
        {stats && stats.files.length > 0 ? (
          <span className="file-stats" style={{ marginLeft: 12 }}>
            <span className="add">+{formatNumber(stats.totals.additions)}</span>
            <span className="del">−{formatNumber(stats.totals.deletions)}</span>
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-sm"
          title={t("workspace.initHelp")}
          onClick={() => {
            const majordome = props.agents.find((a) => a.slug === "majordome");
            if (!majordome) {
              toast(t("workspace.majordomoMissing"), true);
              return;
            }
            api.createConversation({
              workspace_id: workspace.id,
              agent_id: majordome.id,
              prompt: t("workspace.initPrompt"),
            })
              .then((r) => props.onOpenConversation(r.conversation.id))
              .catch((e: Error) => toast(t("workspace.error", { detail: localizeText(e.message) }), true));
          }}
        >
          <Icon name="spark" size={14} /> {t("workspace.init")}
        </button>
      </div>
      <div className="ws-tabs" role="tablist" aria-label={t("workspace.workspace")}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`${tabsId}-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={(e) => {
              const index = TABS.findIndex((candidate) => candidate.id === item.id);
              const next = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1
                : e.key === "ArrowRight" ? (index + 1) % TABS.length
                : e.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : null;
              if (next === null) return;
              e.preventDefault();
              const id = TABS[next]!.id;
              setTab(id);
              document.getElementById(`${tabsId}-tab-${id}`)?.focus();
            }}
            className={`ws-tab ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={14} /> {t(item.label)}
            {item.id === "conversations" && convs.length > 0 ? t("workspace.tabCount", { count: formatNumber(convs.length) }) : ""}
          </button>
        ))}
      </div>

      {TABS.map((item) => <div key={item.id} id={`${tabsId}-panel-${item.id}`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${item.id}`} hidden={tab !== item.id} tabIndex={0}>
      {tab === item.id ? <>
      {["activity", "feed", "team", "conversations"].includes(tab) ? <>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={refresh}>{t("workspace.refresh")}</button>
        {loading ? <p role="status">{t("workspace.loading")}</p> : null}
        {error ? <div role="alert" className="error-text">{t("workspace.error", { detail: localizeText(error) })} <button type="button" className="btn btn-sm" onClick={refresh}>{t("workspace.retry")}</button></div> : null}
      </> : null}
      {tab === "board" ? <BoardPanel workspaceId={workspace.id} agents={props.agents} onOpenConversation={props.onOpenConversation} /> : null}

      {tab === "activity" && !loading && !error ? (
        activity && activity.files.length > 0 ? (
          <div className="chat-side-list" style={{ maxWidth: 720 }}>
            {activity.files.map((f) => (
              <FileRow key={f.path} f={f} onClick={f.lastConversationId ? () => setDiffFor({ convId: f.lastConversationId!, path: f.path }) : undefined} />
            ))}
          </div>
        ) : <Empty>{t("workspace.noChanges")}</Empty>
      ) : null}

      {tab === "feed" && !loading && !error ? (
        feed.length > 0 ? (
          <div style={{ maxWidth: 860 }}>
            <FeedList feed={feed} onOpenEvent={(e) => setDiffFor({ convId: e.conversationId, path: e.path })} />
          </div>
        ) : <Empty>{t("workspace.feedEmpty")}</Empty>
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
              .catch((e: Error) => toast(t("workspace.conversationFailed") + ": " + localizeText(e.message), true));
          }}
        />
      ) : null}

      {tab === "pm" ? (
        pmConv ? (
          <div className="tab-chat">
            <ChatView
              embedded
              conversation={pmConv}
              onClose={() => setTab("board")}
              onDeleted={() => { setPmConv(null); setTab("board"); }}
            />
          </div>
        ) : (
          <Empty>{pmLoading ? <span role="status">{t("workspace.pmPreparing")}</span> : <>
            <span role="alert">{pmError === "workspace.pmMissing" ? t("workspace.pmMissing") : pmError ? t("workspace.error", { detail: localizeText(pmError) }) : t("workspace.unavailable")}</span>{" "}
            <button type="button" className="btn btn-sm" onClick={() => void openPm()}>{t("workspace.retry")}</button>
          </>}</Empty>
        )
      ) : null}

      {tab === "conversations" && !loading && !error ? (
        convs.length > 0 ? (
          <div className="cards" style={{ marginTop: 4 }}>
            {convs.map((c) => (
              <button type="button" key={c.id} className="card clickable" onClick={() => props.onOpenConversation(c.id)}>
                <h4>{c.title || t("workspace.untitled")}</h4>
                <div className="meta">
                  <span className="mono">{c.provider}/{c.model}{c.thinking ? `:${thinkingLabel(c.thinking)}` : ""}</span>
                  <span><Badge color={statusColor(c.status)}>{statusLabel(c.status)}</Badge>{" "}<span className="muted">{formatDate(c.updated_at)}</span></span>
                </div>
              </button>
            ))}
          </div>
        ) : <Empty>{t("workspace.noConversations")}</Empty>
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
    return <Empty>{t("workspace.noTeam")}</Empty>;
  }

  const COLS: Array<{ id: string; label: keyof typeof workspaceMessages }> = [
    { id: "in_progress", label: "workspace.inProgress" },
    { id: "todo", label: "workspace.todo" },
    { id: "backlog", label: "workspace.backlog" },
    { id: "done", label: "workspace.done" },
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
                  return n > 0 ? <span key={col.id} className="team-stat">{t(col.label)} : <strong>{formatNumber(n)}</strong></span> : null;
                })}
                {convs.length > 0 ? <span className="team-stat">{t((convs.length) === 1 ? "workspace.conversationCountOne" : "workspace.conversationCountMany", { count: formatNumber(convs.length) })}</span> : null}
              </span>
              {active.length > 0 ? (
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {active.slice(0, 4).map((c) => (
                    <a key={c.id} className="team-ticket mono" href={c.url} target="_blank" rel="noreferrer" title={c.title}>
                      #{c.number} {c.title.slice(0, 42)}{c.title.length > 42 ? "…" : ""}
                    </a>
                  ))}
                  {active.length > 4 ? <span className="muted">{t((active.length - 4) === 1 ? "workspace.moreOne" : "workspace.moreMany", { count: formatNumber(active.length - 4) })}</span> : null}
                </span>
              ) : (
                <span className="muted">{t("workspace.noTickets")}</span>
              )}
              {lastActivity > 0 ? <span className="muted">{t("workspace.lastActivity", { date: formatDate(lastActivity) })}</span> : null}
            </div>
            <div className="actions">
              <button className="btn btn-sm" onClick={() => props.onTalk(agent)}>{t("workspace.openConversation")}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
