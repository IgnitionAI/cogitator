import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEvents } from "../api";
import type { AgentPreset, Conversation, ProviderView, SseEvent, Workspace } from "../types";
import { Badge, Empty, ErrorText, Field, Modal, statusColor } from "../ui";

interface ChatItem {
  kind: "user" | "assistant" | "tool" | "status";
  text: string;
}

interface RenderMsg {
  role: string;
  text: string;
}

function eventsToItems(events: SseEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  let currentAssistant: ChatItem | null = null;
  let currentTool: ChatItem | null = null;
  for (const e of events) {
    const ame = e.assistantMessageEvent;
    if (e.type === "turn_start") {
      currentAssistant = null;
      currentTool = null;
    }
    if (e.type === "message_update" && ame) {
      if (ame.type === "text_start") {
        currentAssistant = { kind: "assistant", text: "" };
        items.push(currentAssistant);
      } else if (ame.type === "text_delta" && currentAssistant) {
        currentAssistant.text += ame.delta ?? "";
      } else if (ame.type === "text_end" && currentAssistant) {
        currentAssistant.text = ame.content ?? currentAssistant.text;
      } else if (ame.type === "toolcall_start") {
        currentTool = { kind: "tool", text: `⚙ ${ame.toolName ?? "outil"}…` };
        items.push(currentTool);
      } else if (ame.type === "toolcall_end") {
        currentTool = null;
      }
    }
    if (e.type === "agent_end") {
      items.push({ kind: "status", text: "— tour terminé —" });
    }
  }
  return items;
}

function historyToItems(messages: RenderMsg[]): ChatItem[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ kind: m.role as "user" | "assistant", text: m.text }));
}

