import { t as translate, localizeText, formatNumber, thinkingLabel, getLocale } from "../i18n";
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
        title={translate("screens.agents")}
        sub={translate("screens.agentsSub")}
        actions={
          <>
            <button type="button" className="btn" onClick={() => setShowImport(true)}><Icon name="download" /> {translate("screens.importSkills")}</button>
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}><Icon name="plus" /> {translate("screens.newAgent")}</button>
          </>
        }
      />
      <ErrorText error={error ? localizeText(error) : null} />
      {error ? <button type="button" className="btn" onClick={refresh}>{translate("screens.retry")}</button> : null}
      {loading ? <p role="status">{translate("screens.loading")}</p> : error && agents.length === 0 ? null : agents.length === 0 ? (
        <Empty title={translate("screens.noAgents")} action={<button type="button" className="btn btn-primary" onClick={() => setEditing("new")}><Icon name="plus" /> {translate("screens.newAgent")}</button>}>
          {translate("screens.agentEmpty")}
        </Empty>
      ) : (
        <div className="cards">
          {agents.map((a) => (
            <div key={a.id} className="card" style={{ cursor: "default" }}>
              <h2>{a.name} {a.is_default ? <Badge color="var(--todo)">{translate("screens.default")}</Badge> : null}</h2>
              <div className="meta">
                <span>{translate("screens.agentCounts", { skills: formatNumber(a.skills.length), mcp: formatNumber(a.mcp_servers.length), subagents: formatNumber(a.subagents?.length ?? 0) })}</span>
                {a.description ? <span>{a.description.slice(0, 90)}</span> : null}
              </div>
              <QuickModel
                agent={a}
                providers={providers}
                onChanged={() => { refresh(); toast(translate("screens.modelUpdated", { name: a.name })); }}
              />
              <div className="actions">
                <button className="btn btn-sm" onClick={() => setEditing(a)}>{translate("screens.edit")}</button>{" "}
                {!a.is_default ? (
                  <button className="btn btn-sm" onClick={() => api.setDefaultAgent(a.id).then(refresh).catch((e: Error) => toast(localizeText(e.message), true))}>{translate("screens.setDefault")}</button>
                ) : null}{" "}
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    if (confirm(translate("screens.deleteAgent", { name: a.name }))) {
                      api.deleteAgent(a.id).then(refresh).catch((e: Error) => toast(localizeText(e.message), true));
                    }
                  }}
                >
                  {translate("screens.delete")}
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
      toast(localizeText((e as Error).message), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <p className="muted">{translate("screens.quickModel")}</p>
      <div className="form-row">
      <select
        value={agent.provider}
        onChange={(e) => {
          const nextProvider = providers.find((p) => p.id === e.target.value);
          void switchTo(e.target.value, nextProvider?.models[0]?.id ?? "");
        }}
        aria-label={translate("screens.agentProvider", { name: agent.name })}
        disabled={busy}
        title={translate("screens.provider")}
      >
        {!provider ? <option value={agent.provider}>{agent.provider} {translate("screens.unavailable")}</option> : null}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id} {p.auth.ready === true ? translate("screens.readyParen") : p.auth.ready === false ? translate("screens.authParen") : translate("screens.unknownParen")}
          </option>
        ))}
      </select>
      <select
        value={agent.model}
        onChange={(e) => void switchTo(agent.provider, e.target.value)}
        aria-label={translate("screens.agentModel", { name: agent.name })}
        disabled={busy}
        title={translate("screens.model")}
      >
        {!models.some((m) => m.id === agent.model) ? <option value={agent.model}>{agent.model}</option> : null}
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: string[]; skipped: string[] } | null>(null);

  const run = async () => {
    if (busy) return;
    setActionError(null);
    setBusy(true);
    setResult(null);
    try {
      const r = await api.importSkills(source.trim(), overwrite);
      setResult(r);
      toast(translate("screens.importResult", { imported: formatNumber(r.imported.length), skipped: formatNumber(r.skipped.length) }));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : translate("screens.operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={translate("screens.importSkills")} onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError ? localizeText(actionError) : null} />
      <Field label={translate("screens.source")} hint={translate("screens.sourceHint")}>
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="IgnitionAI/skills" />
      </Field>
      <label style={{ display: "flex", gap: 8, marginBottom: 14, fontSize: 13 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
        {translate("screens.overwrite")}
      </label>
      {result ? (
        <div className="checks" style={{ marginBottom: 12 }}>
          {result.imported.map((s) => <div key={s} style={{ color: "var(--success)" }}>✓ {s}</div>)}
          {result.skipped.map((s) => <div key={s} className="warn">≡ {s} {translate("screens.skippedExisting")}</div>)}
        </div>
      ) : null}
      <div className="toolbar">
        <button className="btn btn-primary" disabled={!source.trim() || busy} onClick={() => void run()}>
          {busy ? translate("screens.importing") : translate("screens.importDestination")}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>{translate("screens.cancel")}</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">{translate("screens.pending")}</p> : null}
    </Modal>
  );
}

function AgentEditor(props: { agent: AgentPreset | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [actionError, setActionError] = useState<string | null>(null);
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
      ...form.mcp_servers.flatMap((m, i) => !m.name.trim() || !(m.command?.trim() || m.url?.trim()) ? [translate("screens.mcpRequired", { number: formatNumber(i + 1) })] : []),
      ...form.subagents.flatMap((s, i) => !s.name.trim() || !s.provider.trim() || !s.model.trim() ? [translate("screens.subRequired", { number: formatNumber(i + 1) })] : []),
    ];
    if (errors.length) { setChecks({ errors, warnings: [] }); return; }
    setChecks(null);
    setSaveNotice(null);
    setActionError(null);
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
      setSaveNotice(translate("screens.savedValidating"));
      const v = await api.validateAgent(r.agent.id);
      setSaveNotice(v.errors.length ? translate("screens.savedInvalid") : translate("screens.savedValid"));
      setChecks(v);
      if (v.errors.length === 0) {
        toast(props.agent ? translate("screens.agentUpdated") : translate("screens.agentCreated"));
        props.onSaved();
      }
    } catch (e) {
      if (persisted) setSaveNotice(translate("screens.validationUnavailable"));
      setActionError(e instanceof Error ? e.message : translate("screens.operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={props.agent ? translate("screens.editNamed", { name: props.agent.name }) : translate("screens.newAgent")} onClose={() => { if (!busy) props.onClose(); }} wide>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError ? localizeText(actionError) : null} />
      <ErrorText error={loadError ? localizeText(loadError) : null} />
      {loadError ? <button type="button" className="btn" onClick={loadOptions}>{translate("screens.retryOptions")}</button> : null}
      {optionsLoading ? <p role="status">{translate("screens.loadingOptions")}</p> : null}
      <div className="form-grid">
        <Field label={translate("screens.name")}>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={translate("screens.agentExample")} />
        </Field>
        <Field label={translate("screens.provider")}>
          <select value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value, model: "" }))}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.id} {p.auth.ready === true ? translate("screens.readyParen") : p.auth.ready === false ? translate("screens.authParen") : translate("screens.unknownParen")}</option>)}
          </select>
        </Field>
        <Field label={translate("screens.model")}>
          <select value={form.model} onChange={(e) => set("model", e.target.value)}>
            <option value="">{translate("screens.providerDefault")}</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        </Field>
        <Field label={translate("screens.thinking")}>
          <select value={form.thinking} onChange={(e) => set("thinking", e.target.value)}>
            <option value="">{translate("screens.defaultParen")}</option>
            {THINKING_LEVELS.map((t) => <option key={t} value={t}>{thinkingLabel(t)}</option>)}
          </select>
        </Field>
        <Field label={translate("screens.tools")} hint={translate("screens.commaHint")}>
          <input value={form.tools} onChange={(e) => set("tools", e.target.value)} placeholder="read, bash, edit, write" />
        </Field>
        <Field label={translate("screens.description")}>
          <input value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
      </div>
      <Field label={translate("screens.scope")}>
        <textarea value={form.system_prompt} onChange={(e) => set("system_prompt", e.target.value)} placeholder={translate("screens.scopeExample")} />
      </Field>

      <fieldset className="field">
        <legend>{translate("screens.selectedSkills", { count: formatNumber(form.skills.length) })}</legend>
        <input aria-label={translate("screens.searchSkill")} type="search" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} placeholder={translate("screens.searchSkillPlaceholder")} />
        <div style={{ maxHeight: 150, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
          {skills.filter((s) => `${s.name} ${s.description}`.toLocaleLowerCase(getLocale()).includes(skillQuery.toLocaleLowerCase(getLocale()))).map((s) => (
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
        <legend>{translate("screens.mcpCount", { count: formatNumber(form.mcp_servers.length) })}</legend>
        {form.mcp_servers.map((m, i) => (
          <div key={i} className="subagent-box">
            <div className="form-row">
              <input aria-label={translate("screens.mcpName", { number: formatNumber(i + 1) })} placeholder={translate("screens.mcpNamePlaceholder")} value={m.name} onChange={(e) => patchMcp(i, { name: e.target.value })} />
              <input aria-label={translate("screens.mcpCommand", { number: formatNumber(i + 1) })} placeholder={translate("screens.mcpCommandPlaceholder")} value={m.command ?? m.url ?? ""} onChange={(e) => { const value = e.target.value.trim(); patchMcp(i, /^https?:\/\//i.test(value) ? { url: value, command: undefined, args: undefined } : { command: e.target.value, url: undefined }); }} />
            </div>
            <div className="toolbar" style={{ marginTop: 6 }}>
              <input aria-label={translate("screens.mcpArgs", { number: formatNumber(i + 1) })} placeholder={translate("screens.argsPlaceholder")} value={(m.args ?? []).join(" | ")} onChange={(e) => patchMcp(i, { args: e.target.value.split("|").map((x) => x.trim()).filter(Boolean) })} />
              <button className="btn btn-sm btn-danger" onClick={() => set("mcp_servers", form.mcp_servers.filter((_, j) => j !== i))}>{translate("screens.remove")}</button>
            </div>
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => set("mcp_servers", [...form.mcp_servers, { name: "" }])}>{translate("screens.addMcp")}</button>
      </fieldset>

      <fieldset className="field">
        <legend>{translate("screens.subCount", { count: formatNumber(form.subagents.length) })}</legend>
        {form.subagents.map((s, i) => (
          <div key={i} className="subagent-box">
            <div className="form-grid">
              <input aria-label={translate("screens.subName", { number: formatNumber(i + 1) })} placeholder={translate("screens.slugPlaceholder")} value={s.name} onChange={(e) => patchSub(i, { name: e.target.value })} />
              <select aria-label={translate("screens.subProvider", { number: formatNumber(i + 1) })} value={s.provider} onChange={(e) => patchSub(i, { provider: e.target.value, model: "" })}>
                <option value="">{translate("screens.providerPlaceholder")}</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
              <input aria-label={translate("screens.subModel", { number: formatNumber(i + 1) })} placeholder={translate("screens.modelPlaceholder")} value={s.model} onChange={(e) => patchSub(i, { model: e.target.value })} />
            </div>
            <div className="toolbar" style={{ marginTop: 6 }}>
              <input aria-label={translate("screens.subDescription", { number: formatNumber(i + 1) })} placeholder={translate("screens.descriptionPlaceholder")} value={s.description ?? ""} onChange={(e) => patchSub(i, { description: e.target.value })} />
              <select aria-label={translate("screens.subThinking", { number: formatNumber(i + 1) })} value={s.thinking ?? ""} onChange={(e) => patchSub(i, { thinking: e.target.value || null })}>
                <option value="">{translate("screens.thinkingPlaceholder")}</option>
                {THINKING_LEVELS.map((t) => <option key={t} value={t}>{thinkingLabel(t)}</option>)}
              </select>
              <button className="btn btn-sm btn-danger" onClick={() => set("subagents", form.subagents.filter((_, j) => j !== i))}>{translate("screens.remove")}</button>
            </div>
            <textarea aria-label={translate("screens.subPrompt", { number: formatNumber(i + 1) })} placeholder={translate("screens.subPromptPlaceholder")} value={s.system_prompt ?? ""} onChange={(e) => patchSub(i, { system_prompt: e.target.value })} style={{ marginTop: 6, minHeight: 50 }} />
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => set("subagents", [...form.subagents, { name: "", provider: form.provider, model: form.model }])}>{translate("screens.addSubagent")}</button>
      </fieldset>

      <p className="muted">{translate("screens.validationHint")}</p>
      {saveNotice ? <p role="status">{localizeText(saveNotice)}</p> : null}
      {checks ? (
        <div className="checks" role="status">
          {checks.errors.map((e) => <div key={e} className="err">✗ {localizeText(e)}</div>)}
          {checks.warnings.map((w) => <div key={w} className="warn">⚠ {localizeText(w)}</div>)}
          {checks.errors.length === 0 ? <div style={{ color: "var(--success)" }}>{translate("screens.valid")}</div> : null}
        </div>
      ) : null}

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy || optionsLoading || !!loadError || !form.name.trim() || !form.provider || !(form.model || models[0]?.id)}>
          {busy ? translate("screens.savingApplying") : translate("screens.saveApply")}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>{translate("screens.cancel")}</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">{translate("screens.pending")}</p> : null}
    </Modal>
  );
}
