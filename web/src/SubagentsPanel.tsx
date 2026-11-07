import { useEffect, useState } from "react";
import { api } from "./api";
import { formatNumber, localizeText, t, type TranslationKey } from "./i18n";
import type { SubagentView } from "./types";
import { Empty } from "./ui";

const STATUS_KEYS: Record<SubagentView["status"], TranslationKey> = {
  working: "chat.subagentWorking",
  done: "chat.subagentDone",
  unknown: "chat.subagentUnknown",
};

export function SubagentsPanel({ conversationId, onCountChange }: {
  conversationId: string;
  onCountChange: (count: number) => void;
}) {
  const [data, setData] = useState<{ live: boolean; subagents: SubagentView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // ADR-013 : une lecture à la fois ; fermer le panneau annule la lecture active.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError(null);
    onCountChange(0);
    const refresh = async () => {
      try {
        const next = await api.conversationSubagents(conversationId, controller.signal);
        if (controller.signal.aborted) return;
        setData(next);
        setError(null);
        onCountChange(next.subagents.length);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 3_000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [conversationId, onCountChange, attempt]);

  return <aside className="chat-side" aria-label={t("chat.subagentsTitle")}>
    <div className="chat-side-head">
      <span>{t("chat.subagents")}</span>
      {data ? <span className="muted">{data.live ? formatNumber(data.subagents.length) : t("chat.subagentsOffline")}</span> : null}
    </div>
    {!data && !error ? <p role="status">{t("common.loading")}</p> : null}
    {error ? <div role="alert">
      <p>{t("chat.subagentsRefreshError")}</p>
      <p className="muted">{localizeText(error)}</p>
      <button type="button" className="btn btn-sm" onClick={() => setAttempt((value) => value + 1)}>{t("chat.retry")}</button>
    </div> : null}
    {data && !data.live ? <p role="status">{t("chat.subagentsUnavailable")}</p> : null}
    {data?.live && data.subagents.length === 0 ? <Empty>{t("chat.noSubagents")}</Empty> : null}
    {data?.live && data.subagents.length > 0 ? <ul className="chat-side-list">
      {data.subagents.map((subagent) => <li key={subagent.id} className="subagent-row">
        <span className="subagent-description">
          <span className="subagent-name">{subagent.label ?? subagent.id}</span>
          {subagent.model ? <span className="muted mono subagent-model">{subagent.model}</span> : null}
        </span>
        <span className={`chat-state is-${subagent.status}`} role="status">{t(STATUS_KEYS[subagent.status])}</span>
      </li>)}
    </ul> : null}
  </aside>;
}
