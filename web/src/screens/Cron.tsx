import { t as translate, localizeText, formatDate, statusLabel } from "../i18n";
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
        title={translate("screens.cron")}
        sub={translate("screens.cronSub")}
        actions={<button type="button" className="btn btn-primary" disabled={loading || !!error} onClick={() => setEditing("new")}><Icon name="plus" /> {translate("screens.newTask")}</button>}
      />
      <p className="muted">{translate("screens.timezone", { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</p>
      <ErrorText error={error ? localizeText(error) : null} />
      {error ? <button type="button" className="btn" onClick={refresh}>{translate("screens.retry")}</button> : null}
      {loading ? <p role="status">{translate("screens.loading")}</p> : error && tasks.length === 0 ? null : tasks.length === 0 ? (
        <Empty title={translate("screens.noTasks")} action={<button type="button" className="btn btn-primary" disabled={loading || !!error} onClick={() => setEditing("new")}><Icon name="plus" /> {translate("screens.newTask")}</button>}>
          {translate("screens.cronEmpty")}
        </Empty>
      ) : (
        <div className="table-wrap" data-scroll-hint={translate("common.scrollColumns")} role="region" aria-label={translate("screens.scheduledTasks")} tabIndex={0}>
        <table>
          <thead>
            <tr><th>{translate("screens.name")}</th><th>{translate("screens.expression")}</th><th>{translate("screens.agent")}</th><th>{translate("screens.nextRun")}</th><th>{translate("screens.lastRun")}</th><th>{translate("screens.enabled")}</th><th scope="col">{translate("screens.actions")}</th></tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="mono">{t.cron_expr}</td>
                <td className="mono">{agents.find((a) => a.id === t.agent_id)?.name ?? "—"}</td>
                <td className="muted">{t.next_run_at ? formatDate(t.next_run_at) : "—"}</td>
                <td className="muted">{t.last_run_at ? formatDate(t.last_run_at) : translate("screens.never")}</td>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    disabled={pendingTask === t.id}
                    aria-label={translate("screens.enableTask", { name: t.name })}
                    checked={t.enabled === 1}
                    onChange={(e) => { if (pendingTask === t.id) return; setPendingTask(t.id); api.updateSchedule(t.id, { enabled: e.target.checked }).then(refresh).catch((err: Error) => toast(localizeText(err.message), true)).finally(() => setPendingTask(null)); }}
                  />
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm" onClick={() => setRunsFor(t.id)}>{translate("screens.history")}</button>{" "}
                  <button className="btn btn-sm" onClick={() => setEditing(t)}>{translate("screens.edit")}</button>{" "}
                  <IconBtn name="play" label={translate("screens.runNow", { name: t.name })} onClick={() => api.fireSchedule(t.id).then(() => toast(translate("screens.runStarted", { name: t.name }))).catch((e: Error) => toast(localizeText(e.message), true))} />
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => { if (confirm(translate("screens.deleteTask", { name: t.name }))) api.deleteSchedule(t.id).then(refresh).catch((e: Error) => toast(localizeText(e.message), true)); }}
                  >
                    {translate("screens.delete")}
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
    <Modal title={translate("screens.runsFor", { name: task.name })} onClose={onClose} wide>
      <ErrorText error={error ? localizeText(error) : null} />
      {error ? <button type="button" className="btn" onClick={load}>{translate("screens.retry")}</button> : null}
      {loading ? <p role="status">{translate("screens.loadingRuns")}</p> : error && runs.length === 0 ? null : runs.length === 0 ? <Empty>{translate("screens.noRuns")}</Empty> : (
        <div className="table-wrap" data-scroll-hint={translate("common.scrollColumns")} role="region" aria-label={translate("screens.runHistory")} tabIndex={0}><table>
          <thead><tr><th>{translate("screens.start")}</th><th>{translate("screens.end")}</th><th>{translate("screens.status")}</th><th>{translate("screens.session")}</th><th>{translate("screens.error")}</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="muted">{formatDate(r.started_at)}</td>
                <td className="muted">{r.finished_at ? formatDate(r.finished_at) : "…"}</td>
                <td><Badge color={statusColor(r.status)}>{statusLabel(r.status)}</Badge></td>
                <td className="mono" title={r.session_file ?? undefined} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{r.session_file ?? "—"}</td>
                <td className="error-text" style={{ margin: 0 }}>{r.error ? localizeText(r.error) : null}</td>
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
      setActionError(e instanceof Error ? e.message : translate("screens.operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={props.task ? translate("screens.editNamed", { name: props.task.name }) : translate("screens.newCron")} onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError ? localizeText(actionError) : null} />
      {props.agents.length === 0 || props.workspaces.length === 0 ? <p role="status" className="muted">{translate("screens.cronPrerequisites")}</p> : null}
      <div className="form-row">
        <Field label={translate("screens.name")}><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={translate("screens.cronExpression")} hint={translate("screens.cronHint")}>
          <input value={form.cron_expr} onChange={(e) => setForm({ ...form, cron_expr: e.target.value })} className="mono" />
        </Field>
      </div>
      <Field label={translate("screens.executionPrompt")}>
        <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
      </Field>
      <div className="form-row">
        <Field label={translate("screens.agent")}>
          <select value={form.agent_id} onChange={(e) => setForm({ ...form, agent_id: e.target.value })}>
            {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label={translate("screens.workspace")}>
          <select value={form.workspace_id} onChange={(e) => setForm({ ...form, workspace_id: e.target.value })}>
            {props.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label={translate("screens.output")}>
          <select value={form.output_policy} onChange={(e) => setForm({ ...form, output_policy: e.target.value })}>
            <option value="append_session">{translate("screens.reuseSession")}</option>
            <option value="new_session">{translate("screens.newSession")}</option>
          </select>
        </Field>
        <Field label={translate("screens.ifRunning")}>
          <select value={form.busy_policy} onChange={(e) => setForm({ ...form, busy_policy: e.target.value })}>
            <option value="skip">{translate("screens.skipRun")}</option>
            <option value="queue">{translate("screens.queueRun")}</option>
            <option value="kill">{translate("screens.killRun")}</option>
          </select>
        </Field>
      </div>
      <label style={{ display: "flex", gap: 8, marginBottom: 14, fontSize: 13 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={form.catchup} onChange={(e) => setForm({ ...form, catchup: e.target.checked })} />
        {translate("screens.catchup")}
      </label>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={busy || !form.agent_id || !form.workspace_id || !form.name.trim() || !form.prompt.trim() || !form.cron_expr.trim()} onClick={() => void save()}>
          {busy ? translate("screens.saving") : translate("screens.saveTask")}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>{translate("screens.cancel")}</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">{translate("screens.pending")}</p> : null}
    </Modal>
  );
}
