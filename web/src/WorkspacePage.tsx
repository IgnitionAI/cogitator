import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { BoardPanel } from "./Board";
import { FileRow, TreePanel } from "./FileViews";
import type { AgentPreset, Conversation, FeedEvent, FileChange, Workspace } from "./types";
import { Badge, Empty, statusColor } from "./ui";
import { ChatView } from "./screens/Conversations";

const TABS = [
  { id: "board", label: "🗂 Board" },
  { id: "activity", label: "📄 Activité" },
  { id: "feed", label: "🕒 Feed" },
  { id: "files", label: "🌳 Fichiers" },
  { id: "conversations", label: "💬 Conversations" },
  { id: "pm", label: "🤖 Chef de Projet" },
] as const;

export default function WorkspacePage(props: {
  workspace: Workspace;
  agents: AgentPreset[];
  toast: (t: string, err?: boolean) => void;
  onBack: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const { workspace } = props;
  const [tab, setTab] = useState<string>("board");
  const [activity, setActivity] = useState<{ files: FileChange[]; totals: { additions: number; deletions: number } } | null>(null);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [diffFor, setDiffFor] = useState<{ convId: string; path: string } | null>(null);
  const [pmConv, setPmConv] = useState<Conversation | null>(null);

  // conversation dédiée au Chef de Projet : réutilise la première existante, sinon la crée
  const openPm = useCallback(() => {
    if (pmConv) return;
    const chef = props.agents.find((a) => a.slug === "chef-de-projet");
    if (!chef) return;
    api.conversations(workspace.id).then((r) => {
      const existing = r.conversations.find((c) => c.agent_id === chef.id);
      if (existing) {
        setPmConv(existing);
        return;
      }
      api.createConversation({ workspace_id: workspace.id, agent_id: chef.id })
        .then((res) => setPmConv(res.conversation))
        .catch(() => undefined);
    }).catch(() => undefined);
  }, [pmConv, props.agents, workspace.id]);

  useEffect(() => {
    if (tab === "pm") openPm();
  }, [tab, openPm]);

  const refresh = useCallback(() => {
    api.workspaceActivity(workspace.id).then(setActivity).catch(() => undefined);
    api.workspaceFeed(workspace.id).then((r) => setFeed(r.events)).catch(() => undefined);
    api.conversations(workspace.id).then((r) => setConvs(r.conversations)).catch(() => undefined);
  }, [workspace.id]);

  useEffect(refresh, [refresh]);

  const modified = new Set((activity?.files ?? []).map((f) => f.path));
  const LazyDiff = diffFor ? (
    <DiffLoader conversationId={diffFor.convId} path={diffFor.path} onClose={() => setDiffFor(null)} />
  ) : null;

  return (
    <>
      <div className="ws-head">
        <button className="btn btn-sm" onClick={props.onBack}>← Workspaces</button>
        <h2>{workspace.name}</h2>
        <span className="muted mono" style={{ fontSize: 12 }}>{workspace.dir}</span>
        {activity && activity.files.length > 0 ? (
          <span className="file-stats" style={{ marginLeft: 12 }}>
            <span className="add">+{activity.totals.additions}</span>
            <span className="del">−{activity.totals.deletions}</span>
          </span>
        ) : null}
      </div>
      <div className="ws-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`ws-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === "conversations" && convs.length > 0 ? ` (${convs.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "board" ? <BoardPanel workspaceId={workspace.id} agents={props.agents} toast={props.toast} onOpenConversation={props.onOpenConversation} /> : null}

      {tab === "activity" ? (
        activity && activity.files.length > 0 ? (
          <div className="chat-side-list" style={{ maxWidth: 720 }}>
            {activity.files.map((f) => (
              <FileRow key={f.path} f={f} onClick={f.lastConversationId ? () => setDiffFor({ convId: f.lastConversationId!, path: f.path }) : undefined} />
            ))}
          </div>
        ) : <Empty>Aucune modification enregistrée sur ce projet.</Empty>
      ) : null}

      {tab === "feed" ? (
        feed.length > 0 ? (
          <div style={{ maxWidth: 860 }}>
            {(() => {
              const days = new Map<string, FeedEvent[]>();
              for (const e of feed) {
                const day = new Date(e.at).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                const list = days.get(day) ?? [];
                list.push(e);
                days.set(day, list);
              }
              return [...days.entries()].map(([day, events]) => (
                <div key={day}>
                  <div className="feed-day">{day}</div>
                  {events.map((e, i) => (
                    <div key={i} className="feed-row" onClick={() => setDiffFor({ convId: e.conversationId, path: e.path })} title={e.path}>
                      <span className="feed-time">{new Date(e.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="feed-conv">{e.conversationTitle}</span>
                      <span className="feed-path mono">{e.path.split("/").slice(-2).join("/")}</span>
                      <span className="file-stats">
                        {e.additions > 0 ? <span className="add">+{e.additions}</span> : null}
                        {e.deletions > 0 ? <span className="del">−{e.deletions}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              ));
            })()}
          </div>
        ) : <Empty>Aucune activité.</Empty>
      ) : null}

      {tab === "files" ? <TreePanel workspaceId={workspace.id} modifiedPaths={modified} /> : null}

      {tab === "pm" ? (
        pmConv ? (
          <div className="tab-chat">
            <ChatView
              conversation={pmConv}
              onClose={() => setTab("board")}
              onDeleted={() => { setPmConv(null); setTab("board"); }}
              toast={props.toast}
            />
          </div>
        ) : (
          <Empty>Préparation de la conversation avec le Chef de Projet…</Empty>
        )
      ) : null}

      {tab === "conversations" ? (
        convs.length > 0 ? (
          <div className="cards" style={{ marginTop: 4 }}>
            {convs.map((c) => (
              <div key={c.id} className="card clickable" onClick={() => props.onOpenConversation(c.id)}>
                <h4>{c.title || "(sans titre)"}</h4>
                <div className="meta">
                  <span className="mono">{c.provider}/{c.model}{c.thinking ? `:${c.thinking}` : ""}</span>
                  <span><Badge color={statusColor(c.status)}>{c.status}</Badge>{" "}<span className="muted">{new Date(c.updated_at).toLocaleString()}</span></span>
                </div>
              </div>
            ))}
          </div>
        ) : <Empty>Aucune conversation dans ce workspace.</Empty>
      ) : null}
      {LazyDiff}
    </>
  );
}

import { FileDiffModal } from "./FileViews";
function DiffLoader(props: { conversationId: string; path: string; onClose: () => void }) {
  return <FileDiffModal {...props} />;
}
