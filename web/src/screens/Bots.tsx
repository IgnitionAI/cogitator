import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEvents } from "../api";
import type { AgentPreset, Conversation, Group, Workspace } from "../types";
import { Empty, ErrorText, Field, PageHead, Skeleton, useToast } from "../ui";
import { Icon } from "../icons";
import { localizeText, t } from "../i18n";
import { ChatView } from "./Conversations";

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

/** Fil de groupe (create/list S4) : nommé, vide, membres listés — pas encore de messages. */
function GroupView(props: { group: Group; onClose: () => void }) {
  const toast = useToast();

  async function remove() {
    try {
      await api.deleteGroup(props.group.id);
      props.onClose();
    } catch (e: unknown) {
      toast(localizeText(e instanceof Error ? e.message : String(e)), true);
    }
  }

  return (
    <>
      <PageHead
        title={props.group.name}
        sub={t("screens.groupSub")}
        actions={
          <>
            <button type="button" className="btn btn-sm chat-back" onClick={props.onClose}>
              <Icon name="back" /> <span className="chat-back-label">{t("chat.back")}</span>
            </button>{" "}
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()}>{t("screens.delete")}</button>
          </>
        }
      />
      <div className="card">
        {props.group.members.map((m) => (
          <p key={m.conversation_id} className="list-meta">
            {m.is_host ? "★ " : ""}{m.name} <span className="list-meta">{m.provider}/{m.model}</span>
          </p>
        ))}
      </div>
      <Empty title={t("screens.groupEmpty")}>{t("screens.groupEmptyHint")}</Empty>
    </>
  );
}
