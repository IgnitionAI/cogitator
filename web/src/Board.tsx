import { t, formatDate, formatNumber, localizeText } from "./i18n";
import type { workspaceMessages } from "./locales/workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AgentPreset, BoardCard, Conversation } from "./types";
import { Field, Modal, useToast } from "./ui";

const COLUMNS: Array<{ id: string; label: keyof typeof workspaceMessages }> = [
  { id: "backlog", label: "workspace.backlog" },
  { id: "todo", label: "workspace.todo" },
  { id: "in_progress", label: "workspace.inProgress" },
  { id: "done", label: "workspace.done" },
  { id: "canceled", label: "workspace.canceled" },
];

const PRIORITIES: Array<{ id: string; label: keyof typeof workspaceMessages; color: string }> = [
  { id: "urgent", label: "workspace.urgent", color: "#eb5757" },
  { id: "high", label: "workspace.high", color: "#f2994a" },
  { id: "medium", label: "workspace.medium", color: "#8a8f98" },
  { id: "low", label: "workspace.low", color: "var(--subtle)" },
];

const LABEL_COLORS = ["#5e6ad2", "#4cb782", "#e2a336", "#eb5757", "#38bdf8", "#c084fc"];

function labelColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return LABEL_COLORS[h % LABEL_COLORS.length]!;
}

