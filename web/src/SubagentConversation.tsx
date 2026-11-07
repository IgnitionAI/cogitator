import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { Markdown } from "./markdown";
import { Modal } from "./ui";
import type { HistoryEntry, SubagentView } from "./types";

export function SubagentConversation({ conversationId, agent, onClose }: { conversationId: string; agent: SubagentView; onClose: () => void }) {
  const [data, setData] = useState<{ subagent: SubagentView; entries: HistoryEntry[]; truncated: boolean } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    setData(null); setError(false); follow.current = true;
    const refresh = async () => {
      try {
        const next = await api.subagentTranscript(conversationId, agent.id, controller.signal);
        if (!controller.signal.aborted) { setData(next); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 3000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [conversationId, agent.id, attempt]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [data]);
  const current = data?.subagent ?? agent;
  return <Modal title={t("subchat.title")} onClose={onClose} wide>
    <div className="subchat-meta"><span className={`chat-state is-${current.status}`} role="status">{t(current.status === "working" ? "chat.subagentWorking" : current.status === "done" ? "chat.subagentDone" : "chat.subagentUnknown")}</span><span className="mono muted">{current.model}</span></div>
    <p className="subchat-mission">{current.label}</p>
    <p className="muted">{t("subchat.readonly")}</p>
    {error && <div role="alert">{t("subchat.error")} <button className="btn btn-sm" onClick={() => setAttempt(n => n + 1)}>{t("chat.retry")}</button></div>}
    {!data && !error && <p role="status">{t("common.loading")}</p>}
    <div ref={scroll} className="subchat-history" role="region" aria-label={t("subchat.history")} tabIndex={0} onScroll={() => {
      const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }}>
      {data?.truncated && <p className="muted">{t("subchat.truncated")}</p>}
      {data && !data.entries.length && <p>{t("subchat.empty")}</p>}
      {data?.entries.map((entry, index) => entry.type === "tool" ? <details key={`${index}-${entry.id}`} className="subchat-tool">
        <summary><strong>{entry.name}</strong><span className="muted">{t(entry.isError ? "subchat.toolError" : entry.result === undefined ? "subchat.toolCall" : "subchat.toolDone")}</span></summary>
        <h4>{t("subchat.arguments")}</h4><pre tabIndex={0}>{entry.args}</pre>
        {entry.result !== undefined && <><h4>{t("subchat.result")}</h4><pre tabIndex={0}>{entry.result}</pre></>}
      </details> : entry.type === "thinking" ? <details key={index} className="subchat-tool"><summary>{t("subchat.thinking")}</summary><Markdown text={entry.text} /></details> : <article key={index} className={`subchat-message is-${entry.type}`}>
        <strong className="muted">{t(entry.type === "user" ? "subchat.instruction" : "subchat.agent")}</strong><Markdown text={entry.text} />
      </article>)}
    </div>
    <div className="subchat-footer"><button type="button" className="btn btn-sm" onClick={() => { follow.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>{t("subchat.latest")}</button><button type="button" className="btn" onClick={onClose}>{t("common.close")}</button></div>
  </Modal>;
}
