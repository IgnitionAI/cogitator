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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([api.agents(), api.providers()]).then(([a, p]) => { setAgents(a.agents); setProviders(p.providers); setError(null); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
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
      {error ? <button type="button" className="btn" onClick={refresh}>Réessayer</button> : null}
      {loading ? <p role="status">Chargement…</p> : error && agents.length === 0 ? null : agents.length === 0 ? (
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
  const [busy, setBusy] = useState(false);

  const switchTo = async (providerId: string, modelId: string) => {
    if (busy) return;
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <p className="muted">Provider et modèle : chaque changement est enregistré immédiatement.</p>
      <div className="form-row">
      <select
        value={agent.provider}
        onChange={(e) => {
          const nextProvider = providers.find((p) => p.id === e.target.value);
          void switchTo(e.target.value, nextProvider?.models[0]?.id ?? "");
        }}
        aria-label={`Provider de ${agent.name}`}
        disabled={busy}
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
        aria-label={`Modèle de ${agent.name}`}
        disabled={busy}
        title="Modèle"
      >
        {models.length === 0 ? <option value={agent.model}>{agent.model}</option> : null}
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.id}</option>
        ))}
      </select>
      </div>
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
          {result.imported.map((s) => <div key={s} style={{ color: "var(--success)" }}>✓ {s}</div>)}
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
  const [savedId, setSavedId] = useState(props.agent?.id ?? null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [checks, setChecks] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadOptions = useCallback(() => {
    setOptionsLoading(true);
    setLoadError(null);
    Promise.all([api.providers(), api.skills()]).then(([p, sk]) => {
      setProviders(p.providers);
      setSkills(sk.skills);
      const first = p.providers[0];
      if (first) setForm((f) => f.provider ? f : { ...f, provider: first.id, model: "" });
    }).catch((e: Error) => setLoadError(e.message)).finally(() => setOptionsLoading(false));
  }, []);
  useEffect(loadOptions, [loadOptions]);

  const provider = providers.find((p) => p.id === form.provider);
  const models = provider?.models ?? [];

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const patchMcp = (i: number, patch: Partial<McpServerEntry>) =>
    setForm((f) => ({ ...f, mcp_servers: f.mcp_servers.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const patchSub = (i: number, patch: Partial<SubagentInput>) =>
    setForm((f) => ({ ...f, subagents: f.subagents.map((sa, j) => (j === i ? { ...sa, ...patch } : sa)) }));

  const save = async () => {
    if (busy) return;
    const errors = [
      ...form.mcp_servers.flatMap((m, i) => !m.name.trim() || !(m.command?.trim() || m.url?.trim()) ? [`MCP ${i + 1} : nom et commande ou URL requis. Retire la ligne si elle est inutile.`] : []),
      ...form.subagents.flatMap((s, i) => !s.name.trim() || !s.provider.trim() || !s.model.trim() ? [`Subagent ${i + 1} : nom, provider et modèle requis. Retire la ligne si elle est inutile.`] : []),
    ];
    if (errors.length) { setChecks({ errors, warnings: [] }); return; }
    setChecks(null);
    setSaveNotice(null);
    setBusy(true);
    let persisted = false;
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
        mcp_servers: form.mcp_servers,
        subagents: form.subagents,
      };
      const r = savedId
        ? await api.updateAgent(savedId, body)
        : await api.createAgent(body);
      persisted = true;
      setSavedId(r.agent.id);
      setSaveNotice("Agent enregistré et définitions appliquées. Validation en cours…");
      const v = await api.validateAgent(r.agent.id);
      setSaveNotice(v.errors.length ? "Agent enregistré et appliqué, mais invalide : corrige les erreurs puis sauvegarde à nouveau." : "Agent enregistré, appliqué et validé.");
      setChecks(v);
      if (v.errors.length === 0) {
        toast(props.agent ? "Agent mis à jour + appliqué (herdr)" : "Agent créé + appliqué (herdr)");
        props.onSaved();
      }
    } catch (e) {
      if (persisted) setSaveNotice("Agent enregistré et appliqué, mais validation indisponible. La sauvegarde n’a pas été annulée.");
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={props.agent ? `Éditer — ${props.agent.name}` : "Nouvel agent"} onClose={props.onClose} wide>
      <ErrorText error={loadError} />
      {loadError ? <button type="button" className="btn" onClick={loadOptions}>Réessayer le chargement des providers et skills</button> : null}
      {optionsLoading ? <p role="status">Chargement des providers et skills…</p> : null}
      <div className="form-grid">
        <Field label="Nom">
          <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="RAG Expert" />
        </Field>
        <Field label="Provider">
          <select value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value, model: "" }))}>
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

      <fieldset className="field">
        <legend>Skills ({form.skills.length} sélectionné(s))</legend>
        <input aria-label="Rechercher un skill" type="search" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} placeholder="Rechercher un skill…" />
        <div style={{ maxHeight: 150, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
          {skills.filter((s) => `${s.name} ${s.description}`.toLocaleLowerCase().includes(skillQuery.toLocaleLowerCase())).map((s) => (
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
      </fieldset>

      <fieldset className="field">
        <legend>Serveurs MCP ({form.mcp_servers.length})</legend>
        {form.mcp_servers.map((m, i) => (
          <div key={i} className="subagent-box">
            <div className="form-row">
              <input aria-label={`Nom MCP ${i + 1}`} placeholder="name" value={m.name} onChange={(e) => patchMcp(i, { name: e.target.value })} />
              <input aria-label={`Commande ou URL MCP ${i + 1}`} placeholder="command (ex: node) ou url" value={m.command ?? m.url ?? ""} onChange={(e) => { const value = e.target.value.trim(); patchMcp(i, /^https?:\/\//i.test(value) ? { url: value, command: undefined, args: undefined } : { command: e.target.value, url: undefined }); }} />
            </div>
            <div className="toolbar" style={{ marginTop: 6 }}>
              <input aria-label={`Arguments MCP ${i + 1}`} placeholder="args (séparés par | )" value={(m.args ?? []).join(" | ")} onChange={(e) => patchMcp(i, { args: e.target.value.split("|").map((x) => x.trim()).filter(Boolean) })} />
              <button className="btn btn-sm btn-danger" onClick={() => set("mcp_servers", form.mcp_servers.filter((_, j) => j !== i))}>Retirer</button>
            </div>
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => set("mcp_servers", [...form.mcp_servers, { name: "" }])}>+ Serveur MCP</button>
      </fieldset>

      <fieldset className="field">
        <legend>Subagents ({form.subagents.length}) — définitions générées à la sauvegarde</legend>
        {form.subagents.map((s, i) => (
          <div key={i} className="subagent-box">
            <div className="form-grid">
              <input aria-label={`Nom du subagent ${i + 1}`} placeholder="name (slug)" value={s.name} onChange={(e) => patchSub(i, { name: e.target.value })} />
              <select aria-label={`Provider du subagent ${i + 1}`} value={s.provider} onChange={(e) => patchSub(i, { provider: e.target.value, model: "" })}>
                <option value="">provider…</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
              <input aria-label={`Modèle du subagent ${i + 1}`} placeholder="model" value={s.model} onChange={(e) => patchSub(i, { model: e.target.value })} />
            </div>
            <div className="toolbar" style={{ marginTop: 6 }}>
              <input aria-label={`Description du subagent ${i + 1}`} placeholder="description" value={s.description ?? ""} onChange={(e) => patchSub(i, { description: e.target.value })} />
              <select aria-label={`Thinking du subagent ${i + 1}`} value={s.thinking ?? ""} onChange={(e) => patchSub(i, { thinking: e.target.value || null })}>
                <option value="">thinking…</option>
                {THINKING_LEVELS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button className="btn btn-sm btn-danger" onClick={() => set("subagents", form.subagents.filter((_, j) => j !== i))}>Retirer</button>
            </div>
            <textarea aria-label={`Prompt du subagent ${i + 1}`} placeholder="system prompt du subagent" value={s.system_prompt ?? ""} onChange={(e) => patchSub(i, { system_prompt: e.target.value })} style={{ marginTop: 6, minHeight: 50 }} />
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => set("subagents", [...form.subagents, { name: "", provider: form.provider, model: form.model }])}>+ Subagent</button>
      </fieldset>

      <p className="muted">La validation serveur intervient après enregistrement et application des définitions.</p>
      {saveNotice ? <p role="status">{saveNotice}</p> : null}
      {checks ? (
        <div className="checks">
          {checks.errors.map((e) => <div key={e} className="err">✗ {e}</div>)}
          {checks.warnings.map((w) => <div key={w} className="warn">⚠ {w}</div>)}
          {checks.errors.length === 0 ? <div style={{ color: "var(--success)" }}>✓ Valide</div> : null}
        </div>
      ) : null}

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy || optionsLoading || !!loadError || !form.name.trim() || !form.provider || !(form.model || models[0]?.id)}>
          {busy ? "Sauvegarde + Apply…" : "Sauvegarder + Apply"}
        </button>
      </div>
    </Modal>
  );
}
