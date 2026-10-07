import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { THINKING_LEVELS } from "../types";
import type { AgentPreset, McpServerEntry, ProviderView, SkillRef, SubagentInput } from "../types";
import { Badge, Empty, ErrorText, Field, Modal, PageHead, useToast } from "../ui";
import { Icon } from "../icons";

export default function Agents() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [editing, setEditing] = useState<AgentPreset | "new" | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.agents().then((r) => setAgents(r.agents)).catch((e: Error) => setError(e.message));
    api.providers().then((r) => setProviders(r.providers)).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <>
      <PageHead
        title="Agents"
        sub="Un agent = provider + modèle + thinking + skills + MCP + prompt de scope + subagents."
        actions={
          <>
            <button type="button" className="btn" onClick={() => setShowImport(true)}><Icon name="download" /> Importer des skills</button>
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}><Icon name="plus" /> Nouvel agent</button>
          </>
        }
      />
      <ErrorText error={error} />
      {agents.length === 0 ? (
        <Empty title="Aucun agent" action={<button type="button" className="btn btn-primary" onClick={() => setEditing("new")}><Icon name="plus" /> Nouvel agent</button>}>
          Crée un preset pour matérialiser une config complète en flags pi.
        </Empty>
      ) : (
        <div className="cards">
          {agents.map((a) => (
            <div key={a.id} className="card" style={{ cursor: "default" }}>
              <h4>{a.name} {a.is_default ? <Badge color="#9a6700">★ défaut</Badge> : null}</h4>
              <div className="meta">
                <span>{a.skills.length} skill(s) · {a.mcp_servers.length} MCP · {a.subagents?.length ?? 0} subagent(s)</span>
                {a.description ? <span>{a.description.slice(0, 90)}</span> : null}
              </div>
              <QuickModel
                agent={a}
                providers={providers}
                onChanged={() => { refresh(); toast(`${a.name} : modèle mis à jour`); }}
              />
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
         
        />
      ) : null}
      {showImport ? <ImportSkillsModal onClose={() => setShowImport(false)} /> : null}
    </>
  );
}

function QuickModel(props: {
  agent: AgentPreset;
  providers: ProviderView[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const { agent, providers } = props;
  const provider = providers.find((p) => p.id === agent.provider);
  const models = provider?.models ?? [];

  const switchTo = async (providerId: string, modelId: string) => {
    try {
      const full = await api.agent(agent.id); // PUT exige le preset complet : on récupère puis on patch
      await api.updateAgent(agent.id, {
        ...full.agent,
        provider: providerId,
        model: modelId,
      });
      props.onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="form-row" style={{ marginTop: 8 }}>
      <select
        value={agent.provider}
        onChange={(e) => {
          const nextProvider = providers.find((p) => p.id === e.target.value);
          void switchTo(e.target.value, nextProvider?.models[0]?.id ?? "");
        }}
        title="Provider"
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id} {p.auth.ready ? "✓" : "⚠"}
          </option>
        ))}
      </select>
      <select
        value={agent.model}
        onChange={(e) => void switchTo(agent.provider, e.target.value)}
        title="Modèle"
      >
        {models.length === 0 ? <option value={agent.model}>{agent.model}</option> : null}
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.id}</option>
        ))}
      </select>
    </div>
  );
}

function ImportSkillsModal(props: { onClose: () => void }) {
  const toast = useToast();
  const [source, setSource] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: string[]; skipped: string[] } | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.importSkills(source.trim(), overwrite);
      setResult(r);
      toast(`${r.imported.length} skill(s) importé(s)${r.skipped.length ? `, ${r.skipped.length} ignoré(s)` : ""}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Importer des skills" onClose={props.onClose}>
      <Field label="Source" hint="Repo GitHub (IgnitionAI/skills), chemin local, ou commande CLI : npx aiblueprint-cli@latest skills update">
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="IgnitionAI/skills" />
      </Field>
      <label style={{ display: "flex", gap: 8, marginBottom: 14, fontSize: 13 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
        Écraser les skills existants du même nom
      </label>
      {result ? (
        <div className="checks" style={{ marginBottom: 12 }}>
          {result.imported.map((s) => <div key={s} style={{ color: "var(--ok)" }}>✓ {s}</div>)}
          {result.skipped.map((s) => <div key={s} className="warn">≡ {s} (existant, ignoré)</div>)}
        </div>
      ) : null}
      <div className="toolbar">
        <button className="btn btn-primary" disabled={!source.trim() || busy} onClick={() => void run()}>
          {busy ? "Import…" : "Importer vers ~/.agents/skills"}
        </button>
      </div>
    </Modal>
  );
}

function AgentEditor(props: { agent: AgentPreset | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
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
      const first = r.providers[0];
      if (!form.provider && first) setForm((f) => ({ ...f, provider: first.id }));
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
        toast(props.agent ? "Agent mis à jour + appliqué (herdr)" : "Agent créé + appliqué (herdr)");
        props.onSaved();
      }
    } catch (e) {
      toast((e as Error).message, true);
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
            {THINKING_LEVELS.map((t) => <option key={t} value={t}>{t}</option>)}
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
                {THINKING_LEVELS.map((t) => <option key={t} value={t}>{t}</option>)}
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
