import { useEffect, useState } from "react";
import { api } from "../api";
import type { Health } from "../types";
import { Badge, Field, PageHead } from "../ui";

export default function Settings() {
  const [health, setHealth] = useState<Health | null>(null);
  const [mcp, setMcp] = useState<{ mcpServers: Record<string, unknown> } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.health().then(setHealth).catch(() => undefined);
    fetch("/api/mcp").then((r) => r.json()).then(setMcp).catch(() => undefined);
  }, []);

  const saveMcp = async () => {
    if (!mcp) return;
    const res = await fetch("/api/mcp", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(mcp) });
    setSaved(res.ok);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <>
      <PageHead title="Settings" sub="État du serveur et configuration globale." />

      {health?.mcp_adapter_detected ? (
        <div className="warn-banner" role="status">
          <code>pi-mcp-adapter</code> est installé : il remplace le support MCP builtin de pi. Les serveurs des presets
          sont enregistrés via <code>registerMcpServer</code>. Vérifie leur visibilité dans une session.
        </div>
      ) : null}

      {health ? (
        <table style={{ maxWidth: 560 }}>
          <tbody>
            <tr><td className="muted">Version Cogitator</td><td className="mono">{health.version}</td></tr>
            <tr><td className="muted">Version pi</td><td className="mono">{health.pi_version ?? "introuvable"}</td></tr>
            <tr><td className="muted">Sessions actives (pool)</td><td>{health.sessions_active}</td></tr>
            <tr><td className="muted">Base SQLite</td><td className="mono">{health.db.path} (v{health.db.version})</td></tr>
            <tr><td className="muted">Port</td><td className="mono">127.0.0.1:5320 (COGITATOR_PORT)</td></tr>
            <tr><td className="muted">Données</td><td className="mono">~/.cogitator</td></tr>
          </tbody>
        </table>
      ) : null}

      <h4 style={{ marginTop: 24 }}>MCP user-level (~/.pi/agent/mcp.json)</h4>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Serveurs disponibles pour toutes les sessions pi (builtin). Les presets peuvent définir leurs propres serveurs via l'éditeur d'agents.
      </p>
      {mcp ? (
        <>
          <Field label="JSON (mcpServers)">
            <textarea
              className="mono"
              style={{ minHeight: 200 }}
              value={JSON.stringify(mcp, null, 2)}
              onChange={(e) => {
                try {
                  setMcp(JSON.parse(e.target.value));
                } catch {
                  /* JSON en cours d'édition */
                }
              }}
            />
          </Field>
          <div className="toolbar">
            <button className="btn btn-primary" onClick={() => void saveMcp()}>Enregistrer (atomic + backup)</button>
            {saved ? <Badge color="#1a7f37">✓ sauvegardé</Badge> : null}
          </div>
        </>
      ) : null}
    </>
  );
}
