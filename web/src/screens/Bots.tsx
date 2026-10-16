import { QueueRecovery, appendRecoveredMessage } from "../QueueRecovery";
import { LiveConfiguration } from "../ModelConfiguration";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEvents, type EventConnectionState } from "../api";
import type { AgentPreset, Conversation, Group, GroupMessage, Workspace } from "../types";
import { Empty, ErrorText, Field, PageHead, Skeleton, Spinner, useToast } from "../ui";
import { Icon } from "../icons";
import { localizeText, t } from "../i18n";
import { Markdown } from "../markdown";
import { ToolResult } from "../ToolResult";
import { applyEvent, bumpChatItemKey, ChatView, type ChatItem, type StreamState } from "./Conversations";

export default function Bots() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [openGroup, setOpenGroup] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.agents(), api.groups()])
      .then(([a, g]) => { setAgents(a.agents); setGroups(g.groups); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setReady(true));
  }, []);

  useEffect(load, [load]);
  useEffect(() => openEvents("/api/events", (e) => {
    if ((e as { type?: string }).type === "agents_changed") load();
  }), [load]);

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
        onClose={() => { setOpen(null); load(); }}
        onDeleted={() => { setOpen(null); load(); }}
      />
    );
  }

  if (openGroup) {
    return <GroupView group={openGroup} onClose={() => { setOpenGroup(null); load(); }} />;
  }

  return (
    <>
      <PageHead title={t("screens.bots")} sub={t("screens.botsSub")} />
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={load}>{t("screens.retry")}</button> : null}
      {!ready ? <Skeleton /> : error && agents.length === 0 ? null : (
        <>
          <GroupSection groups={groups} agents={agents} onOpen={setOpenGroup} onChanged={load} />
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
          {agents.length === 0 ? <Empty title={t("screens.noBots")}>{t("screens.botEmpty")}</Empty> : null}
        </>
      )}
    </>
  );
}