export function BoardPanel(props: {
  workspaceId: string;
  agents: AgentPreset[];
  onOpenConversation?: (id: string) => void;
}) {
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [detail, setDetail] = useState<BoardCard | null>(null);
  const [showNew, setShowNew] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    Promise.all([api.board(props.workspaceId), api.conversations(props.workspaceId)])
      .then(([board, conversations]) => {
        if (current !== request.current) return;
        setCards(board.cards);
        setConvs(conversations.conversations);
        setDetail((previous) => previous ? board.cards.find((c) => c.id === previous.id) ?? null : null);
      })
      .catch((e: Error) => { if (current === request.current) setError(e.message); })
      .finally(() => { if (current === request.current) setLoading(false); });
  }, [props.workspaceId]);

  useEffect(() => { refresh(); return () => { request.current++; }; }, [refresh]);

  const agentName = (id: string | null) => props.agents.find((a) => a.id === id)?.name ?? null;

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>{t("workspace.addCard")}</button>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={refresh}>{t("workspace.refresh")}</button>
        <span className="muted" style={{ fontSize: 12 }}>
          {t((cards.length) === 1 ? "workspace.cardCountOne" : "workspace.cardCountMany", { count: formatNumber(cards.length) })}
        </span>
      </div>
      {loading ? <p role="status">{t("workspace.boardLoading")}</p> : null}
      {error ? <div role="alert" className="error-text">{t("workspace.error", { detail: localizeText(error) })} <button type="button" className="btn btn-sm" onClick={refresh}>{t("workspace.retry")}</button></div> : null}
      <div className="board" data-scroll-hint={t("workspace.scrollBoard")} aria-busy={loading}>
        {COLUMNS.map((col) => {
          const colCards = cards.filter((c) => c.status === col.id);
          return (
            <div key={col.id} className="board-col">
              <div className="board-col-head">
                {t(col.label)} <span className="muted">{formatNumber(colCards.length)}</span>
              </div>
              {!loading && !error && colCards.length === 0 ? <p className="muted">{t("workspace.noCards")}</p> : null}
              {colCards.map((c) => {
                const prio = PRIORITIES.find((p) => p.id === c.priority);
                return (
                  <div key={c.id} className="board-card">
                    <div className="board-card-top">
                      <span className="board-prio" style={{ background: prio?.color }} title={prio ? t(prio.label) : undefined} />
                      <button type="button" className="board-title" onClick={() => setDetail(c)}>{c.title}</button>
                    </div>
                    <a className="board-gh mono" href={c.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>↗ #{c.number}</a>
                    {c.labels.length > 0 ? (
                      <div className="board-labels">
                        {c.labels.map((l) => (
                          <span key={l} className="board-label" style={{ color: labelColor(l), borderColor: labelColor(l) }}>{l}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="board-meta">
                      {prio ? <span>{t(prio.label)}</span> : null}
                      {agentName(c.assignee_agent_id) ? <span>👤 {agentName(c.assignee_agent_id)}</span> : null}
                      {c.conversation_ids.length > 0 ? <span>💬 {formatNumber(c.conversation_ids.length)}</span> : null}
                      {c.blocked_by.length > 0 ? <span className="del">⛔ {formatNumber(c.blocked_by.length)}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {detail ? (
        <CardDetail
          key={detail.id}
          workspaceId={props.workspaceId}
          card={detail}
          cards={cards}
          agents={props.agents}
          conversations={convs}
          onClose={() => setDetail(null)}
          onChanged={() => { refresh(); }}
          onDeleted={() => { setDetail(null); refresh(); }}
         
          onOpenConversation={props.onOpenConversation}
        />
      ) : null}
      {showNew ? (
        <NewCardModal
          workspaceId={props.workspaceId}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); refresh(); }}
         
        />
      ) : null}
    </>
  );
}

export default function BoardModal(props: {
  workspaceId: string;
  workspaceName: string;
  agents: AgentPreset[];
  onClose: () => void;
}) {
  return (
    <Modal title={t("workspace.boardTitle", { name: props.workspaceName })} onClose={props.onClose} wide>
      <BoardPanel workspaceId={props.workspaceId} agents={props.agents} />
    </Modal>
  );
}

function NewCardModal(props: {
  workspaceId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const create = async () => {
    if (pendingRef.current || !title.trim()) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await api.boardCreateCard(props.workspaceId, { title: title.trim(), description, priority });
      props.onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return (
    <Modal title={t("workspace.newCard")} onClose={() => { if (!pendingRef.current) props.onClose(); }}>
      {error ? <p className="error-text" role="alert">{t("workspace.error", { detail: localizeText(error) })}</p> : null}
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Field label={t("workspace.title")}><input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
      <Field label={t("workspace.description")}><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label={t("workspace.priority")}>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}
        </select>
      </Field>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={pending || !title.trim()} onClick={() => void create()}>{pending ? t("workspace.creating") : t("workspace.createCard")}</button>
      </div>
      </fieldset>
    </Modal>
  );
}

function cardForm(card: BoardCard) {
  return {
    title: card.title,
    description: card.description,
    priority: card.priority,
    status: card.status,
    labels: card.labels.join(", "),
    assignee_agent_id: card.assignee_agent_id ?? "",
    conversation_ids: card.conversation_ids,
    blocks: card.blocks,
    blocked_by: card.blocked_by,
  };
}

function CardDetail(props: {
  workspaceId: string;
  card: BoardCard;
  cards: BoardCard[];
  agents: AgentPreset[];
  conversations: Conversation[];
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onOpenConversation?: (id: string) => void;
}) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const { card, workspaceId } = props;
  const [form, setForm] = useState(() => cardForm(card));
  const [savedForm, setSavedForm] = useState(() => cardForm(card));
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  useEffect(() => {
    if (!dirty) {
      setForm(cardForm(card));
      setSavedForm(cardForm(card));
    }
  }, [card]);
  const [comment, setComment] = useState("");
  const [activity, setActivity] = useState<{ additions: number; deletions: number; files: number } | null>(null);

  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityRetry, setActivityRetry] = useState(0);
  const linkedConversations = card.conversation_ids.join(",");
  useEffect(() => {
    let active = true;
    setActivity(null);
    setActivityError(null);
    setActivityLoading(Boolean(linkedConversations));
    if (linkedConversations) {
      api.boardCardActivity(workspaceId, card.id)
        .then((r) => { if (active) setActivity(r.totals); })
        .catch((e: Error) => { if (active) setActivityError(e.message); })
        .finally(() => { if (active) setActivityLoading(false); });
    }
    return () => { active = false; };
  }, [workspaceId, card.id, card.updated_at, linkedConversations, activityRetry]);

  const save = async () => {
    if (pendingRef.current || !form.title.trim() || !dirty) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await api.boardUpdateCard(workspaceId, card.id, {
        title: form.title.trim(),
        description: form.description,
        priority: form.priority,
        status: form.status,
        labels: form.labels.split(",").map((l) => l.trim()).filter(Boolean),
        assignee_agent_id: form.assignee_agent_id || null,
        conversation_ids: form.conversation_ids,
        blocks: form.blocks,
        blocked_by: form.blocked_by,
      });
      setForm(cardForm(result.card));
      setSavedForm(cardForm(result.card));
      props.onChanged();
      toast(t("workspace.updated"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const addComment = async () => {
    const text = comment.trim();
    if (!text || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await api.boardComment(workspaceId, card.id, { text, author: "user" });
      setComment("");
      props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const otherCards = props.cards.filter((c) => c.id !== card.id);

  return (
    <Modal title={card.title} onClose={() => { if (!pendingRef.current && ((!dirty && !comment.trim()) || confirm(t("workspace.discard")))) props.onClose(); }} wide>
      {error ? <p className="error-text" role="alert">{t("workspace.error", { detail: localizeText(error) })}</p> : null}
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-row">
        <Field label={t("workspace.title")}><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label={t("workspace.column")}>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {COLUMNS.map((c) => <option key={c.id} value={c.id}>{t(c.label)}</option>)}
          </select>
        </Field>
        <Field label={t("workspace.priority")}>
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}
          </select>
        </Field>
      </div>
      <Field label={t("workspace.description")}><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <div className="form-row">
        <Field label={t("workspace.labels")}><input value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} /></Field>
        <Field label={t("workspace.assignee")}>
          <select value={form.assignee_agent_id} onChange={(e) => setForm({ ...form, assignee_agent_id: e.target.value })}>
            <option value="">{t("workspace.unassigned")}</option>
            {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, minWidth: 0 }}><legend className="field-label">{t("workspace.linkedConversations", { count: formatNumber(form.conversation_ids.length) })}</legend>
        {props.conversations.length === 0 ? <p className="muted">{t("workspace.nothingToLink")}</p> : null}
        <div className="link-list">
          {props.conversations.map((c) => (
            <label key={c.id} style={{ display: "flex", gap: 6, fontSize: 12.5, padding: "2px 4px" }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={form.conversation_ids.includes(c.id)}
                onChange={() => setForm({ ...form, conversation_ids: toggleIn(form.conversation_ids, c.id) })}
              />
              <span className="muted">{(c.title || t("workspace.untitled")).slice(0, 60)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {activityLoading ? <p role="status">{t("workspace.activityLoading")}</p> : null}
      {activityError ? <div role="alert" className="error-text">{t("workspace.error", { detail: localizeText(activityError) })} <button type="button" className="btn btn-sm" onClick={() => setActivityRetry((n) => n + 1)}>{t("workspace.retry")}</button></div> : null}
      {activity ? (
        <div className="file-stats" style={{ marginBottom: 12, fontSize: 12.5 }}>
          {t("workspace.linkedActivity")} <span className="add">+{formatNumber(activity.additions)}</span>
          <span className="del">−{formatNumber(activity.deletions)}</span>
          <span className="muted">{t((activity.files) === 1 ? "workspace.fileCountOne" : "workspace.fileCountMany", { count: formatNumber(activity.files) })}</span>
        </div>
      ) : null}
      <div className="form-row">
        <div>
        <Field label={t("workspace.blocks", { count: formatNumber(form.blocks.length) })}>
          <select value="" onChange={(e) => { if (e.target.value) setForm({ ...form, blocks: toggleIn(form.blocks, e.target.value) }); }}>
            <option value="">{t("workspace.add")}</option>
            {otherCards.filter((c) => !form.blocks.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 50)}</option>)}
          </select>
        </Field>
          <div className="link-chips">{form.blocks.map((id) => (
            <button type="button" key={id} className="chip" aria-label={t("workspace.removeLink", { title: props.cards.find((c) => c.id === id)?.title ?? id })} onClick={() => setForm({ ...form, blocks: form.blocks.filter((x) => x !== id) })}>
              {props.cards.find((c) => c.id === id)?.title ?? id} ×
            </button>
          ))}</div>
        </div>
        <div>
        <Field label={t("workspace.blockedBy", { count: formatNumber(form.blocked_by.length) })}>
          <select value="" onChange={(e) => { if (e.target.value) setForm({ ...form, blocked_by: toggleIn(form.blocked_by, e.target.value) }); }}>
            <option value="">{t("workspace.add")}</option>
            {otherCards.filter((c) => !form.blocked_by.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 50)}</option>)}
          </select>
        </Field>
          <div className="link-chips">{form.blocked_by.map((id) => (
            <button type="button" key={id} className="chip" aria-label={t("workspace.removeBlock", { title: props.cards.find((c) => c.id === id)?.title ?? id })} onClick={() => setForm({ ...form, blocked_by: form.blocked_by.filter((x) => x !== id) })}>
              {props.cards.find((c) => c.id === id)?.title ?? id} ×
            </button>
          ))}</div>
        </div>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, minWidth: 0 }}><legend className="field-label">{t("workspace.comments", { count: formatNumber(card.comments.length) })}</legend>
        <div className="comments">
          {card.comments.map((cm) => (
            <div key={cm.id} className="comment">
              <div className="comment-head">
                <span className="comment-author">{cm.author}</span>
                <span className="muted">{formatDate(cm.at)}</span>
              </div>
              <div className="comment-text">{cm.text}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input aria-label={t("workspace.newComment")} value={comment} placeholder={t("workspace.comment")} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void addComment(); }} />
          <button className="btn btn-sm" disabled={pending || !comment.trim()} onClick={() => void addComment()}>{t("workspace.send")}</button>
        </div>
      </fieldset>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={pending || !dirty || !form.title.trim()} onClick={() => void save()}>{pending ? t("workspace.working") : t("workspace.save")}</button>
        <button
          className="btn"
          disabled={pending || dirty || !form.assignee_agent_id}
          title={dirty ? t("workspace.saveFirst") : form.assignee_agent_id ? t("workspace.startHelp") : t("workspace.assignFirst")}
          onClick={() => {
            if (pendingRef.current || dirty || !form.assignee_agent_id) return;
            pendingRef.current = true;
            setPending(true);
            setError(null);
            api.boardStartWork(props.workspaceId, card.id)
              .then((r) => {
                toast(t("workspace.started", { number: r.card.number, id: r.conversation.id.slice(0, 8) }));
                props.onOpenConversation?.(r.conversation.id);
                props.onChanged();
              })
              .catch((e: Error) => setError(e.message))
              .finally(() => { pendingRef.current = false; setPending(false); });
          }}
        >
          {t("workspace.startAgent")}
        </button>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (pendingRef.current || !confirm(t("workspace.deleteConfirm"))) return;
            pendingRef.current = true;
            setPending(true);
            setError(null);
            api.boardDeleteCard(workspaceId, card.id).then(props.onDeleted)
              .catch((e: Error) => setError(e.message))
              .finally(() => { pendingRef.current = false; setPending(false); });
          }}
        >
          {t("workspace.delete")}
        </button>
      </div>
      {dirty ? <p role="status" className="muted">{t("workspace.unsaved")}</p> : null}
      </fieldset>
    </Modal>
  );
}
