import { t, formatNumber, statusLabel, thinkingLabel, localizeText } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEvents, type EventConnectionState } from "../api";
import { THINKING_LEVELS } from "../types";
import type {
  AgentPreset, Conversation, FileChange, HistoryEntry, ImageContentInput, ProviderView, SkillRef, SseEvent, Workspace,
 } from "../types";
import { Badge, Empty, ErrorText, Field, IconBtn, Modal, PageHead, Skeleton, Spinner, statusColor, useToast } from "../ui";
import { FileDiffModal, FileRow } from "../FileViews";
import { Markdown } from "../markdown";
import { Icon } from "../icons";
import { ToolResult } from "../ToolResult";
import { AssistantContent, UserContent } from "../ChatMessage";
import { parseUIResponse, uiRequestKey, type UIResponse } from "../../../src/generative-ui";


let nextChatItemKey = 0;
type ChatItem = (
  | { kind: "user"; text: string; attachmentCount?: number }
  | { kind: "skill"; name: string; text: string; rest?: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id?: string; text: string; args?: string; result?: string; isError?: boolean; state: "running" | "done" }
  | { kind: "status"; text: string }
) & { key?: number };

interface StreamState {
  assistantIndex: number | null;
  streaming: boolean;
  /** contentIndex pi → index dans la timeline (pour toolcall_end) */
  toolByContent: Record<number, number>;
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
          return [...prev, { kind: "tool", id: ame.id, text: ame.toolName ?? "", state: "running" }];
        }
        case "toolcall_end": {
          const index = ame.contentIndex !== undefined ? st.toolByContent[ame.contentIndex] : undefined;
          // La génération des arguments est terminée, pas l’exécution de l’outil.
          return index !== undefined && ame.toolCall ? patchAt(prev, index, {
            id: ame.toolCall.id, text: ame.toolCall.name, args: JSON.stringify(ame.toolCall.arguments, null, 2),
          }) : prev;
        }
        default:
          return prev;
      }
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      if (!ev.toolCallId) return prev;
      const index = prev.findIndex((item) => item.kind === "tool" && item.id === ev.toolCallId);
      const result = ev.type === "tool_execution_end" ? ev.result : ev.partialResult;
      const text = result?.content?.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
      const patch = {
        ...(ev.args !== undefined ? { args: JSON.stringify(ev.args, null, 2) } : {}),
        ...(text !== undefined ? { result: text } : {}),
        ...(ev.type === "tool_execution_end" ? { state: "done" as const, isError: ev.isError === true } : {}),
      };
      return index >= 0 ? patchAt(prev, index, patch) : [...prev, {
        kind: "tool", id: ev.toolCallId, text: ev.toolName ?? "", state: "running", ...patch,
      }];
    }
    case "agent_end": {
      st.assistantIndex = null;
      st.streaming = false;
      // purge des bulles assistant restées vides (messages à toolcalls seuls, text_start sans texte)
      const cleaned = prev.filter((p) => p.kind !== "assistant" || p.text.trim() !== "");
      return [...cleaned, { kind: "status", text: "Tour terminé" }];
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
    else items.push({ kind: "tool", id: e.id, text: e.name, args: e.args, result: e.result, isError: e.isError, state: "done" });
  }
  return items.map((item) => ({ ...item, key: ++nextChatItemKey }));
}