/** Section groupes : liste + création (2–6 bots, hôte = 1er membre par défaut, workspace optionnel). */
function GroupSection(props: { groups: Group[]; agents: AgentPreset[]; onOpen: (g: Group) => void; onChanged: () => void }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "16px 0 8px" }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{t("screens.groups")}</h2>
        <button type="button" className="btn btn-sm" disabled={props.agents.length < 2} onClick={() => setCreating((v) => !v)}>
          <Icon name="plus" /> {t("screens.newGroup")}
        </button>
      </div>
      {creating ? (
        <GroupCreateForm
          agents={props.agents}
          onDone={() => { setCreating(false); props.onChanged(); }}
          onCancel={() => setCreating(false)}
          onError={(m) => toast(m, true)}
        />
      ) : null}
      {props.groups.length === 0 ? (
        <p className="list-meta">{t("screens.noGroups")}</p>
      ) : (
        <div className="list">
          {props.groups.map((g) => (
            <div key={g.id} className="list-row">
              <button type="button" className="list-main" onClick={() => props.onOpen(g)}>
                <span className="list-title">{g.name}</span>
                <span className="list-meta">
                  {g.members.map((m) => (m.is_host ? `★ ${m.name}` : m.name)).join(" · ")}
                </span>
              </button>
              <button type="button" className="btn btn-sm" onClick={() => props.onOpen(g)}>
                <Icon name="chat" /> {t("screens.open")}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function GroupCreateForm(props: { agents: AgentPreset[]; onDone: () => void; onCancel: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [hostId, setHostId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.workspaces().then((r) => setWorkspaces(r.workspaces)).catch(() => undefined);
  }, []);

  const selected = props.agents.filter((a) => memberIds.includes(a.id));
  const host = selected.find((a) => a.id === hostId) ?? selected[0];

  function toggleMember(id: string) {
    setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function submit() {
    setBusy(true);
    try {
      await api.createGroup({
        name: name.trim(),
        member_agent_ids: memberIds,
        ...(host ? { host_agent_id: host.id } : {}),
        ...(workspaceId ? { default_workspace_id: workspaceId } : {}),
      });
      props.onDone();
    } catch (e: unknown) {
      props.onError(localizeText(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form-grid">
      <Field label={t("screens.groupName")}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("screens.groupNameExample")} />
      </Field>
      <Field label={t("screens.groupMembers")} hint={t("screens.groupMembersHint")}>
        <div>
          {props.agents.map((a) => (
            <label key={a.id} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 13 }}>
              <input type="checkbox" checked={memberIds.includes(a.id)} onChange={() => toggleMember(a.id)} />
              {a.name} <span className="list-meta">{a.provider}/{a.model}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label={t("screens.groupHost")} hint={t("screens.groupHostHint")}>
        <select value={host?.id ?? ""} onChange={(e) => setHostId(e.target.value)} disabled={selected.length === 0}>
          <option value="">{t("screens.groupHostNone")}</option>
          {selected.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      <Field label={t("screens.groupWorkspace")}>
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">{t("screens.noWorkspace")}</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name || w.dir}</option>)}
        </select>
      </Field>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim() || memberIds.length < 2} onClick={() => void submit()}>
          {t("screens.createGroup")}
        </button>
        <button type="button" className="btn" onClick={props.onCancel}>{t("screens.cancel")}</button>
      </div>
    </div>
  );
}

/** Enveloppe SSE du bus : un seul flux pour tout le fil, événement pi du membre + attribution. */
type GroupActivity = {
  type: string;
  conversationId?: string;
  agentId?: string | null;
  name?: string | null;
  event?: import("../types").SseEvent;
};

type GroupItem = ChatItem & { author?: string };

/** Rejeu persistant du bus → timeline (le streaming live passe par le SSE, pas par ces lignes). */
function busRowsToItems(rows: GroupMessage[], group: Group): GroupItem[] {
  const memberName = (agentId: string | null) =>
    agentId ? group.members.find((m) => m.agent_id === agentId)?.name ?? agentId : "";
  return rows.flatMap((r): GroupItem[] => {
    if (r.role === "user") return r.text ? [{ kind: "user", text: r.text }] : [];
    if (r.role === "assistant") return r.text.trim() ? [{ kind: "assistant", text: r.text, author: memberName(r.agent_id) }] : [];
    const result = r.detail ? (JSON.parse(r.detail) as { result?: string }).result : undefined;
    return [{ kind: "tool", text: r.text, result, isError: r.is_error === 1, state: "done", author: memberName(r.agent_id) }];
  });
}

/** Fil de groupe (ADR-011) : une seule source SSE sur le bus ; hôte sans @, membre visé avec @. */
function GroupView(props: { group: Group; onClose: () => void }) {
  const toast = useToast();
  const { group } = props;
  const [memberConversations, setMemberConversations] = useState<Record<string, Conversation>>({});
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  // A member's SSE/write invalidates only its own in-flight configuration read.
  const configurationRevisions = useRef<Record<string, number>>({});
  const updateMember = useCallback((conversation: Conversation) => {
    configurationRevisions.current[conversation.id] = (configurationRevisions.current[conversation.id] ?? 0) + 1;
    setMemberConversations((current) => ({ ...current, [conversation.id]: conversation }));
  }, []);
  const loadConfigurations = useCallback(() => {
    Promise.all(group.members.map(async (member) => {
      const id = member.conversation_id;
      const revision = (configurationRevisions.current[id] ?? 0) + 1;
      configurationRevisions.current[id] = revision;
      const response = await api.conversation(id);
      if (configurationRevisions.current[id] === revision) updateMember(response.conversation);
    }))
      .then(() => setConfigurationError(null))
      .catch((error: Error) => setConfigurationError(error.message));
  }, [group, updateMember]);
  const [busItems, setBusItems] = useState<GroupItem[]>([]);
  const [liveItems, setLiveItems] = useState<GroupItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [connection, setConnection] = useState<EventConnectionState>("connecting");
  const [ready, setReady] = useState(false);
  const busyRef = useRef(false);
  const streamRef = useRef<StreamState>({ assistantIndex: null, streaming: false, toolByContent: {} });
  const authorRef = useRef<string>("");
  const runnerRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);

  const memberName = useCallback(
    (agentId: string | null | undefined) => group.members.find((m) => m.agent_id === agentId)?.name ?? agentId ?? "?",
    [group],
  );

  const loadBus = useCallback(() => {
    api.groupMessages(group.id)
      .then((r) => { setBusItems(busRowsToItems(r.messages, group)); setReady(true); })
      .catch((e: Error) => { toast(localizeText(e.message), true); setReady(true); });
  }, [group, toast]);

  // rejeu du bus + UN flux SSE group_activity (pas N flux des sessions membres)
  useEffect(() => {
    loadBus();
    const close = openEvents(
      `/api/groups/${group.id}/events`,
      (e) => {
        const envelope = e as GroupActivity;
        if (envelope.type !== "group_activity" || !envelope.event) return;
        const inner = envelope.event;
        if (inner.type === "configuration_changed" && inner.conversation) { updateMember(inner.conversation); return; }
        authorRef.current = envelope.name ?? memberName(envelope.agentId);
        const isActiveEvent = inner.type === "agent_start" || inner.type === "turn_start" || inner.type === "message_update";
        if (isActiveEvent) runnerRef.current = envelope.conversationId ?? runnerRef.current;
        const member = group.members.find((entry) => entry.conversation_id === envelope.conversationId);
        setLiveItems((prev) =>
          (applyEvent(prev, inner, streamRef.current) as GroupItem[]).map((item) =>
            item.kind === "queue" && !item.author && member
              ? { ...item, author: member.name, text: member.is_host || !item.text ? item.text : `@${member.slug} ${item.text}` }
              : (item.kind === "assistant" || item.kind === "tool") && !item.author && authorRef.current
              ? { ...item, author: authorRef.current }
              : item,
          ),
        );
        if (isActiveEvent) setRunning(true);
        if (inner.type === "message_update" && inner.assistantMessageEvent?.type === "text_start") setStreaming(true);
        if (inner.type === "agent_end" && envelope.conversationId === runnerRef.current) {
          setRunning(false);
          setStreaming(false);
          // le serveur écrit la réponse finale sur le bus ~1,5 s après agent_end : rejeu, puis on purge le live
          setTimeout(() => {
            loadBus();
            setLiveItems((current) => current.filter((item) => item.kind === "queue"));
            streamRef.current = { assistantIndex: null, streaming: false, toolByContent: {} };
          }, 1700);
        }
      },
      {
        // à chaque (re)connexion : combler le trou via le rejeu du bus
        onOpen: () => { loadBus(); loadConfigurations(); setLiveItems((current) => current.filter((item) => item.kind === "queue")); },
        onStateChange: setConnection,
      },
    );
    return close;
  }, [group.id, loadBus, memberName, loadConfigurations, updateMember]);

  const items = [...busItems, ...liveItems].filter((i) => i.kind !== "status");

  useEffect(() => {
    if (nearBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length, items[items.length - 1]?.text.length]);

  const send = async () => {
    const text = input.trim();
    if (busyRef.current || !text) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.sendGroupMessage(group.id, text);
      setInput("");
      // écho local : le bus pi ne contient pas les messages utilisateur
      setLiveItems((prev) => [...prev, { kind: "user", text, key: bumpChatItemKey() }]);
    } catch (e: unknown) {
      toast(localizeText(e instanceof Error ? e.message : String(e)), true);
    } finally {
      busyRef.current = false;
      setBusy(false);
      taRef.current?.focus();
    }
  };

  async function remove() {
    try {
      await api.deleteGroup(group.id);
      props.onClose();
    } catch (e: unknown) {
      toast(localizeText(e instanceof Error ? e.message : String(e)), true);
    }
  }

  const connectionText = connection === "connected" ? t("chat.connected") : connection === "reconnecting" ? t("chat.reconnecting") : connection === "closed" ? t("chat.disconnected") : t("chat.connecting");

  return (
    <div className="chat">
      <header className="chat-head">
        <button type="button" className="btn btn-sm chat-back" onClick={props.onClose}>
          <Icon name="back" /> <span className="chat-back-label">{t("chat.back")}</span>
        </button>
        <div className="chat-heading">
          <h1>{group.name}</h1>
          <div className="chat-context">
            <span>{group.members.map((m) => (m.is_host ? `★ ${m.name}` : m.name)).join(" · ")}</span>
            <span className="chat-connection" role="status">{connectionText}</span>
          </div>
        </div>
        <span className={`chat-state ${running ? "is-running" : ""}`} role="status">
          <Icon name={running ? "activity" : "check"} size={14} />{running ? t("chat.running") : t("chat.ready")}
        </span>
        {running && runnerRef.current ? (
          <button type="button" className="btn btn-sm btn-danger" onClick={() => api.stopConversation(runnerRef.current).catch((e: Error) => toast(e.message, true))}>
            <Icon name="stop" /> {t("chat.stop")}
          </button>
        ) : null}
        <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (confirm(t("screens.deleteGroupConfirm", { name: group.name }))) void remove(); }}>
          {t("screens.delete")}
        </button>
      </header>
      <div className="group-configurations">
        <ErrorText error={configurationError} />
        {configurationError ? <button type="button" className="btn btn-sm" onClick={loadConfigurations}>{t("screens.retryOptions")}</button> : null}
        {group.members.map((member) => {
          const conversation = memberConversations[member.conversation_id];
          return conversation ? <LiveConfiguration key={member.conversation_id} name={member.name} conversation={conversation} onChanged={updateMember} /> : null;
        })}
      </div>
      <div className="chat-body">
        <div className="chat-main">
          <div
            className="chat-scroll"
            ref={scrollRef}
            role="log"
            aria-label={t("chat.history")}
            tabIndex={0}
            onScroll={(e) => {
              const node = e.currentTarget;
              nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 80;
            }}
          >
            {!ready ? <Skeleton /> : null}
            {ready && items.length === 0 ? (
              <Empty title={t("screens.groupEmpty")}>{t("screens.groupEmptyHint")}</Empty>
            ) : null}
            {items.map((m, i) => {
              if (m.kind === "queue") return <QueueRecovery key={m.key ?? i} item={m} onRestore={(text) => { setInput((draft) => appendRecoveredMessage(draft, text)); taRef.current?.focus(); }} />;
              if (m.kind === "tool") {
                return (
                  <div key={m.key ?? i}>
                    {m.author ? <div className="message-label"><Icon name="bot" size={14} />{m.author}</div> : null}
                    <ToolResult name={m.text} args={m.args} result={m.result} isError={m.isError} state={m.state} />
                  </div>
                );
              }
              const isLastAssistant = m.kind === "assistant" && i === items.length - 1;
              return (
                <div key={m.key ?? i} className={`msg msg-${m.kind}`} role="article" aria-label={m.kind === "user" ? t("chat.userMessage") : t("chat.agentMessage")}>
                  <div className="message-label">
                    <Icon name={m.kind === "user" ? "users" : "bot"} size={14} />
                    {m.kind === "user" ? t("screens.groupYou") : m.author ?? t("chat.agent")}
                  </div>
                  <Markdown text={m.text} />
                  {isLastAssistant && streaming ? <span className="caret" /> : null}
                </div>
              );
            })}
          </div>
          <div className="composer">
            <div className="chat-input">
              <textarea
                ref={taRef}
                aria-label={t("chat.message")}
                value={input}
                placeholder={t("screens.groupPlaceholder")}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={busy || !input.trim()}>
                {busy ? <Spinner /> : <Icon name="send" />} <span className="composer-send-label">{t("chat.send")}</span>
              </button>
            </div>
            <div className="composer-hint"><span>{t("chat.keyboardHint")}</span><span>{running ? t("chat.working") : t("screens.groupSub")}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
