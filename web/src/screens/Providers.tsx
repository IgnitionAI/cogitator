import { t as translate, formatNumber } from "../i18n";
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
        title={translate("screens.providers")}
        sub={translate("screens.providersSub")}
        actions={<button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" /> {translate("screens.addProvider")}</button>}
      />
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={refresh}>{translate("screens.retry")}</button> : null}
      {loading ? <p role="status">{translate("screens.loading")}</p> : error && providers.length === 0 ? null : providers.length === 0 ? (
        <Empty title={translate("screens.noProviders")} action={<button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" /> {translate("screens.addProvider")}</button>}>
          {translate("screens.providersEmpty")}
        </Empty>
      ) : (
        <div className="table-wrap" data-scroll-hint={translate("common.scrollColumns")} role="region" aria-label={translate("screens.providers")} tabIndex={0}>
        <table>
          <thead>
            <tr><th>{translate("screens.provider")}</th><th>{translate("screens.source")}</th><th>{translate("screens.authentication")}</th><th>{translate("screens.state")}</th><th>{translate("screens.models")}</th><th scope="col">{translate("screens.actions")}</th></tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td><Badge>{p.source === "custom" ? translate("screens.custom") : p.source === "builtin" ? translate("screens.builtin") : p.source}</Badge></td>
                <td className="mono">{p.auth.type === "api_key" ? translate("screens.api_key") : p.auth.type === "oauth" ? translate("screens.oauth") : p.auth.type ?? "—"}</td>
                <td><Badge color={p.auth.ready === true ? "var(--success)" : p.auth.ready === false ? "var(--todo)" : "var(--muted)"}>{p.auth.ready === true ? translate("screens.ready") : p.auth.ready === false ? translate("screens.configure") : translate("screens.unknown")}</Badge></td>
                <td>{formatNumber(p.models.length)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm" onClick={() => setKeyFor(p.id)}>{translate("screens.apiKey")}</button>{" "}
                  {p.source === "custom" ? (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        if (confirm(translate("screens.deleteProvider", { name: p.id }))) {
                          api.deleteProvider(p.id).then(refresh).catch((e: Error) => toast(e.message, true));
                        }
                      }}
                    >
                      {translate("screens.delete")}
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
      setActionError(e instanceof Error ? e.message : translate("screens.operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={translate("screens.newProvider")} onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError} />
      <Field label={translate("screens.providerId")}>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="ollama" />
      </Field>
      <Field label={translate("screens.baseUrl")}>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" />
      </Field>
      <Field label={translate("screens.apiProtocol")}>
        <select value={apiProt} onChange={(e) => setApiProt(e.target.value)}>
          {APIS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </Field>
      <Field label={translate("screens.optionalKey")} hint={translate("screens.optionalKeyHint")}>
        <input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <Field label={translate("screens.modelIds")}>
        <input value={models} onChange={(e) => setModels(e.target.value)} placeholder="qwen3, llama3.1" />
      </Field>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={busy || !id.trim() || !baseUrl.trim()} onClick={() => void save()}>{busy ? translate("screens.creating") : translate("screens.createProvider")}</button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>{translate("screens.cancel")}</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">{translate("screens.pending")}</p> : null}
    </Modal>
  );
}

function KeyModal(props: { providerId: string; onClose: () => void; onSaved: () => void }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={translate("screens.keyFor", { name: props.providerId })} onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError} />
      <Field label={translate("screens.newKey")} hint={translate("screens.oauthHint")}>
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
          {busy ? translate("screens.saving") : translate("screens.save")}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>{translate("screens.cancel")}</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">{translate("screens.pending")}</p> : null}
    </Modal>
  );
}
