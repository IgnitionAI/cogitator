import { t as translate, formatNumber } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEvents } from "../api";
import type { ProviderView } from "../types";
import { Badge, Empty, ErrorText, Field, Modal, PageHead, Skeleton, useToast } from "../ui";
import { Icon } from "../icons";

const APIS = [
  "openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages",
  "google-generative-ai", "azure-openai-responses", "amazon-bedrock", "radius",
];

export default function Providers() {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [showLogin, setShowLogin] = useState<string | true | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    api.providers().then((r) => { setProviders(r.providers); setError(null); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);
  const visible = providers.filter(p => p.id.includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(b.auth.configured || b.auth.ready) - Number(a.auth.configured || a.auth.ready) || a.id.localeCompare(b.id));

  return (
    <>
      <PageHead
        title={translate("screens.providers")}
        sub={translate("screens.providersSub")}
        actions={<button type="button" className="btn btn-primary" onClick={() => setShowLogin(true)}><Icon name="plus" /> {translate("screens.addProvider")}</button>}
      />
      <ErrorText error={error} />
      {error ? <button type="button" className="btn" onClick={refresh}>{translate("screens.retry")}</button> : null}
      {saved ? <p role="status">{translate("screens.providerSaved", { name: saved })}</p> : null}
      <Field label={translate("screens.searchProviders")}>
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} />
      </Field>
      <p className="muted">{translate("screens.providerAvailabilityHint")}</p>
      {loading ? <Skeleton rows={5} /> : error && providers.length === 0 ? null : visible.length === 0 ? (
        <Empty title={translate("screens.noProviderMatch")} action={<button type="button" className="btn" onClick={() => setShowAdd(true)}>{translate("screens.customProvider")}</button>}>
          {translate("screens.providerSearchHint")}
        </Empty>
      ) : (
        <div className="list" aria-label={translate("screens.providers")}>
          {visible.map(p => (
            <div className="list-row provider-row" key={p.id}>
              <div className="provider-name">
                <strong>{p.id}</strong>
                <span className="muted">{translate("screens.providerModelCount", { count: formatNumber(p.models.length) })} · {p.source === "custom" ? translate("screens.custom") : translate("screens.builtin")}</span>
              </div>
              <Badge color={p.auth.ready === true ? "var(--success)" : "var(--muted)"}>
                {p.auth.ready === true ? translate("screens.providerConfigured") : p.auth.configured ? translate("screens.providerCheckNeeded") : translate("screens.configure")}
              </Badge>
              <div className="provider-actions">
                {(p.authMethods?.length ?? 0) > 0 ? (
                  <button type="button" className={`btn btn-sm ${p.auth.configured || p.auth.ready ? "" : "btn-primary"}`} onClick={() => setShowLogin(p.id)}>
                    {p.auth.configured || p.auth.ready ? translate("screens.providerReconnect") : translate("screens.signIn")}
                  </button>
                ) : p.source === "custom" ? <button type="button" className="btn btn-sm" onClick={() => setShowLogin(p.id)}>{translate("screens.apiKey")}</button> : <span className="muted">{translate("screens.providerEnvironment")}</span>}
                {p.source === "custom" ? <button type="button" className="btn btn-sm btn-danger" onClick={() => {
                  if (confirm(translate("screens.deleteProvider", { name: p.id }))) {
                    api.deleteProvider(p.id).then(refresh).catch((e: Error) => toast(e.message, true));
                  }
                }}>{translate("screens.delete")}</button> : null}
              </div>
            </div>
          ))}
        </div>
      )}
      {typeof showLogin === "string" && providers.find(p => p.id === showLogin)?.source === "custom" && !providers.find(p => p.id === showLogin)?.authMethods?.length ? (
        <KeyModal providerId={showLogin} onClose={() => setShowLogin(null)} onSaved={() => { setShowLogin(null); setSaved(showLogin as string); refresh(); }} />
      ) : showLogin ? (
        <LoginModal
          providers={providers}
          initialId={showLogin === true ? undefined : showLogin}
          onClose={() => setShowLogin(null)}
          onCustom={() => { setShowLogin(null); setShowAdd(true); }}
          onSaved={name => { setShowLogin(null); setSaved(name); refresh(); }}
        />
      ) : null}
      {showAdd ? <AddProviderModal onClose={() => setShowAdd(false)} onSaved={name => { setShowAdd(false); setSaved(name); refresh(); }} /> : null}
    </>
  );
}

