import { t as translate, formatNumber } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Health } from "../types";
import { Badge, ErrorText, Field, PageHead, Spinner } from "../ui";

export default function Settings() {
  const [health, setHealth] = useState<Health | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.health().then(setHealth),
      api.mcp().then((config) => setDraft(JSON.stringify(config, null, 2))),
    ]).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const saveMcp = async () => {
    if (draft === null || busy) return;
    setError(null);
    setSaved(false);
    let config: unknown;
    try {
      config = JSON.parse(draft);
    } catch {
      setError(translate("screens.invalidJson"));
      return;
    }
    setBusy(true);
    try {
      await api.saveMcp(config);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? translate("screens.saveRejectedDetail", { error: e.message }) : translate("screens.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title={translate("screens.settings")} sub={translate("screens.settingsSub")} />
      {loading ? <p role="status">{translate("screens.loadingConfig")}</p> : null}
      {error && (draft === null || health === null) ? <button type="button" className="btn" disabled={loading} onClick={load}>{translate("screens.retryLoad")}</button> : null}
      {health?.mcp_adapter_detected ? (
        <div className="warn-banner" role="status">
          <code>pi-mcp-adapter</code> {translate("screens.adapterHint")}
        </div>
      ) : null}
      {health ? (
        <div className="table-wrap" data-scroll-hint={translate("common.scrollColumns")} style={{ maxWidth: 640 }}>
          <table><tbody>
            <tr><td className="muted">{translate("screens.version")}</td><td className="mono">{health.version}</td></tr>
            <tr><td className="muted">{translate("screens.piVersion")}</td><td className="mono">{health.pi_version ?? translate("screens.notFound")}</td></tr>
            <tr><td className="muted">{translate("screens.activeSessions")}</td><td>{formatNumber(health.sessions_active)}</td></tr>
            <tr><td className="muted">{translate("screens.database")}</td><td className="mono">{health.db.path} (v{health.db.version})</td></tr>
            <tr><td className="muted">{translate("screens.panelAddress")}</td><td className="mono">{window.location.origin}</td></tr>
            <tr><td className="muted">{translate("screens.data")}</td><td className="mono">~/.cogitator</td></tr>
          </tbody></table>
        </div>
      ) : null}
      <h2 style={{ marginTop: 24, fontSize: 14 }}>{translate("screens.globalMcp")}</h2>
      <p className="muted">{translate("screens.configOf")} <code>~/.pi/agent/mcp.json</code>{translate("screens.configAvailable")}</p>
      {draft !== null ? (
        <>
          <Field label={translate("screens.jsonConfig")}>
            <textarea className="mono" spellCheck={false} readOnly={busy || loading} aria-busy={busy} style={{ minHeight: 200 }} value={draft}
              onChange={(e) => { setDraft(e.target.value); setSaved(false); }} />
          </Field>
          <div className="toolbar">
            <button type="button" className="btn btn-primary" disabled={busy || loading} onClick={() => void saveMcp()}>
              {busy ? <Spinner /> : null} {busy ? translate("screens.saving") : translate("screens.saveConfig")}
            </button>
            {saved ? <span role="status"><Badge color="var(--success)">{translate("screens.configSaved")}</Badge></span> : null}
          </div>
        </>
      ) : null}
      <ErrorText error={error} />
    </>
  );
}
