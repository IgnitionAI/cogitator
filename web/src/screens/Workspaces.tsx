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
        title="Workspaces"
        sub="Un dossier = un workspace. Sessions, skills et config projet pi s'y rattachent."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" /> Ajouter un workspace
          </button>
        }
      />
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={refresh}>Réessayer</button> : null}
      {loading ? <p role="status">Chargement…</p> : error && workspaces.length === 0 ? null : workspaces.length === 0 ? (
        <Empty title="Aucun workspace" action={<button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" /> Ajouter un dossier</button>}>
          Ajoute un dossier de projet pour y rattacher conversations et board.
        </Empty>
      ) : (
        <div className="cards">
          {workspaces.map((w) => (
            <div key={w.id} className="card">
              <h2>{w.name}</h2>
              <div className="meta">
                <span className="mono">{w.dir}</span>
                <span>{w.conversation_count ?? 0} conversation(s)</span>
                {activity[w.id] && activity[w.id]!.files.length > 0 ? (
                  <span className="file-stats">
                    activité : <span className="add">+{activity[w.id]!.totals.additions}</span>
                    <span className="del">−{activity[w.id]!.totals.deletions}</span>
                    <span className="muted"> sur {activity[w.id]!.files.length} fichier(s)</span>
                  </span>
                ) : null}
              </div>
              <Field label="Agent par défaut">
                <select
                  value={w.default_agent_id ?? ""}
                  onChange={(e) => {
                    api.updateWorkspace(w.id, { default_agent_id: e.target.value || null })
                      .then(refresh)
                      .catch((err: Error) => toast(err.message, true));
                  }}
                >
                  <option value="">— aucun —</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <div className="actions">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpenWorkspace?.(w)}>Ouvrir</button>
                <button type="button" className="btn btn-sm" onClick={() => { setActivityFor(w.id); loadActivity(w.id); }}>
                  <Icon name="activity" size={14} /> Activité{activity[w.id] && activity[w.id]!.files.length > 0 ? ` (${activity[w.id]!.files.length})` : ""}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setFeedFor(w.id);
                    loadFeed(w.id);
                  }}
                >
                  <Icon name="feed" size={14} /> Feed
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setTreeFor(w.id)} title="Arborescence en lecture seule">
                  <Icon name="tree" size={14} /> Fichiers
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setBoardFor(w.id)} title="Board kanban du projet">
                  <Icon name="board" size={14} /> Board
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    if (confirm(`Supprimer le workspace "${w.name}" ? Les conversations deviennent libres ; les sessions pi restent sur disque.`)) {
                      api.deleteWorkspace(w.id).then(refresh).catch((e: Error) => toast(e.message, true));
                    }
                  }}
                >
                  Supprimer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showAdd ? <AddWorkspaceModal onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); refresh(); }} /> : null}
      {activityFor ? (
        <Modal title={`Activité — ${workspaces.find((w) => w.id === activityFor)?.name ?? ""}`} onClose={() => setActivityFor(null)} wide>
          <ErrorText error={activityErrors[activityFor] ?? null} />
          {activityErrors[activityFor] ? <button type="button" className="btn" onClick={() => loadActivity(activityFor)}>Réessayer</button> : !activity[activityFor] ? <p role="status">Chargement de l’activité…</p> : null}
          {activity[activityFor] ? <>
          {activity[activityFor]!.files.length === 0 ? <Empty>Aucun fichier modifié.</Empty> : null}
          <div className="file-stats" style={{ marginBottom: 12, fontSize: 13 }}>
            <span className="add">+{activity[activityFor]!.totals.additions}</span>
            <span className="del">−{activity[activityFor]!.totals.deletions}</span>
            <span className="muted"> sur {activity[activityFor]!.files.length} fichier(s) · {activity[activityFor]!.conversations} conversation(s) scannée(s)</span>
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
        <Modal title={`Feed — ${workspaces.find((w) => w.id === feedFor)?.name ?? ""}`} onClose={() => { feedRequest.current++; setFeedFor(null); }} wide>
          <ErrorText error={feedError} />
          {feedError ? <button type="button" className="btn" onClick={() => loadFeed(feedFor)}>Réessayer</button> : null}
          {feedLoading ? <p role="status">Chargement du feed…</p> : !feedError && feed.length === 0 ? <div className="muted" style={{ padding: 12 }}>Aucune activité enregistrée.</div> : null}
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
      setActionError(e instanceof Error ? e.message : "Opération impossible. Réessaie.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Ajouter un workspace" onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError} />
      <div className="mono" style={{ marginBottom: 8 }}>
        {browse ? (
          <>
            <button type="button" className="btn btn-sm" disabled={loading || !browse.parent} onClick={() => browse.parent && load(browse.parent)}><Icon name="back" size={14} /> Dossier parent</button>{" "}
            {browse.path}
          </>
        ) : "Chargement…"}
      </div>
      <ErrorText error={browseError} />
      {browseError ? <button type="button" className="btn" onClick={() => load(requestedPath)}>Réessayer</button> : null}
      {loading ? <p role="status">Chargement des dossiers…</p> : null}
      <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, marginBottom: 12 }}>
        {!loading && !browseError && browse && !browse.entries.some((e) => e.type === "dir") ? <p className="muted" style={{ padding: 12 }}>Aucun sous-dossier. Tu peux ajouter le dossier actuel.</p> : null}
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
      <p className="muted">Sélectionne un dossier, puis ouvre-le pour parcourir ses sous-dossiers.</p>
      <Field label="Nom (optionnel, nom du dossier par défaut)">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="toolbar">
        <button className="btn" disabled={!selected || loading} onClick={() => selected && load(selected)}>Ouvrir le dossier sélectionné</button>
        <button className="btn btn-primary" disabled={!selected || busy || loading || !!browseError} onClick={() => void add()}>
          {busy ? "Ajout…" : `Ajouter ${selected ? (selected.split("/").pop() || "/") : ""}`}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>Annuler</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">Opération en cours. Attends la fin avant de fermer.</p> : null}
    </Modal>
  );
}
