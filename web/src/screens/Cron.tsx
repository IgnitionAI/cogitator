import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AgentPreset, CronRun, CronTask, Workspace } from "../types";
import { Badge, Empty, ErrorText, Field, IconBtn, Modal, PageHead, statusColor, useToast } from "../ui";
import { Icon } from "../icons";

export default function Cron() {
  const toast = useToast();
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<CronTask | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([api.schedules(), api.agents(), api.workspaces()]).then(([t, a, w]) => { setTasks(t.schedules); setAgents(a.agents); setWorkspaces(w.workspaces); setError(null); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <>
      <PageHead
        title="Cron"
        sub="Exécute un prompt avec un agent à heure fixe. Le serveur Cogitator doit rester démarré."
        actions={<button type="button" className="btn btn-primary" disabled={loading || !!error} onClick={() => setEditing("new")}><Icon name="plus" /> Nouvelle tâche</button>}
      />
      <p className="muted">Expressions cron : fuseau local du serveur. Dates affichées : fuseau du navigateur ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={refresh}>Réessayer</button> : null}
      {loading ? <p role="status">Chargement…</p> : error && tasks.length === 0 ? null : tasks.length === 0 ? (
        <Empty title="Aucune tâche" action={<button type="button" className="btn btn-primary" disabled={loading || !!error} onClick={() => setEditing("new")}><Icon name="plus" /> Nouvelle tâche</button>}>
          Choisis un agent, un workspace et une fréquence. Le serveur doit rester démarré.
        </Empty>
      ) : (
        <div className="table-wrap" role="region" aria-label="Tâches planifiées" tabIndex={0}>
        <table>
          <thead>
            <tr><th>Nom</th><th>Expression</th><th>Agent</th><th>Prochaine exécution</th><th>Dernière exécution</th><th>Activée</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="mono">{t.cron_expr}</td>
                <td className="mono">{agents.find((a) => a.id === t.agent_id)?.name ?? "—"}</td>
                <td className="muted">{t.next_run_at ? new Date(t.next_run_at).toLocaleString() : "—"}</td>
                <td className="muted">{t.last_run_at ? new Date(t.last_run_at).toLocaleString() : "jamais"}</td>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    disabled={pendingTask === t.id}
                    aria-label={`Activer la tâche ${t.name}`}
                    checked={t.enabled === 1}
                    onChange={(e) => { if (pendingTask === t.id) return; setPendingTask(t.id); api.updateSchedule(t.id, { enabled: e.target.checked }).then(refresh).catch((err: Error) => toast(err.message, true)).finally(() => setPendingTask(null)); }}
                  />
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm" onClick={() => setRunsFor(t.id)}>Historique</button>{" "}
                  <button className="btn btn-sm" onClick={() => setEditing(t)}>Modifier</button>{" "}
                  <IconBtn name="play" label={`Lancer ${t.name} maintenant`} onClick={() => api.fireSchedule(t.id).then(() => toast(`Exécution lancée : ${t.name}`)).catch((e: Error) => toast(e.message, true))} />
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => { if (confirm(`Supprimer la tâche "${t.name}" (et son historique d’exécution) ?`)) api.deleteSchedule(t.id).then(refresh).catch((e: Error) => toast(e.message, true)); }}
                  >
                    Supprimer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {runsFor && tasks.some((t) => t.id === runsFor) ? <RunsModal task={tasks.find((t) => t.id === runsFor)!} onClose={() => { setRunsFor(null); refresh(); }} /> : null}
      {editing ? (
        <TaskEditor
          task={editing === "new" ? null : editing}
          agents={agents}
          workspaces={workspaces}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
         
        />
      ) : null}
    </>
  );
}

function RunsModal({ task, onClose }: { task: CronTask; onClose: () => void }) {
  const [runs, setRuns] = useState<CronRun[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.runs(task.id).then((r) => { setRuns(r.runs); setError(null); })
      .catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [task.id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Modal title={`Exécutions : ${task.name}`} onClose={onClose} wide>
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={load}>Réessayer</button> : null}
      {loading ? <p role="status">Chargement des exécutions…</p> : error && runs.length === 0 ? null : runs.length === 0 ? <Empty>Aucune exécution pour le moment.</Empty> : (
        <div className="table-wrap" role="region" aria-label="Historique des exécutions" tabIndex={0}><table>
          <thead><tr><th>Début</th><th>Fin</th><th>Statut</th><th>Session</th><th>Erreur</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="muted">{new Date(r.started_at).toLocaleString()}</td>
                <td className="muted">{r.finished_at ? new Date(r.finished_at).toLocaleString() : "…"}</td>
                <td><Badge color={statusColor(r.status)}>{r.status}</Badge></td>
                <td className="mono" title={r.session_file ?? undefined} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{r.session_file ?? "—"}</td>
                <td className="error-text" style={{ margin: 0 }}>{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Modal>
  );
}

function TaskEditor(props: {
  task: CronTask | null;
  agents: AgentPreset[];
  workspaces: Workspace[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: props.task?.name ?? "",
    cron_expr: props.task?.cron_expr ?? "0 9 * * *",
    prompt: props.task?.prompt ?? "",
    agent_id: props.task?.agent_id ?? props.agents[0]?.id ?? "",
    workspace_id: props.task?.workspace_id ?? props.workspaces[0]?.id ?? "",
    output_policy: props.task?.output_policy ?? "append_session",
    busy_policy: props.task?.busy_policy ?? "skip",
    catchup: (props.task?.catchup ?? 1) === 1,
  });

  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy || !form.agent_id || !form.workspace_id || !form.cron_expr.trim()) return;
    setActionError(null);
    setBusy(true);
    try {
      if (props.task) await api.updateSchedule(props.task.id, form);
      else await api.createSchedule(form);
      props.onSaved();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Opération impossible. Réessaie.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={props.task ? `Modifier : ${props.task.name}` : "Nouvelle tâche cron"} onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError} />
      {props.agents.length === 0 || props.workspaces.length === 0 ? <p role="status" className="muted">Crée un agent et un workspace avant de planifier une tâche.</p> : null}
      <div className="form-row">
        <Field label="Nom"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Expression cron" hint="5 champs : min heure jour mois jour de semaine, ex. 0 9 * * 1-5. Fuseau local du serveur (pas celui du navigateur).">
          <input value={form.cron_expr} onChange={(e) => setForm({ ...form, cron_expr: e.target.value })} className="mono" />
        </Field>
      </div>
      <Field label="Prompt envoyé à l’exécution">
        <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
      </Field>
      <div className="form-row">
        <Field label="Agent">
          <select value={form.agent_id} onChange={(e) => setForm({ ...form, agent_id: e.target.value })}>
            {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Workspace">
          <select value={form.workspace_id} onChange={(e) => setForm({ ...form, workspace_id: e.target.value })}>
            {props.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Sortie">
          <select value={form.output_policy} onChange={(e) => setForm({ ...form, output_policy: e.target.value })}>
            <option value="append_session">Réutiliser la session dédiée</option>
            <option value="new_session">Nouvelle session à chaque exécution</option>
          </select>
        </Field>
        <Field label="Si une exécution est déjà active">
          <select value={form.busy_policy} onChange={(e) => setForm({ ...form, busy_policy: e.target.value })}>
            <option value="skip">Ignorer cette exécution</option>
            <option value="queue">Mettre en attente</option>
            <option value="kill">Arrêter l’exécution précédente</option>
          </select>
        </Field>
      </div>
      <label style={{ display: "flex", gap: 8, marginBottom: 14, fontSize: 13 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={form.catchup} onChange={(e) => setForm({ ...form, catchup: e.target.checked })} />
        Rattraper une exécution manquée au redémarrage
      </label>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={busy || !form.agent_id || !form.workspace_id || !form.name.trim() || !form.prompt.trim() || !form.cron_expr.trim()} onClick={() => void save()}>
          {busy ? "Enregistrement…" : "Enregistrer la tâche"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>Annuler</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">Opération en cours. Attends la fin avant de fermer.</p> : null}
    </Modal>
  );
}
