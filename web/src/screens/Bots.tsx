import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentPreset, Conversation } from "../types";
import { Empty, ErrorText, PageHead, Skeleton, useToast } from "../ui";
import { Icon } from "../icons";
import { localizeText, t } from "../i18n";
import { ChatView } from "./Conversations";

export default function Bots() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(() => {
    api.agents().then((r) => { setAgents(r.agents); setError(null); }).catch((e: Error) => setError(e.message)).finally(() => setReady(true));
  }, []);

  useEffect(load, [load]);

  async function openBot(agent: AgentPreset) {
    try {
      const listed = await api.conversations(undefined, agent.id);
      const last = listed.conversations[0];
      if (last) {
        setOpen(last);
        return;
      }
      const created = await api.createConversation({ agent_id: agent.id });
      setOpen(created.conversation);
    } catch (e: unknown) {
      toast(localizeText(e instanceof Error ? e.message : String(e)), true);
    }
  }

  const autoOpened = useRef(false);
  useEffect(() => {
    if (!ready || autoOpened.current || agents.length === 0) return;
    autoOpened.current = true;
    const home = agents.find((a) => a.is_default) ?? agents[0];
    if (home) void openBot(home);
  }, [ready, agents]);

  if (open) {
    return (
      <ChatView
        key={open.id}
        conversation={open}
        onClose={() => setOpen(null)}
        onDeleted={() => { setOpen(null); load(); }}
      />
    );
  }

  return (
    <>
      <PageHead title={t("screens.bots")} sub={t("screens.botsSub")} />
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={load}>{t("screens.retry")}</button> : null}
      {!ready ? <Skeleton /> : error && agents.length === 0 ? null : agents.length === 0 ? (
        <Empty title={t("screens.noBots")}>{t("screens.botEmpty")}</Empty>
      ) : (
        <div className="list">
          {agents.map((a) => (
            <div key={a.id} className="list-row">
              <button type="button" className="list-main" onClick={() => void openBot(a)}>
                <span className="list-title">{a.name}</span>
                <span className="list-meta">{a.description || `${a.provider}/${a.model}`}</span>
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void openBot(a)}>
                <Icon name="chat" /> {t("screens.talk")}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
