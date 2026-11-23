import { useCallback, useEffect, useRef, useState } from "react";
import { api, vaultApi, type VaultEntry } from "../api";
import { formatDate, formatNumber, localizeText, t } from "../i18n";
import { Icon } from "../icons";
import { Empty, ErrorText, Modal, PageHead, useToast } from "../ui";
import type { AgentPreset } from "../types";

type Access = { allAgents: boolean; agentIds: string[] };
const SITE_EXAMPLE = "https://github.com/login";
const GOOGLE_PASSWORDS = "https://passwords.google.com/options";

/** Choix « tous les agents » ou une sélection rapide d'agents. */
function AccessPicker({ agents, value, onChange, name }: { agents: AgentPreset[]; value: Access; onChange: (next: Access) => void; name: string }) {
  return <fieldset className="vault-access">
    <legend>{t("vault.access")}</legend>
    <div className="vault-access-modes">
      <label><input type="radio" name={name} checked={value.allAgents} onChange={() => onChange({ ...value, allAgents: true })} /> {t("vault.allAgents")}</label>
      <label><input type="radio" name={name} checked={!value.allAgents} onChange={() => onChange({ ...value, allAgents: false })} /> {t("vault.someAgents")}</label>
    </div>
    {!value.allAgents ? <div className="vault-agent-chips">
      {agents.map((a) => {
        const on = value.agentIds.includes(a.id);
        return <button key={a.id} type="button" className={`vault-chip${on ? " is-on" : ""}`} aria-pressed={on}
          onClick={() => onChange({ ...value, agentIds: on ? value.agentIds.filter((id) => id !== a.id) : [...value.agentIds, a.id] })}>
          {on ? <Icon name="check" size={12} /> : null}{a.name}
        </button>;
      })}
      {agents.length > 1 ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...value, agentIds: value.agentIds.length === agents.length ? [] : agents.map((a) => a.id) })}>
        {value.agentIds.length === agents.length ? t("vault.selectNone") : t("vault.selectAll")}
      </button> : null}
    </div> : null}
  </fieldset>;
}

function accessLabel(entry: VaultEntry, agents: AgentPreset[]) {
  if (entry.allAgents) return t("vault.allAgents");
  if (!entry.agentIds.length) return t("vault.nobody");
  const names = entry.agentIds.map((id) => agents.find((a) => a.id === id)?.name).filter(Boolean) as string[];
  return names.length <= 2 ? names.join(", ") : t("vault.agentCount", { count: formatNumber(names.length) });
}

export default function Vault() {
  const toast = useToast();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<VaultEntry | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    Promise.all([vaultApi.list(), api.agents()])
      .then(([v, a]) => { setEntries(v.entries); setAgents(a.agents); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);

  const reveal = async (entry: VaultEntry) => {
    if (revealed[entry.id] !== undefined) { setRevealed(({ [entry.id]: _, ...rest }) => rest); return; }
    try {
      const { password } = await vaultApi.reveal(entry.id);
      setRevealed((r) => ({ ...r, [entry.id]: password }));
      // Masqué de nouveau après 20 secondes.
      setTimeout(() => setRevealed(({ [entry.id]: _, ...rest }) => rest), 20_000);
    } catch (e) { toast(localizeText((e as Error).message), true); }
  };

  const needle = query.trim().toLowerCase();
  const shown = needle ? entries.filter((e) => `${e.name} ${e.host} ${e.username}`.toLowerCase().includes(needle)) : entries;

  return <div className="settings-page">
    <PageHead
      title={t("vault.title")}
      sub={t("vault.sub")}
      actions={<>
        <button type="button" className="btn" onClick={() => setImporting(true)}><Icon name="download" size={14} /> {t("vault.importGoogle")}</button>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}><Icon name="plus" size={14} /> {t("vault.add")}</button>
      </>}
    />
    <ErrorText error={error} />
    <div className="vault-promise">
      <span className="vault-promise-icon" aria-hidden="true"><Icon name="lock" size={16} /></span>
      <p>{t("vault.promise")}</p>
    </div>
    {loading ? <p role="status">{t("common.loading")}</p> : entries.length === 0 ? (
      <Empty title={t("vault.empty")} action={<button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>{t("vault.importGoogle")}</button>}>{t("vault.emptyHint")}</Empty>
    ) : <>
      <div className="vault-toolbar">
        <label className="sr-only" htmlFor="vault-search">{t("vault.search")}</label>
        <input id="vault-search" type="search" value={query} placeholder={t("vault.searchCount", { count: formatNumber(entries.length) })} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <ul className="vault-list" aria-label={t("vault.title")}>
        {shown.map((entry) => <li key={entry.id} className="vault-row">
          <span className="prov-initial" aria-hidden="true">{entry.host.replace(/^www\./, "").charAt(0).toUpperCase()}</span>
          <span className="vault-main">
            <span className="vault-name">{entry.name}</span>
            <span className="muted vault-sub"><span className="mono">{entry.host}</span>{entry.username ? <> · {entry.username}</> : null}</span>
          </span>
          <span className="vault-secret mono" aria-live="polite">{revealed[entry.id] !== undefined ? revealed[entry.id] : "••••••••"}</span>
          <span className="vault-meta muted">
            <span>{accessLabel(entry, agents)}</span>
            <span>{entry.last_used_at ? t("vault.usedOn", { date: formatDate(entry.last_used_at, { dateStyle: "medium" }) }) : t(`vault.source.${entry.source}`)}</span>
          </span>
          <span className="vault-actions">
            <button type="button" className="btn btn-sm" aria-pressed={revealed[entry.id] !== undefined} onClick={() => void reveal(entry)}>{revealed[entry.id] !== undefined ? t("secret.hide") : t("secret.show")}</button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(entry)}>{t("screens.edit")}</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => {
              if (confirm(t("vault.deleteConfirm", { name: entry.name }))) vaultApi.remove(entry.id).then(refresh).catch((e: Error) => toast(localizeText(e.message), true));
            }}>{t("screens.delete")}</button>
          </span>
        </li>)}
      </ul>
    </>}
    {editing ? <EntryModal entry={editing === "new" ? null : editing} agents={agents} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} /> : null}
    {importing ? <ImportModal agents={agents} onClose={() => setImporting(false)} onDone={refresh} /> : null}
  </div>;
}

