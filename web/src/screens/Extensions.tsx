import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { ErrorText, PageHead } from "../ui";
import type { PackageCard, PackageState } from "../types";

export default function Extensions() {
  const [state, setState] = useState<PackageState>({ installed: [], operation: null });
  const [cards, setCards] = useState<PackageCard[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("extension");
  const [page, setPage] = useState(1);
  const [next, setNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [deferred, setDeferred] = useState(0);
  const busy = sending || state.operation?.status === "running";
  useEffect(() => {
    let live = true;
    const refresh = () => api.packages().then(value => {
      if (!live) return;
      setState(value); setError(null);
      if (value.operation?.status === "done") setDeferred(value.operation.deferred ?? 0);
    }).catch((e: Error) => { if (live) setError(e.message); });
    void refresh(); const timer = setInterval(refresh, 2000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let live = true;
    setLoading(true); setCatalogError(null);
    api.packageCatalog(search, type, page).then(result => { if (live) { setCards(result.packages); setNext(result.hasNext); } })
      .catch((e: Error) => { if (live) setCatalogError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [search, type, page, revision]);
  async function change(name: string, action: "install" | "remove") {
    setSending(true); setError(null);
    try { const operation = await api.changePackage(name, action); setState(s => ({ ...s, operation })); }
    catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  }
  return <>
    <PageHead title={t("extensions.title")} sub={t("extensions.subtitle")} />
    <p className="muted">{t("extensions.notice")} <a href="https://pi.dev/packages" target="_blank" rel="noreferrer">{t("extensions.source")} ↗</a></p>
    <ErrorText error={error} />
    {state.operation && <div role="status" className="extension-status">
      <strong>{state.operation.name}</strong> — {state.operation.status === "running" ? t("extensions.working") : state.operation.status === "done" ? t("extensions.done") : state.operation.error}
    </div>}
    {deferred > 0 && <p role="status">{t("extensions.deferred", { count: deferred })} <button className="btn" disabled={busy} onClick={async () => {
      try { const result = await api.reloadPackages(); setDeferred(result.deferred); setState(s => ({ ...s, operation: s.operation ? { ...s.operation, deferred: result.deferred } : null })); }
      catch (e) { setError((e as Error).message); }
    }}>{t("extensions.reload")}</button></p>}
    <h2>{t("extensions.installed")}</h2>
    {state.installed.length === 0 ? <p className="muted">{t("extensions.noneInstalled")}</p> : <div className="extensions-grid">
      {state.installed.map(p => <article className="extension-card" key={p.source}>
        <h3>{p.name}</h3><p className="muted">{p.version}</p>
        <button className="btn" disabled={busy || !!error || !p.removable} onClick={() => void change(p.name, "remove")}>{t("extensions.remove")}</button>
      </article>)}
    </div>}
    <h2>{t("extensions.catalog")}</h2>
    <form className="extensions-search" onSubmit={e => { e.preventDefault(); setPage(1); setSearch(query); setRevision(r => r + 1); }}>
      <input aria-label={t("extensions.search")} type="search" value={query} placeholder={t("extensions.search")} onChange={e => setQuery(e.target.value)} />
      <select aria-label={t("extensions.type")} value={type} onChange={e => { setType(e.target.value); setPage(1); }}>
        <option value="extension">{t("extensions.title")}</option><option value="">{t("extensions.all")}</option>
        <option value="skill">{t("extensions.skills")}</option><option value="theme">{t("extensions.themes")}</option><option value="prompt">{t("extensions.prompts")}</option>
      </select><button className="btn" type="submit">{t("extensions.searchButton")}</button>
    </form>
    <ErrorText error={catalogError} />
    {catalogError && <button className="btn" onClick={() => setRevision(r => r + 1)}>{t("screens.retry")}</button>}
    {loading ? <p role="status">{t("screens.loading")}</p> : !catalogError && <>
      {!cards.length && <p>{t("extensions.empty")}</p>}
      <div className="extensions-grid">{cards.map(p => {
        const installed = state.installed.some(i => i.name === p.name);
        return <article className="extension-card" key={p.name}>
          <h3>{p.name}</h3><p>{p.description}</p><small className="muted">{p.types.join(" · ")}</small>
          <div className="extension-actions"><a href={`https://pi.dev/packages/${p.name}`} target="_blank" rel="noreferrer">{t("extensions.details")} ↗</a>
          <button className="btn btn-primary" disabled={busy || !!error || installed} onClick={() => void change(p.name, "install")}>{t(installed ? "extensions.installedLabel" : "extensions.install")}</button></div>
        </article>;
      })}</div>
      <div className="extensions-search"><button className="btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>{t("extensions.previous")}</button><span>{page}</span><button className="btn" disabled={!next} onClick={() => setPage(p => p + 1)}>{t("extensions.next")}</button></div>
    </>}
  </>;
}
