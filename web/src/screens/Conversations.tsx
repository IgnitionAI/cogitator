import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEvents } from "../api";
import type {
  AgentPreset, Conversation, FileChange, HistoryEntry, ImageContentInput, ProviderView, SkillRef, SseEvent, Workspace,
} from "../types";
import { Badge, Empty, ErrorText, Field, IconBtn, Modal, PageHead, Skeleton, Spinner, statusColor } from "../ui";
import { FileDiffModal, FileRow } from "../FileViews";
import { Markdown } from "../markdown";
import { Icon } from "../icons";


type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "skill"; name: string; text: string; rest?: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; text: string; args?: string; result?: string; isError?: boolean; state: "running" | "done" }
  | { kind: "status"; text: string };

interface StreamState {
  assistantIndex: number | null;
  streaming: boolean;
  /** contentIndex pi → index dans la timeline (pour toolcall_end) */
  toolByContent: Record<number, number>;
  /** nombre d'assistants déjà pourvus d'un bloc thinking (anti double-insertion) */
  thinkingInserted: number;
}

function patchAt(prev: ChatItem[], index: number, patch: Partial<ChatItem>): ChatItem[] {
  const next = [...prev];
  const target = next[index];
  if (target) next[index] = { ...target, ...patch } as ChatItem;
  return next;
}

/** Applique UN événement SSE à la timeline (pi n'émet pas d'événement user : l'UI fait l'écho local). */
function applyEvent(prev: ChatItem[], ev: SseEvent, st: StreamState): ChatItem[] {
  const ame = ev.assistantMessageEvent;
  switch (ev.type) {
    case "turn_start":
      st.assistantIndex = null;
      st.toolByContent = {}; // contentIndex est par message : on évite les collisions entre tours
      return prev;
    case "message_update": {
      if (!ame) return prev;
      switch (ame.type) {
        case "text_start":
          st.assistantIndex = prev.length;
          st.streaming = true;
          return [...prev, { kind: "assistant", text: "" }];
        case "text_delta":
          if (st.assistantIndex === null) return prev;
          return patchAt(prev, st.assistantIndex, { text: (prev[st.assistantIndex]?.text ?? "") + (ame.delta ?? "") });
        case "text_end":
          if (st.assistantIndex === null || !ame.content) return prev;
          return patchAt(prev, st.assistantIndex, { text: ame.content });
        case "toolcall_start": {
          const index = prev.length;
          if (ame.contentIndex !== undefined) st.toolByContent[ame.contentIndex] = index;
          return [...prev, { kind: "tool", text: ame.toolName ?? "outil", state: "running" }];
        }
        case "toolcall_end": {
          const index = ame.contentIndex !== undefined ? st.toolByContent[ame.contentIndex] : undefined;
          return index !== undefined ? patchAt(prev, index, { state: "done" }) : prev;
        }
        default:
          return prev;
      }
    }
    case "agent_end": {
      st.assistantIndex = null;
      st.streaming = false;
      // purge des bulles assistant restées vides (messages à toolcalls seuls, text_start sans texte)
      const cleaned = prev.filter((p) => p.kind !== "assistant" || p.text.trim() !== "");
      return [...cleaned, { kind: "status", text: "— tour terminé —" }];
    }
    default:
      return prev;
  }
}

/** Découpe un message user expandé par pi (`<skill name=…>…</skill>` + consigne restante). */
function parseSkillMessage(text: string): { name: string; body: string; rest: string } | null {
  const m = text.match(/^<skill\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/skill>\s*([\s\S]*)$/);
  if (!m) return null;
  return { name: m[1]!, body: (m[2] ?? "").trim(), rest: (m[3] ?? "").trim() };
}

/** Construit la timeline depuis les entrées structurées du .jsonl (montage). */
function entriesToItems(entries: HistoryEntry[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const e of entries) {
    if (e.type === "user") {
      const skill = parseSkillMessage(e.text);
      if (skill) {
        items.push({ kind: "skill", name: skill.name, text: skill.body, rest: skill.rest });
      } else {
        items.push({ kind: "user", text: e.text });
      }
    }
    else if (e.type === "assistant") items.push({ kind: "assistant", text: e.text });
    else if (e.type === "thinking") items.push({ kind: "thinking", text: e.text });
    else items.push({ kind: "tool", text: e.name, args: e.args, result: e.result, isError: e.isError, state: "done" });
  }
  return items;
}