/** Recover missed entries without rolling back live deltas or losing unsaved local echoes. */
function reconcile(prev: ChatItem[], entries: HistoryEntry[], st: StreamState, initial = false): ChatItem[] {
  const history = entriesToItems(entries);
  const matches = (item: ChatItem, saved: ChatItem) => {
    if (saved.kind !== item.kind) return false;
    if (item.kind === "tool" && saved.kind === "tool" && item.id && saved.id) return item.id === saved.id;
    return saved.text === item.text || (item.kind === "assistant" && (saved.text.startsWith(item.text) || item.text.startsWith(saved.text)));
  };
  let cursor = 0;
  const first = prev[0];
  if (initial && first) {
    const anchor = history.reduce((found, saved, index) => matches(first, saved) ? index : found, -1);
    cursor = anchor < 0 ? history.length : anchor;
  }
  const out: ChatItem[] = history.slice(0, cursor);
  const positions = new Map<number, number>();
  // ponytail: chronological O(n²) matching in the bounded history window; use message IDs if this grows.
  for (const [index, item] of prev.entries()) {
    if (item.kind === "status") continue;
    let match = history.findIndex((saved, position) => position >= cursor && matches(item, saved));
    // A missing interior delta is not a prefix; fall back to the next chronological assistant.
    if (match < 0 && item.kind === "assistant") match = history.findIndex((saved, position) => position >= cursor && saved.kind === "assistant");
    let recovered = item;
    if (match >= 0) {
      out.push(...history.slice(cursor, match));
      const saved = history[match]!;
      if (item.kind === "assistant" && saved.kind === "assistant" && !(st.streaming && st.assistantIndex === index)) {
        recovered = item.text.startsWith(saved.text) ? item : { ...saved, key: item.key };
      } else if (item.kind === "tool" && saved.kind === "tool") {
        recovered = { ...saved, ...item, args: item.args ?? saved.args };
        if (saved.result !== undefined && (item.state === "running" || item.result === undefined)) recovered = { ...recovered, result: saved.result, isError: saved.isError, state: "done" };
      }
      cursor = match + 1;
    }
    positions.set(index, out.length);
    out.push(recovered);
  }
  out.push(...history.slice(cursor));
  st.assistantIndex = st.assistantIndex === null ? null : positions.get(st.assistantIndex) ?? null;
  st.toolByContent = Object.fromEntries(Object.entries(st.toolByContent).flatMap(([content, index]) => positions.has(index) ? [[content, positions.get(index)!]] : []));
  return out;
}

export default function Conversations({ initialOpenId, onConsumeInitial }: {
  initialOpenId?: string | null;
  onConsumeInitial?: () => void;
}) {
  const toast = useToast();
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
    api.conversations().then((r) => { setConversations(r.conversations); setError(null); }).catch((e: Error) => setError(e.message)).finally(() => setReady(true));
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
        />
        {showNew ? <NewConversationModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setOpenId(id); refresh(); }} /> : null}
      </>
    );
  }

  return (
    <>
      <PageHead
        title={t("chat.conversations")}
        sub={`${t(conversations.length === 1 ? "chat.session" : "chat.sessions", { count: formatNumber(conversations.length) })} · ${t(conversations.filter((c) => c.status === "active").length === 1 ? "chat.activeSession" : "chat.activeSessions", { count: formatNumber(conversations.filter((c) => c.status === "active").length) })}`}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
            <Icon name="plus" /> {t("chat.new")}
          </button>
        }
      />
      <ErrorText error={error} />
      {error ? <button type="button" className="btn btn-sm" onClick={refresh}>{t("chat.retry")}</button> : null}
      {!ready ? (
        <Skeleton />
      ) : error && conversations.length === 0 ? null : conversations.length === 0 ? (
        <Empty
          title={t("chat.noConversations")}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
              <Icon name="plus" /> {t("chat.new")}
            </button>
          }
        >
          {t("chat.createHint")}
        </Empty>
      ) : (
        <div className="list">
          {conversations.map((c) => (
            <div key={c.id} className="list-row">
              <button type="button" className="list-main" onClick={() => setOpenId(c.id)}>
                <span className="list-title">{c.title || t("chat.untitled")}</span>
                <span className="list-meta">
                  <span className="mono">{c.provider}/{c.model}{c.thinking ? `:${thinkingLabel(c.thinking)}` : ""}</span>
                  <span>{c.workspace_dir ? c.workspace_dir.split("/").pop() : t("chat.free")}</span>
                </span>
              </button>
              <Badge color={statusColor(c.status)}>{statusLabel(c.status)}</Badge>
              <IconBtn
                name="trash"
                label={t("chat.deleteTitle", { title: c.title || t("chat.untitledLower") })}
                danger
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(t("chat.deleteConfirm"))) {
                    api.deleteConversation(c.id).then(refresh).catch((err: Error) => toast(err.message, true));
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
      {showNew ? <NewConversationModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setOpenId(id); refresh(); }} /> : null}
    </>
  );
}

