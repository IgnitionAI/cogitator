import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { ErrorText, Modal } from "./ui";

export function ProjectSetup({ workspaceId, onClose, onOpen }: { workspaceId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [context, setContext] = useState<Awaited<ReturnType<typeof api.setupContext>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true; setContext(null); setError(null);
    api.setupContext(workspaceId).then(c => { if (live) setContext(c); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [revision, workspaceId]);
  async function start() {
    const agent = context?.agents.find(a => a.slug === "majordome");
    if (!context?.ready || !agent || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.createConversation({ workspace_id: workspaceId, agent_id: agent.id, prompt: t("workspace.initPrompt") });
      onOpen(result.conversation.id);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <Modal title={t("setup.title")} onClose={() => { if (!busy) onClose(); }}>
    <ErrorText error={error ?? context?.error ?? null} />
    {!context && !error && <p role="status">{t("setup.checking")}</p>}
    {context && <>
      <p role="status">{t(context.ready ? "setup.ready" : "setup.blocked", { count: context.tools.length })}</p>
      <h3>{t("setup.agents")}</h3>
      <ul>{context.agents.map(a => <li key={a.id}><strong>{a.name}</strong> — {a.description}</li>)}</ul>
      <details><summary>{t("setup.skills")} ({context.skills.length})</summary>
      {context.skills.length ? <ul className="setup-skill-list">{context.skills.map(s => <li key={s.path}><strong>{s.name}</strong> — {s.description}</li>)}</ul> : <p>{t("setup.noSkills")}</p>}</details>
      <p>{t("setup.workflow")}</p>
      {!context.agents.some(a => a.slug === "majordome") && <p role="alert">{t("workspace.majordomoMissing")}</p>}
    </>}
    <div className="toolbar">
      <button className="btn" disabled={busy} onClick={() => setRevision(r => r + 1)}>{t("setup.recheck")}</button>
      <button className="btn btn-primary" disabled={busy || !context?.ready || !context.agents.some(a => a.slug === "majordome")} onClick={() => void start()}>{t(busy ? "setup.starting" : "setup.start")}</button>
    </div>
  </Modal>;
}