export default function Conversations({ toast }: { toast: (t: string, err?: boolean) => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.conversations().then((r) => setConversations(r.conversations)).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const open = conversations.find((c) => c.id === openId);

  return (
    <>
      <h2>Conversations</h2>
      <div className="sub">{conversations.length} session(s) · {conversations.filter((c) => c.status === "active").length} active(s)</div>
      <ErrorText error={error} />
      {open ? (
        <ChatView
          key={open.id}
          conversation={open}
          onClose={() => { setOpenId(null); refresh(); }}
          onDeleted={() => { setOpenId(null); refresh(); }}
          toast={toast}
        />
      ) : (
        <>
          <div className="toolbar">
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Nouvelle conversation</button>
          </div>
          {conversations.length === 0 ? (
            <Empty>Aucune conversation — crée-en une avec un agent ou un provider libre.</Empty>
          ) : (
            <div className="cards">
              {conversations.map((c) => (
                <div key={c.id} className="card" onClick={() => setOpenId(c.id)}>
                  <h4>{c.title || "(sans titre)"}</h4>
                  <div className="meta">
                    <span className="mono">{c.provider}/{c.model}{c.thinking ? `:${c.thinking}` : ""}</span>
                    <span>
                      <Badge color={statusColor(c.status)}>{c.status}</Badge>{" "}
                      {c.workspace_dir ? <span className="muted">{c.workspace_dir.split("/").pop()}</span> : <span className="muted">libre</span>}
                    </span>
                  </div>
                  <div className="actions">
                    <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpenId(c.id); }}>Ouvrir</button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm("Fermer cette conversation ? Le .jsonl pi est conservé.")) {
                          api.deleteConversation(c.id).then(refresh).catch((err: Error) => toast(err.message, true));
                        }
                      }}
                    >
                      Suppr.
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {showNew ? <NewConversationModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setOpenId(id); refresh(); }} toast={toast} /> : null}
    </>
  );
}

function ChatView(props: {
  conversation: Conversation;
  onClose: () => void;
  onDeleted: () => void;
  toast: (t: string, err?: boolean) => void;
}) {
  const { conversation } = props;
  const [items, setItems] = useState<ChatItem[]>([]);
  const [liveEvents, setLiveEvents] = useState<SseEvent[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // historique puis SSE
  useEffect(() => {
    api.history(conversation.id).then((r) => setItems(historyToItems(r.messages))).catch(() => undefined);
    const close = openEvents(
      `/api/conversations/${conversation.id}/events`,
      (e) => setLiveEvents((prev) => [...prev, e as SseEvent]),
      () => setClosed(true),
    );
    return close;
  }, [conversation.id]);

  const liveItems = eventsToItems(liveEvents);
  const all = [...items, ...liveItems];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [all.length, all[all.length - 1]?.text.length]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setBusy(true);
    try {
      await api.sendMessage(conversation.id, text);
    } catch (e) {
      props.toast((e as Error).message, true);
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <button className="btn btn-sm" onClick={props.onClose}>← Retour</button>
        <h2>{conversation.title || "(sans titre)"}</h2>
        <span className="muted mono">{conversation.provider}/{conversation.model}</span>
        <Badge color={statusColor(conversation.status)}>{conversation.status}</Badge>
        <div style={{ flex: 1 }} />
        {busy ? (
          <button className="btn btn-sm btn-danger" onClick={() => api.stopConversation(conversation.id).catch(() => undefined)}>■ Stop</button>
        ) : null}
        <button
          className="btn btn-sm btn-danger"
          onClick={() => {
            if (confirm("Supprimer cette conversation ?")) {
              api.deleteConversation(conversation.id).then(props.onDeleted).catch((e: Error) => props.toast(e.message, true));
            }
          }}
        >
          Suppr.
        </button>
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {all.length === 0 ? <Empty>{closed ? "Session non démarrée — envoie un message." : "En attente d'événements…"}</Empty> : null}
        {all.map((m, i) =>
          m.kind === "status" ? (
            <div key={i} className="msg-status">{m.text}</div>
          ) : m.kind === "tool" ? (
            <div key={i} className="msg msg-tool">{m.text}</div>
          ) : (
            <div key={i} className={`msg msg-${m.kind}`}>{m.text}</div>
          ),
        )}
      </div>
      <div className="chat-input">
        <textarea
          ref={taRef}
          value={input}
          placeholder="Message… (Entrée = envoyer, Maj+Entrée = nouvelle ligne)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary" onClick={() => void send()} disabled={busy || !input.trim()}>
          Envoyer
        </button>
      </div>
    </div>
  );
}

function NewConversationModal(props: {
  onClose: () => void;
  onCreated: (id: string) => void;
  toast: (t: string, err?: boolean) => void;
}) {
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [mode, setMode] = useState<"agent" | "free">("agent");
  const [agentId, setAgentId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.agents().then((r) => {
      setAgents(r.agents as AgentPreset[]);
      if (r.agents[0]) setAgentId(r.agents[0].id);
    }).catch(() => undefined);
    api.providers().then((r) => {
      setProviders(r.providers);
      if (r.providers[0]) setProviderId(r.providers[0].id);
    }).catch(() => undefined);
    api.workspaces().then((r) => setWorkspaces(r.workspaces)).catch(() => undefined);
  }, []);

  const provider = providers.find((p) => p.id === providerId);
  const models = provider?.models ?? [];

  const create = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        workspace_id: workspaceId || undefined,
        prompt: prompt.trim() || undefined,
      };
      if (mode === "agent") body.agent_id = agentId;
      else {
        body.provider = providerId;
        body.model = model || models[0]?.id || "";
        if (thinking) body.thinking = thinking;
      }
      const r = await api.createConversation(body);
      props.onCreated(r.conversation.id);
    } catch (e) {
      props.toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Nouvelle conversation" onClose={props.onClose}>
      <Field label="Mode">
        <select value={mode} onChange={(e) => setMode(e.target.value as "agent" | "free")}>
          <option value="agent">Agent (preset)</option>
          <option value="free">Provider libre</option>
        </select>
      </Field>
      {mode === "agent" ? (
        <Field label="Agent">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      ) : (
        <div className="form-row">
          <Field label="Provider">
            <select value={providerId} onChange={(e) => { setProviderId(e.target.value); setModel(""); }}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.id} {p.auth.ready ? "✓" : "⚠"}</option>)}
            </select>
          </Field>
          <Field label="Modèle">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">(défaut)</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </Field>
          {mode === "free" ? (
            <Field label="Thinking (optionnel)">
              <select value={thinking} onChange={(e) => setThinking(e.target.value)}>
                <option value="">(défaut)</option>
                {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          ) : null}
        </div>
      )}
      <Field label="Workspace (optionnel)">
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">— libre —</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </Field>
      <Field label="Prompt initial (optionnel)">
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Premier message…" />
      </Field>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void create()} disabled={busy}>
          {busy ? "Création…" : "Créer"}
        </button>
      </div>
    </Modal>
  );
}
