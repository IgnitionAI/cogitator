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
      fetch("/api/mcp").then(async (res) => {
        if (!res.ok) throw new Error("Configuration MCP indisponible.");
        setDraft(JSON.stringify(await res.json(), null, 2));
      }),
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
      setError("JSON invalide. Vérifie les virgules, guillemets et accolades, puis réessaie.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/mcp", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error("Enregistrement refusé. Vérifie la configuration MCP puis réessaie.");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enregistrement impossible. Réessaie sans quitter la page.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Paramètres" sub="État du serveur et configuration globale." />
      {loading ? <p role="status">Chargement de la configuration…</p> : null}
      {error && (draft === null || health === null) ? <button type="button" className="btn" disabled={loading} onClick={load}>Réessayer le chargement</button> : null}
      {health?.mcp_adapter_detected ? (
        <div className="warn-banner" role="status">
          <code>pi-mcp-adapter</code> remplace le support MCP intégré de pi. Vérifie la visibilité des serveurs dans une session.
        </div>
      ) : null}
      {health ? (
        <div className="table-wrap" style={{ maxWidth: 640 }}>
          <table><tbody>
            <tr><td className="muted">Version Cogitator</td><td className="mono">{health.version}</td></tr>
            <tr><td className="muted">Version pi</td><td className="mono">{health.pi_version ?? "introuvable"}</td></tr>
            <tr><td className="muted">Sessions actives</td><td>{health.sessions_active}</td></tr>
            <tr><td className="muted">Base SQLite</td><td className="mono">{health.db.path} (v{health.db.version})</td></tr>
            <tr><td className="muted">Adresse du panneau</td><td className="mono">{window.location.origin}</td></tr>
            <tr><td className="muted">Données</td><td className="mono">~/.cogitator</td></tr>
          </tbody></table>
        </div>
      ) : null}
      <h2 style={{ marginTop: 24, fontSize: 14 }}>Serveurs MCP globaux</h2>
      <p className="muted">Configuration de <code>~/.pi/agent/mcp.json</code>, disponible pour toutes les sessions pi.</p>
      {draft !== null ? (
        <>
          <Field label="Configuration JSON (mcpServers)">
            <textarea className="mono" spellCheck={false} readOnly={busy || loading} aria-busy={busy} style={{ minHeight: 200 }} value={draft}
              onChange={(e) => { setDraft(e.target.value); setSaved(false); }} />
          </Field>
          <div className="toolbar">
            <button type="button" className="btn btn-primary" disabled={busy || loading} onClick={() => void saveMcp()}>
              {busy ? <Spinner /> : null} {busy ? "Enregistrement…" : "Enregistrer la configuration"}
            </button>
            {saved ? <span role="status"><Badge color="var(--success)">Configuration enregistrée</Badge></span> : null}
          </div>
        </>
      ) : null}
      <ErrorText error={error} />
    </>
  );
}
