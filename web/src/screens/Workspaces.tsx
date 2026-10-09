import { t as translate, formatNumber } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentPreset, FeedEvent, FileChange, Workspace } from "../types";
import { Empty, ErrorText, Field, Modal, PageHead, useToast } from "../ui";
import { Icon } from "../icons";
import { FileDiffModal, FileRow, FileTreeModal } from "../FileViews";
import BoardModal from "../Board";
import { FeedList } from "../FeedList";

interface WorkspaceActivity {
  files: FileChange[];
  totals: { additions: number; deletions: number };
  conversations: number;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; type: "dir" | "file" }>;
}

export default function Workspaces({ onOpenWorkspace }: { onOpenWorkspace?: (w: Workspace) => void }) {
  const toast = useToast();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [activity, setActivity] = useState<Record<string, WorkspaceActivity>>({});
  const [activityFor, setActivityFor] = useState<string | null>(null);
  const [feedFor, setFeedFor] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const feedRequest = useRef(0);
  useEffect(() => () => { feedRequest.current++; }, []);
  const [activityErrors, setActivityErrors] = useState<Record<string, string | null>>({});
  const loadActivity = (id: string) => {
    setActivityErrors((prev) => ({ ...prev, [id]: null }));
    api.workspaceActivity(id).then((a) => setActivity((prev) => ({ ...prev, [id]: a })))
      .catch((e: Error) => setActivityErrors((prev) => ({ ...prev, [id]: e.message })));
  };
  const loadFeed = (id: string) => {
    const current = ++feedRequest.current;
    setFeed([]);
    setFeedLoading(true);
    setFeedError(null);
    api.workspaceFeed(id).then((r) => { if (current === feedRequest.current) setFeed(r.events); })
      .catch((e: Error) => { if (current === feedRequest.current) setFeedError(e.message); })
      .finally(() => { if (current === feedRequest.current) setFeedLoading(false); });
  };
  const [diffFor, setDiffFor] = useState<{ convId: string; path: string } | null>(null);
  const [treeFor, setTreeFor] = useState<string | null>(null);
  const [boardFor, setBoardFor] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([api.workspaces(), api.agents()]).then(([r, a]) => {
      setAgents(a.agents);
      setError(null);
      setWorkspaces(r.workspaces);
      for (const w of r.workspaces) {
        loadActivity(w.id);
      }
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <>
      <PageHead
        title={translate("screens.workspaces")}
        sub={translate("screens.workspacesSub")}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" /> {translate("screens.addWorkspace")}
          </button>
        }
      />
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={refresh}>{translate("screens.retry")}</button> : null}
      {loading ? <p role="status">{translate("screens.loading")}</p> : error && workspaces.length === 0 ? null : workspaces.length === 0 ? (
        <Empty title={translate("screens.noWorkspaces")} action={<button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" /> {translate("screens.addFolder")}</button>}>
          {translate("screens.workspaceEmpty")}
        </Empty>
      ) : (
        <div className="cards">
          {workspaces.map((w) => (
            <div key={w.id} className="card">
              <h2>{w.name}</h2>
              <div className="meta">
                <span className="mono">{w.dir}</span>
                <span>{translate("screens.conversations", { count: formatNumber(w.conversation_count ?? 0) })}</span>
                {activity[w.id] && activity[w.id]!.files.length > 0 ? (
                  <span className="file-stats">
                    {translate("screens.activityPrefix")} <span className="add">+{formatNumber(activity[w.id]!.totals.additions)}</span>
                    <span className="del">−{formatNumber(activity[w.id]!.totals.deletions)}</span>
                    <span className="muted">{translate("screens.onFiles", { count: formatNumber(activity[w.id]!.files.length) })}</span>
                  </span>
                ) : null}
              </div>
              <Field label={translate("screens.defaultAgent")}>
                <select
                  value={w.default_agent_id ?? ""}
                  onChange={(e) => {
                    api.updateWorkspace(w.id, { default_agent_id: e.target.value || null })
                      .then(refresh)
                      .catch((err: Error) => toast(err.message, true));
                  }}
                >
                  <option value="">{translate("screens.none")}</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <div className="actions">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpenWorkspace?.(w)}>{translate("screens.open")}</button>
                <button type="button" className="btn btn-sm" onClick={() => { setActivityFor(w.id); loadActivity(w.id); }}>
                  <Icon name="activity" size={14} /> {translate("screens.activity")}{activity[w.id] && activity[w.id]!.files.length > 0 ? ` (${formatNumber(activity[w.id]!.files.length)})` : ""}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setFeedFor(w.id);
                    loadFeed(w.id);
                  }}
                >
                  <Icon name="feed" size={14} /> {translate("screens.feed")}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setTreeFor(w.id)} title={translate("screens.readOnlyTree")}>
                  <Icon name="tree" size={14} /> {translate("screens.files")}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setBoardFor(w.id)} title={translate("screens.projectBoard")}>
                  <Icon name="board" size={14} /> {translate("screens.board")}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    if (confirm(translate("screens.deleteWorkspace", { name: w.name }))) {
                      api.deleteWorkspace(w.id).then(refresh).catch((e: Error) => toast(e.message, true));
                    }
                  }}
                >
                  {translate("screens.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showAdd ? <AddWorkspaceModal onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); refresh(); }} /> : null}
      {activityFor ? (
        <Modal title={translate("screens.activityFor", { name: workspaces.find((w) => w.id === activityFor)?.name ?? "" })} onClose={() => setActivityFor(null)} wide>
          <ErrorText error={activityErrors[activityFor] ?? null} />
          {activityErrors[activityFor] ? <button type="button" className="btn" onClick={() => loadActivity(activityFor)}>{translate("screens.retry")}</button> : !activity[activityFor] ? <p role="status">{translate("screens.loadingActivity")}</p> : null}
          {activity[activityFor] ? <>
          {activity[activityFor]!.files.length === 0 ? <Empty>{translate("screens.noChangedFiles")}</Empty> : null}
          <div className="file-stats" style={{ marginBottom: 12, fontSize: 13 }}>
            <span className="add">+{formatNumber(activity[activityFor]!.totals.additions)}</span>
            <span className="del">−{formatNumber(activity[activityFor]!.totals.deletions)}</span>
            <span className="muted">{translate("screens.scanned", { files: formatNumber(activity[activityFor]!.files.length), conversations: formatNumber(activity[activityFor]!.conversations) })}</span>
          </div>
          <div className="chat-side-list" style={{ maxHeight: "55vh" }}>
            {activity[activityFor]!.files.map((f) => (
              <FileRow key={f.path} f={f} onClick={() => f.lastConversationId && setDiffFor({ convId: f.lastConversationId, path: f.path })} />
            ))}
          </div>
          </> : null}
        </Modal>
      ) : null}
      {feedFor ? (
        <Modal title={translate("screens.feedFor", { name: workspaces.find((w) => w.id === feedFor)?.name ?? "" })} onClose={() => { feedRequest.current++; setFeedFor(null); }} wide>
          <ErrorText error={feedError} />
          {feedError ? <button type="button" className="btn" onClick={() => loadFeed(feedFor)}>{translate("screens.retry")}</button> : null}
          {feedLoading ? <p role="status">{translate("screens.loadingFeed")}</p> : !feedError && feed.length === 0 ? <div className="muted" style={{ padding: 12 }}>{translate("screens.noActivity")}</div> : null}
          <FeedList feed={feed} onOpenEvent={(e) => setDiffFor({ convId: e.conversationId, path: e.path })} />
        </Modal>
      ) : null}
      {diffFor ? (
        <FileDiffModal conversationId={diffFor.convId} path={diffFor.path} onClose={() => setDiffFor(null)} />
      ) : null}
      {boardFor ? (
        <BoardModal
          workspaceId={boardFor}
          workspaceName={workspaces.find((w) => w.id === boardFor)?.name ?? ""}
          agents={agents}
          onClose={() => setBoardFor(null)}
         
        />
      ) : null}
      {treeFor ? (
        <FileTreeModal
          workspaceId={treeFor}
          workspaceName={workspaces.find((w) => w.id === treeFor)?.name ?? ""}
          modifiedPaths={new Set((activity[treeFor]?.files ?? []).map((f) => f.path))}
          onClose={() => setTreeFor(null)}
        />
      ) : null}
    </>
  );
}

