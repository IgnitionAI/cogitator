import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AgentPreset, BoardCard, Conversation } from "./types";
import { Field, Modal } from "./ui";

const COLUMNS: Array<{ id: string; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "À faire" },
  { id: "in_progress", label: "En cours" },
  { id: "done", label: "Terminé" },
  { id: "canceled", label: "Annulé" },
];

const PRIORITIES: Array<{ id: string; label: string; color: string }> = [
  { id: "urgent", label: "Urgente", color: "#eb5757" },
  { id: "high", label: "Haute", color: "#f2994a" },
  { id: "medium", label: "Moyenne", color: "#8a8f98" },
  { id: "low", label: "Basse", color: "#62666d" },
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
  toast: (t: string, err?: boolean) => void;
}) {
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [detail, setDetail] = useState<BoardCard | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(() => {
    api.board(props.workspaceId).then((r) => setCards(r.cards)).catch((e: Error) => props.toast(e.message, true));
    api.conversations(props.workspaceId).then((r) => setConvs(r.conversations)).catch(() => undefined);
  }, [props.workspaceId, props.toast]);

  useEffect(refresh, [refresh]);

  const agentName = (id: string | null) => props.agents.find((a) => a.id === id)?.name ?? null;

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ Carte</button>
        <span className="muted" style={{ fontSize: 12 }}>
          {cards.length} carte(s) · source : cogitator.board.json (visible dans l'arborescence, manipulable par les agents)
        </span>
      </div>
      <div className="board">
        {COLUMNS.map((col) => {
          const colCards = cards.filter((c) => c.status === col.id);
          return (
            <div key={col.id} className="board-col">
              <div className="board-col-head">
                {col.label} <span className="muted">{colCards.length}</span>
              </div>
              {colCards.map((c) => {
                const prio = PRIORITIES.find((p) => p.id === c.priority);
                return (
                  <div key={c.id} className="board-card" onClick={() => setDetail(c)}>
                    <div className="board-card-top">
                      <span className="board-prio" style={{ background: prio?.color }} title={prio?.label} />
                      <span className="board-title">{c.title}</span>
                    </div>
                    {c.labels.length > 0 ? (
                      <div className="board-labels">
                        {c.labels.map((l) => (
                          <span key={l} className="board-label" style={{ color: labelColor(l), borderColor: labelColor(l) }}>{l}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="board-meta">
                      {agentName(c.assignee_agent_id) ? <span>👤 {agentName(c.assignee_agent_id)}</span> : null}
                      {c.conversation_ids.length > 0 ? <span>💬 {c.conversation_ids.length}</span> : null}
                      {c.blocked_by.length > 0 ? <span className="del">⛔ {c.blocked_by.length}</span> : null}
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
          toast={props.toast}
        />
      ) : null}
      {showNew ? (
        <NewCardModal
          workspaceId={props.workspaceId}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); refresh(); }}
          toast={props.toast}
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
  toast: (t: string, err?: boolean) => void;
}) {
  return (
    <Modal title={`Board — ${props.workspaceName}`} onClose={props.onClose} wide>
      <BoardPanel workspaceId={props.workspaceId} agents={props.agents} toast={props.toast} />
    </Modal>
  );
}

function NewCardModal(props: {
  workspaceId: string;
  onClose: () => void;
  onCreated: () => void;
  toast: (t: string, err?: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const create = async () => {
    try {
      await api.boardCreateCard(props.workspaceId, { title: title.trim(), description, priority });
      props.onCreated();
    } catch (e) {
      props.toast((e as Error).message, true);
    }
  };
  return (
    <Modal title="Nouvelle carte" onClose={props.onClose}>
      <Field label="Titre"><input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
      <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Priorité">
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </Field>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={!title.trim()} onClick={() => void create()}>Créer</button>
      </div>
    </Modal>
  );
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
  toast: (t: string, err?: boolean) => void;
}) {
  const { card, workspaceId } = props;
  const [form, setForm] = useState({
    title: card.title,
    description: card.description,
    priority: card.priority,
    status: card.status,
    labels: card.labels.join(", "),
    assignee_agent_id: card.assignee_agent_id ?? "",
    conversation_ids: card.conversation_ids,
    blocks: card.blocks,
    blocked_by: card.blocked_by,
  });
  const [comment, setComment] = useState("");
  const [activity, setActivity] = useState<{ additions: number; deletions: number; files: number } | null>(null);

  useEffect(() => {
    if (card.conversation_ids.length > 0) {
      api.boardCardActivity(workspaceId, card.id).then((r) => setActivity(r.totals)).catch(() => undefined);
    }
  }, [workspaceId, card.id, card.conversation_ids.length]);

  const save = async () => {
    try {
      await api.boardUpdateCard(workspaceId, card.id, {
        title: form.title.trim() || card.title,
        description: form.description,
        priority: form.priority,
        status: form.status,
        labels: form.labels.split(",").map((l) => l.trim()).filter(Boolean),
        assignee_agent_id: form.assignee_agent_id || null,
        conversation_ids: form.conversation_ids,
        blocks: form.blocks,
        blocked_by: form.blocked_by,
      });
      props.onChanged();
      props.toast("Carte mise à jour");
    } catch (e) {
      props.toast((e as Error).message, true);
    }
  };

  const addComment = async () => {
    const text = comment.trim();
    if (!text) return;
    try {
      await api.boardComment(workspaceId, card.id, { text, author: "user" });
      setComment("");
      props.onChanged();
    } catch (e) {
      props.toast((e as Error).message, true);
    }
  };

  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const otherCards = props.cards.filter((c) => c.id !== card.id);

  return (
    <Modal title={card.title} onClose={props.onClose} wide>
      <div className="form-row">
        <Field label="Titre"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Colonne">
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Priorité">
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Description"><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <div className="form-row">
        <Field label="Labels (virgules)"><input value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} /></Field>
        <Field label="Assigné (agent)">
          <select value={form.assignee_agent_id} onChange={(e) => setForm({ ...form, assignee_agent_id: e.target.value })}>
            <option value="">— non assigné —</option>
            {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label={`Conversations liées (${form.conversation_ids.length})`}>
        <div className="link-list">
          {props.conversations.map((c) => (
            <label key={c.id} style={{ display: "flex", gap: 6, fontSize: 12.5, padding: "2px 4px" }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={form.conversation_ids.includes(c.id)}
                onChange={() => setForm({ ...form, conversation_ids: toggleIn(form.conversation_ids, c.id) })}
              />
              <span className="muted">{(c.title || "(sans titre)").slice(0, 60)}</span>
            </label>
          ))}
        </div>
      </Field>
      {activity ? (
        <div className="file-stats" style={{ marginBottom: 12, fontSize: 12.5 }}>
          Activité des conversations liées : <span className="add">+{activity.additions}</span>
          <span className="del">−{activity.deletions}</span>
          <span className="muted"> sur {activity.files} fichier(s)</span>
        </div>
      ) : null}
      <div className="form-row">
        <Field label={`Bloque (${form.blocks.length})`}>
          <select value="" onChange={(e) => { if (e.target.value) setForm({ ...form, blocks: toggleIn(form.blocks, e.target.value) }); }}>
            <option value="">+ ajouter…</option>
            {otherCards.filter((c) => !form.blocks.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 50)}</option>)}
          </select>
          <div className="link-chips">{form.blocks.map((id) => (
            <span key={id} className="chip" onClick={() => setForm({ ...form, blocks: form.blocks.filter((x) => x !== id) })}>
              {props.cards.find((c) => c.id === id)?.title.slice(0, 30) ?? id.slice(0, 8)} ✕
            </span>
          ))}</div>
        </Field>
        <Field label={`Bloqué par (${form.blocked_by.length})`}>
          <select value="" onChange={(e) => { if (e.target.value) setForm({ ...form, blocked_by: toggleIn(form.blocked_by, e.target.value) }); }}>
            <option value="">+ ajouter…</option>
            {otherCards.filter((c) => !form.blocked_by.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.title.slice(0, 50)}</option>)}
          </select>
          <div className="link-chips">{form.blocked_by.map((id) => (
            <span key={id} className="chip" onClick={() => setForm({ ...form, blocked_by: form.blocked_by.filter((x) => x !== id) })}>
              {props.cards.find((c) => c.id === id)?.title.slice(0, 30) ?? id.slice(0, 8)} ✕
            </span>
          ))}</div>
        </Field>
      </div>
      <Field label={`Commentaires (${card.comments.length})`}>
        <div className="comments">
          {card.comments.map((cm) => (
            <div key={cm.id} className="comment">
              <div className="comment-head">
                <span className="comment-author">{cm.author}</span>
                <span className="muted">{new Date(cm.at).toLocaleString()}</span>
              </div>
              <div className="comment-text">{cm.text}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input value={comment} placeholder="Commenter…" onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addComment(); }} />
          <button className="btn btn-sm" onClick={() => void addComment()}>Envoyer</button>
        </div>
      </Field>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void save()}>Sauvegarder</button>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm("Supprimer cette carte ?")) {
              api.boardDeleteCard(workspaceId, card.id).then(props.onDeleted).catch((e: Error) => props.toast(e.message, true));
            }
          }}
        >
          Supprimer
        </button>
      </div>
    </Modal>
  );
}