/**
 * Réconcilie la timeline live avec les entrées du .jsonl après un tour :
 * injecte le raisonnement (thinking) et le détail args/résultat des outils.
 * L'appariement est ordinal (nième tool, nième thinking) — suffisant car les deux
 * sources suivent le même ordre chronologique. `st.thinkingInserted` évite les
 * double-insertions lors des tours suivants.
 */
function reconcile(prev: ChatItem[], entries: HistoryEntry[], st: StreamState): ChatItem[] {
  const tools = entries.filter((e): e is Extract<HistoryEntry, { type: "tool" }> => e.type === "tool");
  const thinkings = entries.filter((e): e is Extract<HistoryEntry, { type: "thinking" }> => e.type === "thinking");
  const out: ChatItem[] = [];
  let ti = 0;
  let thi = 0;
  let assistantOrdinal = 0;
  for (const item of prev) {
    if (item.kind === "assistant") {
      assistantOrdinal += 1;
      if (assistantOrdinal > st.thinkingInserted && thi < thinkings.length) {
        out.push({ kind: "thinking", text: thinkings[thi]!.text });
        thi += 1;
        st.thinkingInserted = assistantOrdinal;
      }
    }
    if (item.kind === "tool" && ti < tools.length) {
      const t = tools[ti]!;
      ti += 1;
      if (item.args === undefined || item.result === undefined) {
        out.push({ ...item, text: t.name, args: t.args, result: t.result, isError: t.isError, state: "done" });
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

export default function Conversations({ toast, initialOpenId, onConsumeInitial }: {
  toast: (t: string, err?: boolean) => void;
  initialOpenId?: string | null;
  onConsumeInitial?: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);

  useEffect(() => {
    if (initialOpenId) {
      setOpenId(initialOpenId);
      onConsumeInitial?.();
    }
  }, [initialOpenId, onConsumeInitial]);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(() => {
    api.conversations().then((r) => setConversations(r.conversations)).catch((e: Error) => setError(e.message)).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const open = conversations.find((c) => c.id === openId);

  if (open) {
    return (
      <>
        <ChatView
          key={open.id}
          conversation={open}
          onClose={() => { setOpenId(null); refresh(); }}
          onDeleted={() => { setOpenId(null); refresh(); }}
          toast={toast}
        />
        {showNew ? <NewConversationModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setOpenId(id); refresh(); }} toast={toast} /> : null}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Conversations"
        sub={`${conversations.length} session${conversations.length === 1 ? "" : "s"} · ${conversations.filter((c) => c.status === "active").length} active${conversations.filter((c) => c.status === "active").length === 1 ? "" : "s"}`}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
            <Icon name="plus" /> Nouvelle conversation
          </button>
        }
      />
      <ErrorText error={error} />
      {!ready ? (
        <Skeleton />
      ) : conversations.length === 0 ? (
        <Empty
          title="Aucune conversation"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
              <Icon name="plus" /> Nouvelle conversation
            </button>
          }
        >
          Crée-en une avec un agent, ou en provider libre.
        </Empty>
      ) : (
        <div className="list">
          {conversations.map((c) => (
            <div key={c.id} className="list-row">
              <button type="button" className="list-main" onClick={() => setOpenId(c.id)}>
                <span className="list-title">{c.title || "Sans titre"}</span>
                <span className="list-meta">
                  <span className="mono">{c.provider}/{c.model}{c.thinking ? `:${c.thinking}` : ""}</span>
                  <span>{c.workspace_dir ? c.workspace_dir.split("/").pop() : "libre"}</span>
                </span>
              </button>
              <Badge color={statusColor(c.status)}>{c.status}</Badge>
              <IconBtn
                name="trash"
                label="Fermer la conversation"
                danger
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm("Fermer cette conversation ? Le fichier .jsonl pi est conservé.")) {
                    api.deleteConversation(c.id).then(refresh).catch((err: Error) => toast(err.message, true));
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
      {showNew ? <NewConversationModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setOpenId(id); refresh(); }} toast={toast} /> : null}
    </>
  );
}

export function ChatView(props: {
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
  const streamRef = useRef<StreamState>({ assistantIndex: null, streaming: false, toolByContent: {}, thinkingInserted: 0 });
  const [streaming, setStreaming] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [openThinking, setOpenThinking] = useState<Set<number>>(new Set());
  const [filesPanel, setFilesPanel] = useState(false);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [diffFor, setDiffFor] = useState<{ path: string } | null>(null);

  const refreshFiles = useCallback(() => {
    api.conversationFiles(conversation.id).then((r) => setFiles(r.files)).catch(() => undefined);
  }, [conversation.id]);

  const toggle = (set: Set<number>, setter: (s: Set<number>) => void, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setter(next);
  };

  const loadHistory = useCallback((replaceIfEmpty: boolean) => {
    api.history(conversation.id).then((r) => {
      if (replaceIfEmpty) {
        setTimeline((prev) => {
          if (prev.length > 0) return prev;
          streamRef.current.thinkingInserted = r.entries.filter((e) => e.type === "assistant").length;
          return entriesToItems(r.entries);
        });
      } else {
        setTimeline((prev) => reconcile(prev, r.entries, streamRef.current));
      }
    }).catch(() => undefined);
    refreshFiles();
  }, [conversation.id, refreshFiles]);

  // historique puis SSE + liste des skills (invocables via /skill:name, expandé par pi)
  useEffect(() => {
    loadHistory(true);
    // l'historique peut ne pas être flushé au montage (prompt initial) : on re-tente une fois
    const refetch = setTimeout(() => loadHistory(true), 3000);
    api.skills().then((r) => {
      const seen = new Set<string>();
      setSkills(r.skills.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true))));
    }).catch(() => undefined);
    const close = openEvents(
      `/api/conversations/${conversation.id}/events`,
      (e) => {
        const ev = e as SseEvent;
        setTimeline((prev) => applyEvent(prev, ev, streamRef.current));
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_start") setStreaming(true);
        if (ev.type === "agent_end") {
          setStreaming(false);
          loadHistory(false); // réconcilie : thinking + args/résultats des outils du tour
        }
      },
      {
        // à chaque (re)connexion : combler le trou d'événements via l'historique
        onOpen: () => loadHistory(false),
        onClose: () => setClosed(true),
      },
    );
    return () => {
      clearTimeout(refetch);
      close();
    };
  }, [conversation.id, loadHistory]);

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
        <button type="button" className="btn btn-sm" onClick={props.onClose}>
          <Icon name="back" /> Retour
        </button>
        <h1>{conversation.title || "Sans titre"}</h1>
        <span className="muted mono">{conversation.provider}/{conversation.model}</span>
        <Badge color={statusColor(conversation.status)}>{conversation.status}</Badge>
        <button
          type="button"
          className={`btn btn-sm ${filesPanel ? "btn-primary" : ""}`}
          onClick={() => { setFilesPanel((v) => !v); refreshFiles(); }}
          aria-pressed={filesPanel}
          title="Fichiers modifiés dans cette conversation"
        >
          <Icon name="files" /> Fichiers{files.length > 0 ? ` (${files.length})` : ""}
        </button>
        <div style={{ flex: 1 }} />
        {busy ? (
          <button type="button" className="btn btn-sm btn-danger" onClick={() => api.stopConversation(conversation.id).catch(() => undefined)}>
            <Icon name="stop" /> Stop
          </button>
        ) : null}
        <IconBtn
          name="trash"
          label="Supprimer la conversation"
          danger
          onClick={() => {
            if (confirm("Supprimer cette conversation ?")) {
              api.deleteConversation(conversation.id).then(props.onDeleted).catch((e: Error) => props.toast(e.message, true));
            }
          }}
        />
      </div>
      <div className="chat-body">
      <div className="chat-main">
      <div className="chat-scroll" ref={scrollRef}>
        {timeline.length === 0 ? (
        <Empty title={closed ? "Session prête" : "En attente d'événements"}>
          Envoie un message. Le menu Skills charge un skill, ou tape <code>/skill:nom</code>.
        </Empty>
      ) : null}
        {timeline.map((m, i) => {
          if (m.kind === "status") return <div key={i} className="msg-status">{m.text}</div>;
          if (m.kind === "skill") {
            return (
              <div key={i} className="skill-card">
                <button type="button" className="skill-head" onClick={() => toggle(expanded, setExpanded, i)}>
                  <span className="skill-pill"><Icon name="spark" size={14} /></span>
                  <span className="skill-name">{m.name}</span>
                  <span className="tool-meta">{m.text.length.toLocaleString()} caractères</span>
                  <span className={`chevron ${expanded.has(i) ? "open" : ""}`}>▸</span>
                </button>
                {expanded.has(i) ? <div className="skill-body"><Markdown text={m.text} /></div> : null}
                {m.rest ? <div className="msg msg-user skill-rest">{m.rest}</div> : null}
              </div>
            );
          }
          if (m.kind === "thinking") {
            return (
              <div key={i} className="msg-thinking">
                <button type="button" className="thinking-head" onClick={() => toggle(openThinking, setOpenThinking, i)}>
                  <span className={`chevron ${openThinking.has(i) ? "open" : ""}`}>▸</span>
                  Réflexion · {m.text.length.toLocaleString()} caractères
                </button>
                {openThinking.has(i) ? <div className="thinking-body">{m.text}</div> : null}
              </div>
            );
          }
          if (m.kind === "tool") {
            return (
              <div key={i} className={`tool-chip ${m.state} ${m.isError ? "error" : ""}`}>
                <button type="button" className="tool-head" onClick={() => toggle(expanded, setExpanded, i)}>
                  <span className={`tool-dot ${m.state}`} />
                  <span className="tool-name">{m.text}</span>
                  {m.result !== undefined ? (
                    <span className="tool-meta">{m.isError ? "erreur" : "ok"}</span>
                  ) : m.state === "done" ? null : (
                    <span className="tool-meta">en cours…</span>
                  )}
                  <span className={`chevron ${expanded.has(i) ? "open" : ""}`}>▸</span>
                </button>
                {expanded.has(i) ? (
                  <div className="tool-detail">
                    <div className="tool-label">Arguments</div>
                    <pre>{m.args ?? "(disponible à la fin du tour)"}</pre>
                    {m.result !== undefined ? (
                      <>
                        <div className="tool-label">Résultat</div>
                        <pre className={m.isError ? "error" : ""}>{m.result}</pre>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          }
          const isLastAssistant = m.kind === "assistant" && i === timeline.length - 1;
          return (
            <div key={i} className={`msg msg-${m.kind}`}>
              <Markdown text={m.text} />
              {isLastAssistant && streaming ? <span className="caret" /> : null}
            </div>
          );
        })}
        {images.length > 0 ? (
          <div className="msg msg-user thumbs">
            {images.map((img, i) => (
              <span key={i} className="thumb">
                <img src={`data:${img.mimeType};base64,${img.data}`} alt={`Pièce jointe ${i + 1}`} />
                <IconBtn name="close" label={`Retirer l'image ${i + 1}`} onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} />
              </span>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>{images.length} image(s) à envoyer</span>
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
        <IconBtn name="paperclip" label="Joindre une image" onClick={() => fileRef.current?.click()} />
        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            setInput((v) => `/skill:${e.target.value} ${v}`.trimEnd() + " ");
            taRef.current?.focus();
          }}
          title="Charger un skill (/skill:name, expandé par pi dans la session)"
          aria-label="Charger un skill"
          style={{ width: 150, flexShrink: 0 }}
        >
          <option value="">Skills…</option>
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
        <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={busy || (!input.trim() && images.length === 0)}>
          {busy ? <Spinner /> : <Icon name="send" />} Envoyer
        </button>
      </div>
      </div>
      {filesPanel ? (
        <aside className="chat-side">
          <div className="chat-side-head">
            <span>Fichiers modifiés</span>
            <span className="muted">{files.length}</span>
          </div>
          {files.length === 0 ? (
            <Empty>Aucun fichier modifié pour l'instant.</Empty>
          ) : (
            <div className="chat-side-list">
              {files.map((f) => (
                <FileRow key={f.path} f={f} onClick={() => setDiffFor({ path: f.path })} />
              ))}
            </div>
          )}
        </aside>
      ) : null}
      </div>
      {diffFor ? (
        <FileDiffModal conversationId={conversation.id} path={diffFor.path} onClose={() => setDiffFor(null)} />
      ) : null}
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
        <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy}>
          {busy ? <><Spinner /> Création…</> : "Créer"}
        </button>
      </div>
    </Modal>
  );
}