function AddWorkspaceModal(props: { onClose: () => void; onAdded: () => void }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [requestedPath, setRequestedPath] = useState<string | undefined>();
  const load = (path?: string) => {
    setRequestedPath(path);
    setLoading(true);
    setBrowseError(null);
    api.browse(path).then((r) => { setBrowse(r); setSelected(r.path); })
      .catch((e: Error) => setBrowseError(e.message)).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!selected || busy || loading || browseError) return;
    setActionError(null);
    setBusy(true);
    try {
      await api.createWorkspace({ dir: selected, name: name.trim() || undefined });
      props.onAdded();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : translate("screens.operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={translate("screens.addWorkspace")} onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError} />
      <div className="mono" style={{ marginBottom: 8 }}>
        {browse ? (
          <>
            <button type="button" className="btn btn-sm" disabled={loading || !browse.parent} onClick={() => browse.parent && load(browse.parent)}><Icon name="back" size={14} /> {translate("screens.parentFolder")}</button>{" "}
            {browse.path}
          </>
        ) : translate("screens.loading")}
      </div>
      <ErrorText error={browseError} />
      {browseError ? <button type="button" className="btn" onClick={() => load(requestedPath)}>{translate("screens.retry")}</button> : null}
      {loading ? <p role="status">{translate("screens.loadingFolders")}</p> : null}
      <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, marginBottom: 12 }}>
        {!loading && !browseError && browse && !browse.entries.some((e) => e.type === "dir") ? <p className="muted" style={{ padding: 12 }}>{translate("screens.noSubfolders")}</p> : null}
        {browse?.entries.filter((e) => e.type === "dir").map((e) => (
          <button
            type="button"
            aria-pressed={selected === e.path}
            disabled={loading}
            key={e.path}
            onClick={() => setSelected(e.path)}
            onDoubleClick={() => load(e.path)}
            style={{
              display: "block", width: "100%", textAlign: "left", border: 0, color: "var(--fg)",
              padding: "6px 10px", cursor: "pointer",
              background: selected === e.path ? "var(--raised)" : "transparent",
            }}
          >
            <Icon name="folder" size={14} /> {e.name}
          </button>
        ))}
      </div>
      <p className="muted">{translate("screens.browseHint")}</p>
      <Field label={translate("screens.optionalName")}>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="toolbar">
        <button className="btn" disabled={!selected || loading} onClick={() => selected && load(selected)}>{translate("screens.openFolder")}</button>
        <button className="btn btn-primary" disabled={!selected || busy || loading || !!browseError} onClick={() => void add()}>
          {busy ? translate("screens.adding") : translate("screens.addNamed", { name: selected ? (selected.split("/").pop() || "/") : "" })}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>{translate("screens.cancel")}</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">{translate("screens.pending")}</p> : null}
    </Modal>
  );
}
