import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AgentPreset, FileChange, Workspace } from "../types";
import { Empty, ErrorText, Field, Modal } from "../ui";

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

export default function Workspaces({ toast }: { toast: (t: string, err?: boolean) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [activity, setActivity] = useState<Record<string, WorkspaceActivity>>({});
  const [activityFor, setActivityFor] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.workspaces().then((r) => {
      setWorkspaces(r.workspaces);
      for (const w of r.workspaces) {
        api.workspaceActivity(w.id).then((a) => setActivity((prev) => ({ ...prev, [w.id]: a }))).catch(() => undefined);
      }
    }).catch((e: Error) => setError(e.message));
    api.agents().then((r) => setAgents(r.agents as AgentPreset[])).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <>
      <h2>Workspaces</h2>
      <div className="sub">Un dossier = un workspace · les sessions, skills et config projet pi s'y rattachent.</div>
      <ErrorText error={error} />
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Ajouter un workspace</button>
      </div>
      {workspaces.length === 0 ? (
        <Empty>Aucun workspace — ajoute un dossier de projet.</Empty>
      ) : (
        <div className="cards">
          {workspaces.map((w) => (
            <div key={w.id} className="card" style={{ cursor: "default" }}>
              <h4>{w.name}</h4>
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
                <button className="btn btn-sm" onClick={() => setActivityFor(w.id)}>
                  📄 Activité{activity[w.id] && activity[w.id]!.files.length > 0 ? ` (${activity[w.id]!.files.length})` : ""}
                </button>{" "}
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
      {showAdd ? <AddWorkspaceModal onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); refresh(); }} toast={toast} /> : null}
      {activityFor && activity[activityFor] ? (
        <Modal title={`Activité — ${workspaces.find((w) => w.id === activityFor)?.name ?? ""}`} onClose={() => setActivityFor(null)} wide>
          <div className="file-stats" style={{ marginBottom: 12, fontSize: 13 }}>
            <span className="add">+{activity[activityFor]!.totals.additions}</span>
            <span className="del">−{activity[activityFor]!.totals.deletions}</span>
            <span className="muted"> sur {activity[activityFor]!.files.length} fichier(s) · {activity[activityFor]!.conversations} conversation(s) scannée(s)</span>
          </div>
          <div className="chat-side-list" style={{ maxHeight: "55vh" }}>
            {activity[activityFor]!.files.map((f) => (
              <div key={f.path} className="file-row" title={f.path}>
                <span className={`file-kind ${f.kind}`}>{f.kind === "write" ? "W" : "E"}</span>
                <span className="file-path mono">{f.path.split("/").slice(-2).join("/")}</span>
                <span className="file-stats">
                  {f.additions > 0 ? <span className="add">+{f.additions}</span> : null}
                  {f.deletions > 0 ? <span className="del">−{f.deletions}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function AddWorkspaceModal(props: { onClose: () => void; onAdded: () => void; toast: (t: string, err?: boolean) => void }) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = (path?: string) => {
    api.browse(path).then(setBrowse).catch((e: Error) => props.toast(e.message, true));
  };

  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.createWorkspace({ dir: selected, name: name.trim() || undefined });
      props.onAdded();
    } catch (e) {
      props.toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Ajouter un workspace" onClose={props.onClose}>
      <div className="mono" style={{ marginBottom: 8 }}>
        {browse ? (
          <>
            <a style={{ color: "var(--accent)", cursor: "pointer" }} onClick={() => browse.parent && load(browse.parent)}>⬆ parent</a>{" "}
            {browse.path}
          </>
        ) : "Chargement…"}
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, marginBottom: 12 }}>
        {browse?.entries.filter((e) => e.type === "dir").map((e) => (
          <div
            key={e.path}
            onClick={() => setSelected(e.path)}
            onDoubleClick={() => load(e.path)}
            style={{
              padding: "6px 10px", cursor: "pointer",
              background: selected === e.path ? "var(--accent-2)" : undefined,
            }}
          >
            📁 {e.name}
          </div>
        ))}
      </div>
      <Field label="Nom (optionnel — défaut : nom du dossier)">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="toolbar">
        <button className="btn" onClick={() => selected && load(selected)}>Entrer</button>
        <button className="btn btn-primary" disabled={!selected || busy} onClick={() => void add()}>
          {busy ? "Ajout…" : `Choisir ${selected ? selected.split("/").pop() : ""}`}
        </button>
      </div>
    </Modal>
  );
}