function EntryModal({ entry, agents, onClose, onSaved }: { entry: VaultEntry | null; agents: AgentPreset[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(entry?.name ?? "");
  const [url, setUrl] = useState(entry?.url ?? "");
  const [username, setUsername] = useState(entry?.username ?? "");
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<Access>({ allAgents: entry?.allAgents ?? false, agentIds: entry?.agentIds ?? [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (entry) await vaultApi.update(entry.id, { name, url, username, ...(password ? { password } : {}), ...access });
      else await vaultApi.create({ name, url, username, password, ...access });
      onSaved();
    } catch (e) { setError(localizeText((e as Error).message)); }
    finally { setBusy(false); }
  };
  return <Modal title={entry ? t("vault.editTitle", { name: entry.name }) : t("vault.add")} onClose={() => { if (!busy) onClose(); }}>
    <form className="form-fields vault-form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="field"><span className="field-label">{t("vault.site")}</span><input required value={url} placeholder={SITE_EXAMPLE} onChange={(e) => setUrl(e.target.value)} /></label>
      <label className="field"><span className="field-label">{t("vault.name")}</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span className="field-label">{t("secret.username")}</span><input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <label className="field"><span className="field-label">{t("secret.password")}</span><input type="password" autoComplete="new-password" required={!entry} value={password} placeholder={entry ? t("vault.unchanged") : ""} onChange={(e) => setPassword(e.target.value)} /></label>
      <AccessPicker agents={agents} value={access} onChange={setAccess} name="vault-entry-access" />
      <ErrorText error={error} />
      <div className="toolbar"><button type="submit" className="btn btn-primary" disabled={busy}>{t("vault.save")}</button></div>
    </form>
  </Modal>;
}

function ImportModal({ agents, onClose, onDone }: { agents: AgentPreset[]; onClose: () => void; onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [access, setAccess] = useState<Access>({ allAgents: false, agentIds: [] });
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: number; updated: number; skipped: number; invalid: number } | null>(null);

  const pick = (f: File | undefined) => {
    if (!f) return;
    setError(null); setResult(null);
    if (f.size > 15 * 1024 * 1024) { setError(t("vault.tooBig")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setCsv({ name: f.name, text, rows: Math.max(0, text.split(/\r?\n/).filter((l) => l.trim()).length - 1) });
    };
    reader.onerror = () => setError(t("vault.readFailed"));
    reader.readAsText(f);
  };
  const run = async () => {
    if (!csv) return;
    setBusy(true); setError(null);
    try {
      setResult(await vaultApi.importGoogle({ csv: csv.text, overwrite, ...access }));
      setCsv(null);
      if (file.current) file.current.value = "";
      onDone();
    } catch (e) {
      const message = (e as Error).message;
      setError(message === "VAULT_IMPORT_FORMAT" ? t("vault.badFormat") : localizeText(message));
    } finally { setBusy(false); }
  };

  return <Modal title={t("vault.importTitle")} onClose={() => { if (!busy) onClose(); }}>
    <div className="vault-import">
      <ol className="vault-steps">
        <li>{t("vault.step1")} <a href={GOOGLE_PASSWORDS} target="_blank" rel="noreferrer">{`${new URL(GOOGLE_PASSWORDS).host} ↗`}</a></li>
        <li>{t("vault.step2")}</li>
        <li>{t("vault.step3")}</li>
      </ol>
      <label className="vault-drop">
        <input ref={file} type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
        <Icon name="files" size={18} />
        <span>{csv ? t("vault.fileReady", { name: csv.name, count: formatNumber(csv.rows) }) : t("vault.pickFile")}</span>
      </label>
      <AccessPicker agents={agents} value={access} onChange={setAccess} name="vault-import-access" />
      <label className="check-row"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> {t("vault.overwrite")}</label>
      <ErrorText error={error} />
      {result ? <div className="vault-result" role="status">
        <p><Icon name="check" size={14} /> {t("vault.imported", { added: formatNumber(result.added), updated: formatNumber(result.updated), skipped: formatNumber(result.skipped), invalid: formatNumber(result.invalid) })}</p>
        <p className="muted">{t("vault.deleteCsv")}</p>
      </div> : null}
      <div className="toolbar">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{result ? t("vault.close") : t("vault.cancel")}</button>
        <button type="button" className="btn btn-primary" disabled={!csv || busy} onClick={() => void run()}>{busy ? t("vault.importing") : t("vault.import")}</button>
      </div>
    </div>
  </Modal>;
}
