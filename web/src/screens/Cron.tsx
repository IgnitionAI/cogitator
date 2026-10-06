import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AgentPreset, CronRun, CronTask, Workspace } from "../types";
import { Badge, Empty, ErrorText, Field, Modal, statusColor } from "../ui";

export default function Cron({ toast }: { toast: (t: string, err?: boolean) => void }) {
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<CronTask | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.schedules().then((r) => setTasks(r.schedules)).catch((e: Error) => setError(e.message));
    api.agents().then((r) => setAgents(r.agents as AgentPreset[])).catch(() => undefined);
    api.workspaces().then((r) => setWorkspaces(r.workspaces)).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <>
      <h2>Cron</h2>
      <div className="sub">Tâches planifiées — un prompt tiré contre un agent, à heure fixe. ⚠ Le cron ne tourne que si le serveur Cogitator tourne.</div>
      <ErrorText error={error} />
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setEditing("new")}>+ Nouvelle tâche</button>
      </div>
      {tasks.length === 0 ? (
        <Empty>Aucune tâche planifiée.</Empty>
      ) : (
        <table>
          <thead>
            <tr><th>Nom</th><th>Expression</th><th>Agent</th><th>Prochain run</th><th>Dernier run</th><th>Activée</th><th></th></tr>
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
                    checked={t.enabled === 1}
                    onChange={(e) => api.updateSchedule(t.id, { enabled: e.target.checked }).then(refresh).catch((err: Error) => toast(err.message, true))}
                  />
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm" onClick={() => setRunsFor(t.id)}>Runs</button>{" "}
                  <button className="btn btn-sm" onClick={() => setEditing(t)}>Éditer</button>{" "}
                  <button className="btn btn-sm" onClick={() => api.fireSchedule(t.id).then(() => toast(`Run lancé : ${t.name}`)).catch((e: Error) => toast(e.message, true))}>▶</button>{" "}
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => { if (confirm(`Supprimer la tâche "${t.name}" (et son historique de runs) ?`)) api.deleteSchedule(t.id).then(refresh).catch((e: Error) => toast(e.message, true)); }}
                  >
                    Suppr.
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {runsFor ? <RunsModal task={tasks.find((t) => t.id === runsFor)!} onClose={() => { setRunsFor(null); refresh(); }} /> : null}
      {editing ? (
        <TaskEditor
          task={editing === "new" ? null : editing}
          agents={agents}
          workspaces={workspaces}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
          toast={toast}
        />
      ) : null}
    </>
  );
}

function RunsModal({ task, onClose }: { task: CronTask; onClose: () => void }) {
  const [runs, setRuns] = useState<CronRun[]>([]);

  useEffect(() => {
    const load = () => api.runs(task.id).then((r) => setRuns(r.runs)).catch(() => undefined);
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [task.id]);

  return (
    <Modal title={`Runs — ${task.name}`} onClose={onClose} wide>
      {runs.length === 0 ? <Empty>Aucun run pour l'instant.</Empty> : (
        <table>
          <thead><tr><th>Début</th><th>Fin</th><th>Statut</th><th>Session</th><th>Erreur</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="muted">{new Date(r.started_at).toLocaleString()}</td>
                <td className="muted">{r.finished_at ? new Date(r.finished_at).toLocaleString() : "…"}</td>
                <td><Badge color={statusColor(r.status)}>{r.status}</Badge></td>
                <td className="mono" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{r.session_file ?? "—"}</td>
                <td className="error-text" style={{ margin: 0 }}>{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  toast: (t: string, err?: boolean) => void;
}) {
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

  const save = async () => {
    try {
      if (props.task) await api.updateSchedule(props.task.id, form);
      else await api.createSchedule(form);
      props.onSaved();
    } catch (e) {
      props.toast((e as Error).message, true);
    }
  };

  return (
    <Modal title={props.task ? `Éditer — ${props.task.name}` : "Nouvelle tâche cron"} onClose={props.onClose}>
      <div className="form-row">
        <Field label="Nom"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Expression cron" hint="5 champs : min heure jour mois jour-sem — ex: 0 9 * * 1-5">
          <input value={form.cron_expr} onChange={(e) => setForm({ ...form, cron_expr: e.target.value })} className="mono" />
        </Field>
      </div>
      <Field label="Prompt tiré à l'exécution">
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
            <option value="append_session">Session dédiée (append)</option>
            <option value="new_session">Nouvelle session par run</option>
          </select>
        </Field>
        <Field label="Si run précédent actif">
          <select value={form.busy_policy} onChange={(e) => setForm({ ...form, busy_policy: e.target.value })}>
            <option value="skip">skip</option>
            <option value="queue">queue</option>
            <option value="kill">kill</option>
          </select>
        </Field>
      </div>
      <label style={{ display: "flex", gap: 8, marginBottom: 14, fontSize: 13 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={form.catchup} onChange={(e) => setForm({ ...form, catchup: e.target.checked })} />
        Catchup (1 run de rattrapage si des exécutions ont été manquées)
      </label>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={!form.name.trim() || !form.prompt.trim() || !form.cron_expr.trim()} onClick={() => void save()}>
          Sauvegarder
        </button>
      </div>
    </Modal>
  );
}
