import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ProviderView } from "../types";
import { Badge, Empty, ErrorText, Field, Modal, PageHead, useToast } from "../ui";
import { Icon } from "../icons";

const APIS = [
  "openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages",
  "google-generative-ai", "azure-openai-responses", "amazon-bedrock", "radius",
];

export default function Providers() {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.providers().then((r) => { setProviders(r.providers); setError(null); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <>
      <PageHead
        title="Fournisseurs"
        sub="Configuration pi : modèles et authentification. Les modifications sont sauvegardées avant écriture."
        actions={<button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" /> Ajouter un fournisseur</button>}
      />
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={refresh}>Réessayer</button> : null}
      {loading ? <p role="status">Chargement…</p> : error && providers.length === 0 ? null : providers.length === 0 ? (
        <Empty title="Aucun fournisseur" action={<button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" /> Ajouter un fournisseur</button>}>
          Aucun fournisseur détecté dans la config pi.
        </Empty>
      ) : (
        <div className="table-wrap" role="region" aria-label="Fournisseurs" tabIndex={0}>
        <table>
          <thead>
            <tr><th>Fournisseur</th><th>Source</th><th>Authentification</th><th>État</th><th>Modèles</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td><Badge>{p.source}</Badge></td>
                <td className="mono">{p.auth.type ?? "—"}</td>
                <td><Badge color={p.auth.ready === true ? "var(--success)" : p.auth.ready === false ? "var(--todo)" : "var(--muted)"}>{p.auth.ready === true ? "Prêt" : p.auth.ready === false ? "À configurer" : "État inconnu"}</Badge></td>
                <td>{p.models.length}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm" onClick={() => setKeyFor(p.id)}>Clé API</button>{" "}
                  {p.source === "custom" ? (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        if (confirm(`Supprimer le fournisseur personnalisé "${p.id}" ?`)) {
                          api.deleteProvider(p.id).then(refresh).catch((e: Error) => toast(e.message, true));
                        }
                      }}
                    >
                      Supprimer
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {showAdd ? <AddProviderModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); refresh(); }} /> : null}
      {keyFor ? <KeyModal providerId={keyFor} onClose={() => setKeyFor(null)} onSaved={() => { setKeyFor(null); refresh(); }} /> : null}
    </>
  );
}

function AddProviderModal(props: { onClose: () => void; onSaved: () => void }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiProt, setApiProt] = useState("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setActionError(null);
    setBusy(true);
    try {
      await api.createProvider({
        id: id.trim(),
        baseUrl: baseUrl.trim(),
        api: apiProt,
        apiKey: apiKey.trim() || undefined,
        models: models.split(",").map((m) => m.trim()).filter(Boolean).map((m) => ({ id: m })),
      });
      props.onSaved();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Opération impossible. Réessaie.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Nouveau fournisseur personnalisé" onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError} />
      <Field label="ID (minuscules, chiffres, -)">
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="ollama" />
      </Field>
      <Field label="URL de base">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" />
      </Field>
      <Field label="Protocole API">
        <select value={apiProt} onChange={(e) => setApiProt(e.target.value)}>
          {APIS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </Field>
      <Field label="Clé API (optionnelle)" hint="Sans clé, aucune authentification n’est créée. Une configuration existante ou une variable reconnue par pi peut être nécessaire.">
        <input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <Field label="Modèles (ids séparés par des virgules)">
        <input value={models} onChange={(e) => setModels(e.target.value)} placeholder="qwen3, llama3.1" />
      </Field>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={busy || !id.trim() || !baseUrl.trim()} onClick={() => void save()}>{busy ? "Création…" : "Créer le fournisseur"}</button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>Annuler</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">Opération en cours. Attends la fin avant de fermer.</p> : null}
    </Modal>
  );
}

function KeyModal(props: { providerId: string; onClose: () => void; onSaved: () => void }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Clé API : ${props.providerId}`} onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError} />
      <Field label="Nouvelle clé (stockée dans auth.json)" hint="Pour l'OAuth (codex, claude…), utilise le flux pi natif (/login dans un terminal).">
        <input type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <div className="toolbar">
        <button
          className="btn btn-primary"
          disabled={busy || !key.trim()}
          onClick={() => {
            if (busy) return;
            setActionError(null);
            setBusy(true);
            api.updateProvider(props.providerId, { apiKey: key.trim() })
              .then(props.onSaved)
              .catch((e: Error) => setActionError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Enregistrement…" : "Enregistrer"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>Annuler</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">Opération en cours. Attends la fin avant de fermer.</p> : null}
    </Modal>
  );
}