type LoginEvent = {
  type?: string;
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  links?: Array<{ url: string; label?: string }>;
  prompt?: { type: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> };
};

// Authorization URLs come from the provider SDK; never render executable URL schemes.
function authLink(url?: string): string | undefined {
  if (!url) return;
  try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return; }
}

function LoginModal(props: {
  providers: ProviderView[];
  initialId?: string;
  onClose: () => void;
  onCustom: () => void;
  onSaved: (providerId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProviderView | undefined>(
    props.initialId ? props.providers.find(provider => provider.id === props.initialId) : undefined,
  );
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [connection, setConnection] = useState("connecting");
  const active = useRef(true);
  const sessionRef = useRef<string | null>(null);
  const onSaved = useRef(props.onSaved);
  onSaved.current = props.onSaved;
  const lastPrompt = [...events].reverse().find(event => event.type === "prompt" || event.type === "prompt_clear");
  const prompt = lastPrompt?.type === "prompt" ? lastPrompt.prompt : undefined;
  const authUrl = [...events].reverse().find(event => event.type === "auth_url");
  const device = [...events].reverse().find(event => event.type === "device_code");
  const info = [...events].filter(event => event.type === "info" || event.type === "progress").at(-1);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (sessionRef.current) void api.cancelProviderLogin(sessionRef.current).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    return openEvents(`/api/provider-logins/${session}/events`, event => {
      const next = event as LoginEvent;
      setEvents(current => [...current, next]);
      if (next.type === "done") onSaved.current(selected!.id);
      if (next.type === "error") { setError(next.message ?? translate("screens.operationFailed")); setBusy(false); }
    }, { onStateChange: setConnection });
  }, [session]);

  const start = async (provider: ProviderView, type: "api_key" | "oauth") => {
    if (busy) return;
    setBusy(true); setError(null); setEvents([]); setDraft("");
    try {
      if (sessionRef.current) await api.cancelProviderLogin(sessionRef.current).catch(() => undefined);
      setSession(null); sessionRef.current = null;
      const started = await api.startProviderLogin(provider.id, type);
      if (!active.current) { void api.cancelProviderLogin(started.id).catch(() => undefined); return; }
      sessionRef.current = started.id;
      setSession(started.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : translate("screens.operationFailed")); setBusy(false);
    }
  };

  const reply = async (value: string) => {
    if (!session || sending) return;
    setSending(true); setError(null);
    try { await api.replyProviderLogin(session, value); setDraft(""); }
    catch (e) { setError(e instanceof Error ? e.message : translate("screens.operationFailed")); }
    finally { setSending(false); }
  };
  const methods = selected?.authMethods ?? [];
  const visible = props.providers.filter(provider => (provider.authMethods?.length ?? 0) > 0 && provider.id.includes(query.trim().toLowerCase()));

  return (
    <Modal title={translate("screens.loginTitle")} onClose={props.onClose}>
      <ErrorText error={error} />
      {!selected ? <>
        <Field label={translate("screens.searchProviders")}><input type="search" value={query} onChange={e => setQuery(e.target.value)} autoFocus /></Field>
        <div className="list provider-picker">
          {visible.map(provider => <button key={provider.id} type="button" className="list-row" onClick={() => setSelected(provider)}>
            <span className="mono">{provider.id}</span>
            <Badge>{provider.auth.ready ? translate("screens.providerConfigured") : translate("screens.configure")}</Badge>
          </button>)}
          {visible.length === 0 ? <p className="muted">{translate("screens.noProviderMatch")}</p> : null}
        </div>
        <div className="toolbar"><button type="button" className="btn" onClick={props.onCustom}>{translate("screens.customProvider")}</button><button type="button" className="btn" onClick={props.onClose}>{translate("screens.cancel")}</button></div>
      </> : <>
        <p><strong>{selected.id}</strong></p>
        {!busy ? <>
          <p>{translate("screens.chooseMethod")}</p>
          <div className="toolbar">
            {methods.map(method => <button key={method.type} type="button" className="btn btn-primary" title={method.name} onClick={() => void start(selected, method.type)}>
              {method.type === "api_key" ? translate("screens.providerUseKey") : translate("screens.providerUseAccount")}
            </button>)}
          </div>
        </> : null}
        {session && busy ? <>
          {connection === "reconnecting" ? <p role="status" className="muted">{translate("screens.providerReconnecting")}</p> : null}
          {info?.message ? <p className="muted">{info.message}</p> : null}
          {info?.links?.map(link => authLink(link.url) ? <p key={link.url}><a href={authLink(link.url)} target="_blank" rel="noreferrer">{link.label ?? translate("screens.providerHelp")}</a></p> : null)}
          {authLink(authUrl?.url) ? <p><a className="btn btn-primary" href={authLink(authUrl?.url)} target="_blank" rel="noreferrer">{translate("screens.openAuthUrl")}</a></p> : null}
          {device?.userCode ? <p>{translate("screens.deviceCode", { code: device.userCode })} {authLink(device.verificationUri) ? <a href={authLink(device.verificationUri)} target="_blank" rel="noreferrer">{translate("screens.openAuthUrl")}</a> : null}</p> : null}
          {authUrl || device ? <p className="muted">{translate("screens.providerBrowserHint")}</p> : null}
          {prompt ? <form onSubmit={e => { e.preventDefault(); void reply(draft.trim()); }}>
            {prompt.type === "select" ? <Field label={prompt.message}>
              <select disabled={sending} value={draft} onChange={e => setDraft(e.target.value)} autoFocus>
                <option value="" disabled>{translate("screens.chooseMethod")}</option>
                {prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </Field> : <Field label={prompt.type === "secret" ? translate("screens.apiKey") : prompt.message} hint={prompt.type === "secret" ? translate("screens.providerKeyHint") : undefined}>
              <input type={prompt.type === "secret" ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={prompt.placeholder} value={draft} onChange={e => setDraft(e.target.value)} disabled={sending} autoFocus />
            </Field>}
            <button type="submit" className="btn btn-primary" disabled={sending || (prompt.type !== "text" && !draft.trim())}>{sending ? translate("screens.saving") : translate("screens.continueLogin")}</button>
          </form> : <p role="status" className="muted">{translate("screens.pending")}</p>}
        </> : busy ? <p role="status">{translate("screens.pending")}</p> : null}
        <div className="toolbar provider-login-footer">
          {!busy ? <button type="button" className="btn" onClick={() => { setSelected(undefined); setError(null); }}>{translate("screens.providerChange")}</button> : null}
          <button type="button" className="btn" onClick={props.onClose}>{translate("screens.cancel")}</button>
        </div>
      </>}
    </Modal>
  );
}

function AddProviderModal(props: { onClose: () => void; onSaved: (providerId: string) => void }) {
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
      props.onSaved(id.trim());
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
      <Field label={translate("screens.providerTemplate")}>
        <select defaultValue="other" onChange={e => {
          setApiProt("openai-completions");
          if (e.target.value === "ollama") { setId("ollama"); setBaseUrl("http://localhost:11434/v1"); setApiKey("ollama"); }
          else { setId(""); setBaseUrl(""); setApiKey(""); }
        }}>
          <option value="other">{translate("screens.providerOther")}</option>
          <option value="ollama">{translate("screens.providerOllama")}</option>
          <option value="openai">{translate("screens.providerCompatible")}</option>
        </select>
      </Field>
      <Field label={translate("screens.providerId")}>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="ollama" />
      </Field>
      <Field label={translate("screens.baseUrl")} hint={translate("screens.providerServerUrl")}>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" />
      </Field>
      <Field label={translate("screens.apiProtocol")}>
        <select value={apiProt} onChange={(e) => setApiProt(e.target.value)}>
          {APIS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </Field>
      <Field label={translate("screens.optionalKey")} hint={translate("screens.optionalKeyHint")}>
        <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <Field label={translate("screens.modelIds")}>
        <input value={models} onChange={(e) => setModels(e.target.value)} placeholder="qwen3, llama3.1" />
      </Field>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={busy || !id.trim() || !baseUrl.trim() || !models.trim()} onClick={() => void save()}>{busy ? translate("screens.creating") : translate("screens.createProvider")}</button>
        <button type="button" className="btn" disabled={busy} onClick={props.onClose}>{translate("screens.cancel")}</button>
      </div>
      </fieldset>
      {busy ? <p role="status" className="muted">{translate("screens.pending")}</p> : null}
    </Modal>
  );
}

export function KeyModal(props: { providerId: string; onClose: () => void; onSaved: () => void }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={translate("screens.keyFor", { name: props.providerId })} onClose={() => { if (!busy) props.onClose(); }}>
      <fieldset className="form-fields" disabled={busy}>
      <ErrorText error={actionError} />
      <Field label={translate("screens.newKey")} hint={translate("screens.providerKeyHint")}>
        <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
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