export function ChatView(props: {
  conversation: Conversation;
  onClose: () => void;
  onDeleted: () => void;
  embedded?: boolean;
}) {
  const { conversation } = props;
  const toast = useToast();
  const [timeline, setTimeline] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageContentInput[]>([]);
  const [skills, setSkills] = useState<SkillRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const busyRef = useRef(false);
  const eventRevision = useRef(0);
  const draftRevision = useRef(0);
  const nearBottom = useRef(true);
  const [connection, setConnection] = useState<EventConnectionState>("connecting");
  const [sessionStatus, setSessionStatus] = useState(conversation.status);
  const [running, setRunning] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const historyHydrated = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<StreamState>({ assistantIndex: null, streaming: false, toolByContent: {} });
  const [streaming, setStreaming] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [openThinking, setOpenThinking] = useState<Set<number>>(new Set());
  const [filesPanel, setFilesPanel] = useState(false);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [diffFor, setDiffFor] = useState<{ path: string } | null>(null);

  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const filesRequest = useRef(0);
  const refreshFiles = useCallback(() => {
    const current = ++filesRequest.current;
    setFilesLoading(true);
    setFilesError(null);
    api.conversationFiles(conversation.id)
      .then((r) => { if (current === filesRequest.current) setFiles(r.files); })
      .catch((e: Error) => { if (current === filesRequest.current) setFilesError(e.message); })
      .finally(() => { if (current === filesRequest.current) setFilesLoading(false); });
  }, [conversation.id]);

  const toggle = (set: Set<number>, setter: (s: Set<number>) => void, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setter(next);
  };

  useEffect(() => setSessionStatus(conversation.status), [conversation.status]);

  const updateInput = (value: string | ((prev: string) => string)) => {
    draftRevision.current += 1;
    setInput(value);
  };

  const loadHistory = useCallback(() => {
    api.history(conversation.id).then((r) => {
      setHistoryError(null);
      setHistoryReady(true);
      const firstHydration = !historyHydrated.current;
      historyHydrated.current = true;
      let streamBeforeHydration: StreamState | undefined;
      setTimeline((prev) => {
        // Capture after queued events, once even when React replays the updater.
        streamBeforeHydration ??= { ...streamRef.current, toolByContent: { ...streamRef.current.toolByContent } };
        const state = { ...streamBeforeHydration, toolByContent: { ...streamBeforeHydration.toolByContent } };
        const recovered = reconcile(prev, r.entries, state, firstHydration);
        Object.assign(streamRef.current, state);
        return recovered;
      });
    }).catch((e: Error) => {
      setHistoryError(e.message);
      setHistoryReady(true);
    });
    refreshFiles();
  }, [conversation.id, refreshFiles]);

  // historique puis SSE + liste des skills (invocables via /skill:name, expandé par pi)
  useEffect(() => {
    loadHistory();
    // l'historique peut ne pas être flushé au montage (prompt initial) : on re-tente une fois
    const refetch = setTimeout(() => loadHistory(), 3000);
    api.skills().then((r) => {
      const seen = new Set<string>();
      setSkills(r.skills.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true))));
    }).catch(() => undefined);
    const close = openEvents(
      `/api/conversations/${conversation.id}/events`,
      (e) => {
        const ev = e as SseEvent;
        eventRevision.current++;
        setTimeline((prev) => applyEvent(prev, ev, streamRef.current).map((item) => item.key === undefined ? { ...item, key: ++nextChatItemKey } : item));
        if (ev.type === "agent_start" || ev.type === "turn_start" || ev.type === "message_update") setRunning(true);
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_start") setStreaming(true);
        if (ev.type === "agent_end") {
          setStreaming(false);
          setRunning(false);
          loadHistory();
        }
      },
      {
        // à chaque (re)connexion : combler le trou d'événements via l'historique
        onOpen: () => {
          const revision = eventRevision.current;
          api.conversation(conversation.id).then((r) => {
            setSessionStatus(r.live ? r.conversation.status : "idle");
            if (revision === eventRevision.current && (typeof r.streaming === "boolean" || !r.live)) {
              const active = r.live && r.streaming === true;
              setRunning(active);
              setStreaming(active);
              streamRef.current.streaming = active;
            }
          }).catch(() => undefined).finally(() => loadHistory());
        },
        onStateChange: setConnection,
      },
    );
    return () => {
      clearTimeout(refetch);
      close();
    };
  }, [conversation.id, loadHistory]);

  useEffect(() => {
    if (nearBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [timeline.length, timeline[timeline.length - 1]?.text.length]);

  const send = async () => {
    const text = input.trim();
    if (busyRef.current || (!text && images.length === 0)) return;
    const toSend = images;
    const sentRevision = draftRevision.current;
    busyRef.current = true;
    setBusy(true);
    setSendError(null);
    try {
      await api.sendMessage(conversation.id, text, toSend.length ? toSend : undefined);
      // Ne supprimer que le brouillon envoyé, jamais les modifications faites pendant la requête.
      if (draftRevision.current === sentRevision) setInput("");
      setImages((prev) => prev.filter((image) => !toSend.includes(image)));
      // écho local : le flux SSE de pi ne contient pas les messages utilisateur
      setTimeline((prev) => [...prev, { kind: "user", text, attachmentCount: !text ? toSend.length : undefined, key: ++nextChatItemKey }]);
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
      taRef.current?.focus();
    }
  };

  const sendInteraction = async (text: string) => {
    if (busyRef.current) throw new Error(t("chat.sendingBusy"));
    busyRef.current = true;
    setBusy(true);
    try {
      await api.sendMessage(conversation.id, text);
      setTimeline((prev) => [...prev, { kind: "user", text, key: ++nextChatItemKey }]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const responses = new Map<string, UIResponse>();
  for (const item of timeline) {
    if (item.kind !== "user") continue;
    const response = parseUIResponse(item.text);
    if (response) responses.set(uiRequestKey(response.request), response);
  }
  const statusText = running ? t("chat.running") : ({ idle: t("chat.ready"), active: t("chat.ready"), running: t("chat.running"), spawning: t("chat.starting"), dead: t("chat.stopped"), error: t("chat.error") }[sessionStatus] ?? sessionStatus);
  const connectionText = connection === "connected" ? t("chat.connected") : connection === "reconnecting" ? t("chat.reconnecting") : connection === "closed" ? t("chat.disconnected") : t("chat.connecting");

  const addFiles = (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) { toast(t("chat.imagesOnly"), true); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.split(",")[1] ?? "";
        if (base64) setImages((prev) => [...prev, { type: "image" as const, data: base64, mimeType: file.type }]);
      };
      reader.onerror = () => toast(t("chat.readFailed", { name: file.name }), true);
      reader.readAsDataURL(file);
    }
  };

  const Title = props.embedded ? "h2" : "h1";
  return (
    <div className="chat">
      <header className="chat-head">
        <button type="button" className="btn btn-sm chat-back" aria-label={props.embedded ? t("chat.backBoard") : t("chat.backConversations")} onClick={props.onClose}>
          <Icon name="back" /> <span className="chat-back-label">{t("chat.back")}</span>
        </button>
        <div className="chat-heading">
          <Title>{conversation.title || t("chat.untitled")}</Title>
          <div className="chat-context"><span className="mono">{conversation.provider} / {conversation.model}</span><span className="chat-connection" role="status">{connectionText}</span></div>
        </div>
        <span className={`chat-state ${running ? "is-running" : sessionStatus === "error" || sessionStatus === "dead" ? "is-error" : ""}`} role="status"><Icon name={running ? "activity" : sessionStatus === "error" || sessionStatus === "dead" ? "warning" : "check"} size={14} />{statusText}</span>
        <button
          type="button"
          className={`btn btn-sm ${filesPanel ? "btn-primary" : ""}`}
          onClick={() => { setFilesPanel((v) => !v); refreshFiles(); }}
          aria-pressed={filesPanel}
          title={t("chat.changedFilesTitle")}
        >
          <Icon name="files" /> {t("chat.files")}{files.length > 0 ? ` (${formatNumber(files.length)})` : ""}
        </button>
        {busy || running || sessionStatus === "running" ? (
          <button type="button" className="btn btn-sm btn-danger" onClick={() => api.stopConversation(conversation.id).catch((e: Error) => toast(e.message, true))}>
            <Icon name="stop" /> {t("chat.stop")}
          </button>
        ) : null}
        <IconBtn
          name="trash"
          label={t("chat.delete")}
          danger
          onClick={() => {
            if (confirm(t("chat.deleteConfirm"))) {
              api.deleteConversation(conversation.id).then(props.onDeleted).catch((e: Error) => toast(e.message, true));
            }
          }}
        />
      </header>
      <div className="chat-body">
      <div className="chat-main">
      <div className="chat-scroll" ref={scrollRef} role="log" aria-label={t("chat.history")} aria-live="off" tabIndex={0}
        onScroll={(e) => {
          const node = e.currentTarget;
          nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 80;
          setShowLatest(!nearBottom.current);
        }}
      >
        <ErrorText error={historyError ? t("chat.historyError", { error: historyError }) : null} />
        {historyError ? <button type="button" className="btn btn-sm" onClick={() => loadHistory()}>{t("chat.retryHistory")}</button> : null}
        {!historyReady && timeline.length === 0 ? <Skeleton /> : null}
        {historyReady && !historyError && timeline.length === 0 ? (
        <Empty title={t("chat.emptyChat")}>
          {t("chat.chatHint")}
        </Empty>
      ) : null}
        {timeline.map((m, i) => {
          if (m.kind === "status") return <div key={m.key ?? i} className="msg-status">{m.text === "Tour terminé" ? t("chat.turnDone") : localizeText(m.text)}</div>;
          if (m.kind === "skill") {
            return (
              <div key={m.key ?? i} className="skill-card">
                <button type="button" className="skill-head" aria-expanded={expanded.has(i)} onClick={() => toggle(expanded, setExpanded, i)}>
                  <span className="skill-pill"><Icon name="spark" size={14} /></span>
                  <span className="skill-name">{m.name}</span>
                  <span className="tool-meta">{t(m.text.length === 1 ? "chat.character" : "chat.characters", { count: formatNumber(m.text.length) })}</span>
                  <span className={`chevron ${expanded.has(i) ? "open" : ""}`}>▸</span>
                </button>
                {expanded.has(i) ? <div className="skill-body"><Markdown text={m.text} /></div> : null}
                {m.rest ? <div className="msg msg-user skill-rest">{m.rest}</div> : null}
              </div>
            );
          }
          if (m.kind === "thinking") {
            return (
              <div key={m.key ?? i} className="msg-thinking">
                <button type="button" className="thinking-head" aria-expanded={openThinking.has(i)} onClick={() => toggle(openThinking, setOpenThinking, i)}>
                  <span className={`chevron ${openThinking.has(i) ? "open" : ""}`}>▸</span>
                  {t("chat.thinking")} · {t(m.text.length === 1 ? "chat.character" : "chat.characters", { count: formatNumber(m.text.length) })}
                </button>
                {openThinking.has(i) ? <div className="thinking-body">{m.text}</div> : null}
              </div>
            );
          }
          if (m.kind === "tool") return <ToolResult key={m.key ?? i} name={m.text || t("chat.tool")} args={m.args} result={m.result} isError={m.isError} state={m.state} />;
          const isLastAssistant = m.kind === "assistant" && i === timeline.length - 1;
          return (
            <div key={m.key ?? i} className={`msg msg-${m.kind}`} role="article" aria-label={m.kind === "user" ? t("chat.userMessage") : t("chat.agentMessage")}>
              <div className="message-label"><Icon name={m.kind === "user" ? "users" : "bot"} size={14} />{m.kind === "user" ? t("chat.you") : t("chat.agent")}</div>
              {m.kind === "assistant" ? <AssistantContent text={m.text} responses={responses} disabled={busy || running} streaming={streaming && i === streamRef.current.assistantIndex} onSubmit={sendInteraction} /> : m.attachmentCount ? <span>{t(m.attachmentCount === 1 ? "chat.attachedImage" : "chat.attachedImages", { count: formatNumber(m.attachmentCount) })}</span> : <UserContent text={m.text} />}
              {isLastAssistant && streaming ? <span className="caret" /> : null}
            </div>
          );
        })}
        {images.length > 0 ? (
          <div className="msg msg-user thumbs">
            {images.map((img, i) => (
              <span key={i} className="thumb">
                <img src={`data:${img.mimeType};base64,${img.data}`} alt={t("chat.attachment", { number: formatNumber(i + 1) })} />
                <IconBtn name="close" label={t("chat.removeImage", { number: formatNumber(i + 1) })} onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} />
              </span>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>{t(images.length === 1 ? "chat.imageToSend" : "chat.imagesToSend", { count: formatNumber(images.length) })}</span>
          </div>
        ) : null}
      </div>
      {showLatest ? <button type="button" className="btn btn-sm chat-latest" onClick={() => {
        nearBottom.current = true;
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        setShowLatest(false);
      }}><Icon name="download" size={14} /> {t("chat.latest")}</button> : null}
      <div className="composer">
      <ErrorText error={sendError ? t("chat.sendError", { error: sendError }) : null} />
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
        <textarea
          ref={taRef}
          aria-label={t("chat.message")}
          value={input}
          placeholder={t("chat.placeholder")}
          aria-describedby="composer-hint"
          onChange={(e) => updateInput(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-tools">
          <IconBtn name="paperclip" label={t("chat.attach")} onClick={() => fileRef.current?.click()} />
          <select value="" aria-label={t("chat.loadSkill")} title={t("chat.loadSkillTitle")} onChange={(e) => {
            if (!e.target.value) return;
            updateInput((value) => `/skill:${e.target.value} ${value}`.trimEnd() + " ");
            taRef.current?.focus();
          }}>
            <option value="">{t("chat.skills")}</option>
            {skills.map((skill) => <option key={skill.name} value={skill.name}>{skill.name}</option>)}
          </select>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={busy || (!input.trim() && images.length === 0)}>
          {busy ? <Spinner /> : <Icon name="send" />} <span className="composer-send-label">{t("chat.send")}</span>
        </button>
      </div>
      <div id="composer-hint" className="composer-hint"><span>{t("chat.keyboardHint")}</span><span>{running ? t("chat.working") : t("chat.interactionHint")}</span></div>
      </div>
      </div>
      {filesPanel ? (
        <aside className="chat-side">
          <div className="chat-side-head">
            <span>{t("chat.changedFiles")}</span>
            <span className="muted">{formatNumber(files.length)}</span>
          </div>
          {filesLoading ? <p role="status">{t("chat.loadingFiles")}</p> : null}
          {filesError ? <div className="error-text" role="alert">{localizeText(filesError)} <button type="button" className="btn btn-sm" onClick={refreshFiles}>{t("chat.retry")}</button></div> : null}
          {!filesLoading && !filesError && files.length === 0 ? (
            <Empty>{t("chat.noFiles")}</Empty>
          ) : !filesLoading && !filesError ? (
            <div className="chat-side-list">
              {files.map((f) => (
                <FileRow key={f.path} f={f} onClick={() => setDiffFor({ path: f.path })} />
              ))}
            </div>
          ) : null}
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
}) {
  const [createError, setCreateError] = useState<string | null>(null);
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

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([api.agents(), api.providers(), api.workspaces()])
      .then(([a, p, w]) => {
        if (!active) return;
        setAgents(a.agents);
        setAgentId(a.agents[0]?.id ?? "");
        setProviders(p.providers);
        setProviderId(p.providers[0]?.id ?? "");
        setWorkspaces(w.workspaces);
      })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);

  const provider = providers.find((p) => p.id === providerId);
  const models = provider?.models ?? [];

  const canCreate = !loading && !error && (mode === "agent" ? Boolean(agentId) : Boolean(providerId && (model || models[0]?.id)));
  const create = async () => {
    if (pending.current || !canCreate) return;
    pending.current = true;
    setBusy(true);
    setCreateError(null);
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
      setCreateError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal title={t("chat.new")} onClose={() => { if (!pending.current) props.onClose(); }}>
      {createError ? <p className="error-text" role="alert">{localizeText(createError)}</p> : null}
      {loading ? <p role="status">{t("chat.loadingOptions")}</p> : null}
      {error ? <div className="error-text" role="alert">{localizeText(error)} <button type="button" className="btn btn-sm" onClick={() => setRetry((n) => n + 1)}>{t("chat.retry")}</button></div> : null}
      <fieldset disabled={busy || loading || Boolean(error)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Field label={t("chat.mode")}>
        <select value={mode} onChange={(e) => setMode(e.target.value as "agent" | "free")}>
          <option value="agent">{t("chat.configuredAgent")}</option>
          <option value="free">{t("chat.freeProvider")}</option>
        </select>
      </Field>
      {mode === "agent" ? (
        <Field label={t("chat.agent")}>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      ) : (
        <div className="form-row">
          <Field label={t("chat.provider")}>
            <select value={providerId} onChange={(e) => { setProviderId(e.target.value); setModel(""); }}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.id} {p.auth.ready ? "✓" : "⚠"}</option>)}
            </select>
          </Field>
          <Field label={t("chat.model")}>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{t("chat.default")}</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </Field>
          {mode === "free" ? (
            <Field label={t("chat.thinkingOptional")}>
              <select value={thinking} onChange={(e) => setThinking(e.target.value)}>
                <option value="">{t("chat.default")}</option>
                {THINKING_LEVELS.map((t) => <option key={t} value={t}>{thinkingLabel(t)}</option>)}
              </select>
            </Field>
          ) : null}
        </div>
      )}
      <Field label={t("chat.workspaceOptional")}>
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">{t("chat.unassigned")}</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </Field>
      <Field label={t("chat.initialPrompt")}>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("chat.firstMessage")} />
      </Field>
      {!loading && !error && !canCreate ? <p role="status" className="muted">{mode === "agent" ? t("chat.noAgents") : t("chat.noModels")}</p> : null}
      <div className="toolbar">
        <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy || !canCreate}>
          {busy ? <><Spinner /> {t("chat.creating")}</> : t("chat.create")}
        </button>
      </div>
      </fieldset>
    </Modal>
  );
}
