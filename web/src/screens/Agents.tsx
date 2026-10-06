import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AgentPreset, McpServerEntry, ProviderView, SkillRef, SubagentInput } from "../types";
import { Empty, ErrorText, Field, Modal } from "../ui";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PRESET_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "herdr_spawn_agent", "herdr_message_agent", "todo"];

export default function Agents({ toast }: { toast: (t: string, err?: boolean) => void }) {
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [editing, setEditing] = useState<AgentPreset | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.agents().then((r) => setAgents(r.agents as AgentPreset[])).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <>
      <h2>Agents</h2>
      <div className="sub">Un agent = provider + modèle + thinking + skills + MCP + prompt de scope + subagents.</div>
      <ErrorText error={error} />
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setEditing("new")}>+ Nouvel agent</button>
      </div>
      {agents.length === 0 ? (
        <Empty>Aucun agent — crée un preset pour matérialiser des configs complètes en flags pi.</Empty>
      ) : (
        <div className="cards">
          {agents.map((a) => (
            <div key={a.id} className="card" style={{ cursor: "default" }}>
              <h4>{a.name} {a.is_default ? <Badge color="#9a6700">★ défaut</Badge> : null}</h4>
              <div className="meta">
                <span className="mono">{a.provider}/{a.model}{a.thinking ? `:${a.thinking}` : ""}</span>
                <span>{a.skills.length} skill(s) · {a.mcp_servers.length} MCP · {a.subagents?.length ?? 0} subagent(s)</span>
                {a.description ? <span>{a.description.slice(0, 90)}</span> : null}
              </div>
              <div className="actions">
                <button className="btn btn-sm" onClick={() => setEditing(a)}>Éditer</button>{" "}
                {!a.is_default ? (
                  <button className="btn btn-sm" onClick={() => api.setDefaultAgent(a.id).then(refresh).catch((e: Error) => toast(e.message, true))}>Définir défaut</button>
                ) : null}{" "}
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    if (confirm(`Supprimer l'agent "${a.name}" ? Ses définitions herdr noo-* seront retirées.`)) {
                      api.deleteAgent(a.id).then(refresh).catch((e: Error) => toast(e.message, true));
                    }
                  }}
                >
                  Supprimer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing ? (
        <AgentEditor
          agent={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
          toast={toast}
        />
      ) : null}
    </>
  );
}

function AgentEditor(props: { agent: AgentPreset | null; onClose: () => void; onSaved: () => void; toast: (t: string, err?: boolean) => void }) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [skills, setSkills] = useState<SkillRef[]>([]);
  const [form, setForm] = useState({
    name: props.agent?.name ?? "",
    description: props.agent?.description ?? "",
    provider: props.agent?.provider ?? "",
    model: props.agent?.model ?? "",
    thinking: props.agent?.thinking ?? "",
    system_prompt: props.agent?.system_prompt ?? "",
    skills: props.agent?.skills ?? [] as string[],
    tools: (props.agent?.tools_allowlist ?? []).join(", "),
    mcp_servers: props.agent?.mcp_servers ?? [] as McpServerEntry[],
    subagents: (props.agent?.subagents ?? []) as SubagentInput[],
  });
  const [checks, setChecks] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.providers().then((r) => {
      setProviders(r.providers);
      if (!form.provider && r.providers[0]) setForm((f) => ({ ...f, provider: r.providers[0].id }));
    }).catch(() => undefined);
    api.skills().then((r) => setSkills(r.skills)).catch(() => undefined);
  }, []);

  const provider = providers.find((p) => p.id === form.provider);
  const models = provider?.models ?? [];

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const patchMcp = (i: number, patch: Partial<McpServerEntry>) =>
    setForm((f) => ({ ...f, mcp_servers: f.mcp_servers.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const patchSub = (i: number, patch: Partial<SubagentInput>) =>
    setForm((f) => ({ ...f, subagents: f.subagents.map((sa, j) => (j === i ? { ...sa, ...patch } : sa)) }));

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim(),
        provider: form.provider,
        model: form.model || models[0]?.id || "",
        thinking: form.thinking || null,
        system_prompt: form.system_prompt,
        skills: form.skills,
        tools_allowlist: form.tools.trim() ? form.tools.split(",").map((t) => t.trim()).filter(Boolean) : null,
        mcp_servers: form.mcp_servers.filter((m) => m.name && (m.command || m.url)),
        subagents: form.subagents.filter((s) => s.name && s.provider && s.model),
      };
      const r = props.agent
        ? await api.updateAgent(props.agent.id, body)
        : await api.createAgent(body);
      const v = await api.validateAgent(r.agent.id);
      setChecks(v);
      if (v.errors.length === 0) {
        props.toast(props.agent ? "Agent mis à jour + appliqué (herdr)" : "Agent créé + appliqué (herdr)");
        props.onSaved();
      }
    } catch (e) {
      props.toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={props.agent ? `Éditer — ${props.agent.name}` : "Nouvel agent"} onClose={props.onClose} wide>
      <div className="form-grid">
        <Field label="Nom">
          <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="RAG Expert" />
        </Field>
        <Field label="Provider">
          <select value={form.provider} onChange={(e) => set("provider", e.target.value)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.id} {p.auth.ready ? "✓" : "⚠"}</option>)}
          </select>
        </Field>
        <Field label="Modèle">
          <select value={form.model} onChange={(e) => set("model", e.target.value)}>
            <option value="">(défaut du provider)</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        </Field>
        <Field label="Thinking">
          <select value={form.thinking} onChange={(e) => set("thinking", e.target.value)}>
            <option value="">(défaut)</option>
            {THINKING.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Tools allowlist (vide = tous)" hint="Séparés par des virgules">
          <input value={form.tools} onChange={(e) => set("tools", e.target.value)} placeholder="read, bash, edit, write" />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
      </div>
      <Field label="Prompt de scope (system prompt)">
        <textarea value={form.system_prompt} onChange={(e) => set("system_prompt", e.target.value)} placeholder="Tu es l'agent… Ton scope : …" />
      </Field>

      <Field label={`Skills (${form.skills.length} sélectionné(s))`}>
        <div style={{ maxHeight: 150, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
          {skills.map((s) => (
            <label key={s.path} style={{ display: "flex", gap: 6, padding: "2px 4px", fontSize: 12.5 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={form.skills.includes(s.path)}
                onChange={(e) =>
                  set("skills", e.target.checked ? [...form.skills, s.path] : form.skills.filter((p) => p !== s.path))
                }
              />
              <span>{s.name} <span className="muted">{s.description.slice(0, 60)}</span></span>
            </label>
          ))}
        </div>
      </Field>

      <Field label={`Serveurs MCP (${form.mcp_servers.length})`}>
        {form.mcp_servers.map((m, i) => (
          <div key={i} className="subagent-box">
            <div className="form-row">
              <input placeholder="name" value={m.name} onChange={(e) => patchMcp(i, { name: e.target.value })} />
              <input placeholder="command (ex: node) ou url" value={m.command ?? m.url ?? ""} onChange={(e) => patchMcp(i, { command: e.target.value, url: undefined })} />
            </div>
            <div className="toolbar" style={{ marginTop: 6 }}>
              <input placeholder="args (séparés par | )" value={(m.args ?? []).join(" | ")} onChange={(e) => patchMcp(i, { args: e.target.value.split("|").map((x) => x.trim()).filter(Boolean) })} />
              <button className="btn btn-sm btn-danger" onClick={() => set("mcp_servers", form.mcp_servers.filter((_, j) => j !== i))}>Retirer</button>
            </div>
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => set("mcp_servers", [...form.mcp_servers, { name: "" }])}>+ Serveur MCP</button>
      </Field>

      <Field label={`Subagents (${form.subagents.length}) — générés en noo-<agent>-<sub>.md au save`}>
        {form.subagents.map((s, i) => (
          <div key={i} className="subagent-box">
            <div className="form-grid">
              <input placeholder="name (slug)" value={s.name} onChange={(e) => patchSub(i, { name: e.target.value })} />
              <select value={s.provider} onChange={(e) => patchSub(i, { provider: e.target.value })}>
                <option value="">provider…</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
              <input placeholder="model" value={s.model} onChange={(e) => patchSub(i, { model: e.target.value })} />
            </div>
            <div className="toolbar" style={{ marginTop: 6 }}>
              <input placeholder="description" value={s.description ?? ""} onChange={(e) => patchSub(i, { description: e.target.value })} />
              <select value={s.thinking ?? ""} onChange={(e) => patchSub(i, { thinking: e.target.value || null })}>
                <option value="">thinking…</option>
                {THINKING.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button className="btn btn-sm btn-danger" onClick={() => set("subagents", form.subagents.filter((_, j) => j !== i))}>Retirer</button>
            </div>
            <textarea placeholder="system prompt du subagent" value={s.system_prompt ?? ""} onChange={(e) => patchSub(i, { system_prompt: e.target.value })} style={{ marginTop: 6, minHeight: 50 }} />
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => set("subagents", [...form.subagents, { name: "", provider: form.provider, model: form.model }])}>+ Subagent</button>
      </Field>

      {checks ? (
        <div className="checks">
          {checks.errors.map((e) => <div key={e} className="err">✗ {e}</div>)}
          {checks.warnings.map((w) => <div key={w} className="warn">⚠ {w}</div>)}
          {checks.errors.length === 0 ? <div style={{ color: "var(--ok)" }}>✓ Valide</div> : null}
        </div>
      ) : null}

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !form.name.trim()}>
          {busy ? "Sauvegarde + Apply…" : "Sauvegarder + Apply"}
        </button>
      </div>
    </Modal>
  );
}
