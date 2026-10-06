import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEvents } from "../api";
import type {
  AgentPreset, Conversation, ImageContentInput, ProviderView, SkillRef, SseEvent, Workspace,
} from "../types";
import { Badge, Empty, ErrorText, Field, Modal, statusColor } from "../ui";

interface ChatItem {
  kind: "user" | "assistant" | "tool" | "status";
  text: string;
}

interface RenderMsg {
  role: string;
  text: string;
}

interface StreamState {
  assistantIndex: number | null; // index dans la timeline du message assistant en cours de stream
}

/** Applique UN événement SSE à la timeline (pi n'émet pas d'événement user : l'UI fait l'écho local). */
function applyEvent(prev: ChatItem[], ev: SseEvent, st: StreamState): ChatItem[] {
  const ame = ev.assistantMessageEvent;
  switch (ev.type) {
    case "turn_start":
      st.assistantIndex = null;
      return prev;
    case "message_update": {
      if (!ame) return prev;
      if (ame.type === "text_start") {
        st.assistantIndex = prev.length;
        return [...prev, { kind: "assistant", text: "" }];
      }
      if (ame.type === "text_delta" && st.assistantIndex !== null) {
        const next = [...prev];
        const target = next[st.assistantIndex];
        if (target) next[st.assistantIndex] = { ...target, text: target.text + (ame.delta ?? "") };
        return next;
      }
      if (ame.type === "text_end" && st.assistantIndex !== null) {
        const next = [...prev];
        const target = next[st.assistantIndex];
        if (target && ame.content) next[st.assistantIndex] = { ...target, text: ame.content };
        return next;
      }
      if (ame.type === "toolcall_start") {
        return [...prev, { kind: "tool", text: `⚙ ${ame.toolName ?? "outil"}…` }];
      }
      return prev;
    }
    case "agent_end":
      st.assistantIndex = null;
      return [...prev, { kind: "status", text: "— tour terminé —" }];
    default:
      return prev;
  }
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
  const [timeline, setTimeline] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageContentInput[]>([]);
  const [skills, setSkills] = useState<SkillRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<StreamState>({ assistantIndex: null });

  // historique puis SSE + liste des skills (invocables via /skill:name, expandé par pi)
  useEffect(() => {
    api.history(conversation.id).then((r) => setTimeline(historyToItems(r.messages))).catch(() => undefined);
    // l'historique peut ne pas être flushé au montage (prompt initial) : on re-tente une fois
    const refetch = setTimeout(() => {
      api.history(conversation.id).then((r) => {
        if (r.messages.length > 0) setTimeline((prev) => (prev.length === 0 ? historyToItems(r.messages) : prev));
      }).catch(() => undefined);
    }, 3000);
    api.skills().then((r) => {
      const seen = new Set<string>();
      setSkills(r.skills.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true))));
    }).catch(() => undefined);
    const close = openEvents(
      `/api/conversations/${conversation.id}/events`,
      (e) => setTimeline((prev) => applyEvent(prev, e as SseEvent, streamRef.current)),
      () => setClosed(true),
    );
    return () => {
      clearTimeout(refetch);
      close();
    };
  }, [conversation.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [timeline.length, timeline[timeline.length - 1]?.text.length]);

  const send = async () => {
    const text = input.trim();
    if (!text && images.length === 0) return;
    const toSend = images;
    setInput("");
    setImages([]);
    setBusy(true);
    try {
      await api.sendMessage(conversation.id, text, toSend.length ? toSend : undefined);
      // écho local : le flux SSE de pi ne contient pas les messages utilisateur
      setTimeline((prev) => [...prev, { kind: "user", text: text || "🖼 image(s) jointe(s)" }]);
    } catch (e) {
      props.toast((e as Error).message, true);
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  };

  const addFiles = (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.split(",")[1] ?? "";
        if (base64) setImages((prev) => [...prev, { type: "image" as const, data: base64, mimeType: file.type }]);
      };
      reader.readAsDataURL(file);
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
        {timeline.length === 0 ? (
        <Empty>
          {closed ? "Session prête — envoie un message." : "En attente d'événements…"}
          <div style={{ marginTop: 6, fontSize: 12 }}>Astuce : le menu 🧩 charge un skill, ou tape <code>/skill:nom</code> directement.</div>
        </Empty>
      ) : null}
        {timeline.map((m, i) =>
          m.kind === "status" ? (
            <div key={i} className="msg-status">{m.text}</div>
          ) : m.kind === "tool" ? (
            <div key={i} className="msg msg-tool">{m.text}</div>
          ) : (
            <div key={i} className={`msg msg-${m.kind}`}>{m.text}</div>
          ),
        )}
        {images.length > 0 ? (
          <div className="msg msg-user" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {images.map((img, i) => (
              <span key={i} style={{ position: "relative" }}>
                <img src={`data:${img.mimeType};base64,${img.data}`} style={{ maxWidth: 120, maxHeight: 120, borderRadius: 6 }} />
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ position: "absolute", top: -8, right: -8, background: "var(--bg-3)", borderRadius: "50%" }}
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </span>
            ))}
            <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>{images.length} image(s) à envoyer</span>
          </div>
        ) : null}
      </div>
      <div className="chat-input">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button className="btn" onClick={() => fileRef.current?.click()} title="Joindre une image">📎</button>
        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            setInput((v) => `/skill:${e.target.value} ${v}`.trimEnd() + " ");
            taRef.current?.focus();
          }}
          title="Charger un skill (/skill:name — expandé par pi dans la session)"
          style={{ width: 150, flexShrink: 0 }}
        >
          <option value="">🧩 Skills…</option>
          {skills.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
        <textarea
          ref={taRef}
          value={input}
          placeholder="Message… (Entrée = envoyer, Maj+Entrée = nouvelle ligne, collage d'image accepté)"
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary" onClick={() => void send()} disabled={busy || (!input.trim() && images.length === 0)}>
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
