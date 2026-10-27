import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { t, thinkingLabel } from "./i18n";
import { THINKING_LEVELS, thinkingLevelsFor } from "./types";
import type { Conversation, ProviderView, ThinkingLevel } from "./types";
import { ErrorText, Field } from "./ui";

export type ModelDraft = { provider: string; model: string; thinking: string | null };

/** Native controls shared by live conversations and future preset defaults. */
export function ModelFields({ value, providers, onChange, preserve = false }: {
  value: ModelDraft; providers: ProviderView[]; onChange: (value: ModelDraft) => void; preserve?: boolean;
}) {
  const models = providers.find((provider) => provider.id === value.provider)?.models ?? [];
  const levels = thinkingLevelsFor(providers, value.provider, value.model);
  const clampThinking = (thinking: string | null, provider: string, model: string) =>
    thinking && !thinkingLevelsFor(providers, provider, model).some((level) => level === thinking) ? null : thinking;
  return <div className="configuration-fields">
    <Field label={t("screens.provider")}>
      <select value={value.provider} onChange={(event) => {
        const provider = event.target.value;
        const model = providers.find((entry) => entry.id === provider)?.models[0]?.id ?? "";
        onChange({ ...value, provider, model, thinking: clampThinking(value.thinking, provider, model) });
      }}>
        {!providers.some((provider) => provider.id === value.provider) ? <option value={value.provider}>{value.provider || t("screens.providerPlaceholder")}</option> : null}
        {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
      </select>
    </Field>
    <Field label={t("screens.model")}>
      <select value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value, thinking: clampThinking(value.thinking, value.provider, event.target.value) })}>
        {!models.some((model) => model.id === value.model) ? <option value={value.model}>{value.model || t("screens.modelPlaceholder")}</option> : null}
        {models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
      </select>
    </Field>
    <Field label={t("screens.thinking")}>
      <select value={value.thinking ?? ""} onChange={(event) => onChange({ ...value, thinking: event.target.value || null })}>
        <option value="">{preserve ? t("configuration.preserve") : t("screens.defaultParen")}</option>
        {levels.map((level) => <option key={level} value={level}>{thinkingLabel(level)}</option>)}
      </select>
    </Field>
  </div>;
}

export function LiveConfiguration({ conversation, onChanged, name }: {
  conversation: Conversation; onChanged: (conversation: Conversation) => void; name?: string;
}) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [scope, setScope] = useState<"conversation" | "preset" | null>(null);
  const [applied, setApplied] = useState(false);
  const pending = conversation.pending_configuration;
  const latestConversation = useRef(conversation);
  latestConversation.current = conversation;
  const previousPending = useRef(pending?.status);
  const writing = useRef(false);
  useEffect(() => {
    if (previousPending.current === "pending" && !pending) setApplied(true);
    previousPending.current = pending?.status;
  }, [pending]);
  const selectedScope = scope ?? pending?.scope ?? "conversation";
  const value = draft ?? pending ?? conversation;
  const load = () => {
    setLoading(true);
    api.providers().then((response) => { setProviders(response.providers); setLoadError(null); })
      .catch((failure: Error) => setLoadError(failure.message)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const change = async (dismiss = false) => {
    if (writing.current || pending?.status === "pending") return;
    writing.current = true;
    if (!dismiss) setDraft({ provider: value.provider, model: value.model, thinking: value.thinking });
    setBusy(true);
    setError(null);
    setApplied(false);
    try {
      if (pending?.status === "failed") {
        const cleared = await api.dismissConfiguration(conversation.id);
        onChanged(cleared);
        if (dismiss) return;
      }
      const thinking = THINKING_LEVELS.find((level): level is ThinkingLevel => level === value.thinking);
      const updated = await api.switchModel(conversation.id, value.provider, value.model, thinking, selectedScope);
      onChanged(updated);
      setDraft(null);
      setApplied(!updated.pending_configuration);
      // A 202 can arrive after the applied SSE. Read back instead of leaving
      // that older HTTP response displayed as pending until the next reconnect.
      if (updated.pending_configuration?.status === "pending") {
        const beforeRead = latestConversation.current;
        const fresh = await api.conversation(conversation.id);
        if (latestConversation.current === beforeRead || latestConversation.current === updated) {
          onChanged(fresh.conversation);
          setApplied(!fresh.conversation.pending_configuration);
        }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("screens.operationFailed"));
    } finally { writing.current = false; setBusy(false); }
  };

  if (conversation.runtime_kind === "durable") return null;
  return <details className="live-configuration">
    <summary>{name ? `${name} · ` : ""}{t("configuration.title")}</summary>
    <div className="configuration-content">
      <p className="configuration-effective">{t("configuration.effective")}: <span className="mono">{conversation.provider} / {conversation.model} · {conversation.thinking ? thinkingLabel(conversation.thinking) : t("screens.defaultParen")}</span></p>
      <div role="status">
        {pending ? <p>{t(pending.status === "pending" ? "configuration.pending" : "configuration.failed")} <span className="mono">{pending.provider} / {pending.model} · {pending.thinking ? thinkingLabel(pending.thinking) : t("configuration.preserve")}</span></p> : applied ? <p>{t("configuration.applied")}</p> : null}
      </div>
      <ErrorText error={error ?? pending?.error ?? loadError} />
      {loadError ? <button type="button" className="btn btn-sm" onClick={load}>{t("screens.retryOptions")}</button> : null}
      {loading ? <p role="status">{t("configuration.loading")}</p> : null}
      <fieldset className="form-fields" disabled={busy || loading || !!loadError || pending?.status === "pending"} aria-label={name ? `${name} · ${t("configuration.title")}` : t("configuration.title")}>
        <ModelFields value={value} providers={providers} preserve onChange={(next) => { setDraft(next); setApplied(false); }} />
        <Field label={t("configuration.scope")}>
          <select value={selectedScope} onChange={(event) => setScope(event.target.value === "preset" ? "preset" : "conversation")}>
            <option value="conversation">{t("configuration.conversation")}</option>
            {conversation.agent_id ? <option value="preset">{t("configuration.preset")}</option> : null}
          </select>
        </Field>
        <p className="muted">{t("configuration.validation")}</p>
        <div className="toolbar">
          <button type="button" className="btn btn-sm btn-primary" disabled={!value.provider || !value.model} onClick={() => void change()}>{busy ? t("configuration.applying") : pending?.status === "failed" ? t("configuration.retry") : t("configuration.apply")}</button>
          {pending?.status === "failed" ? <button type="button" className="btn btn-sm" onClick={() => void change(true)}>{t("configuration.dismiss")}</button> : null}
        </div>
      </fieldset>
    </div>
  </details>;
}
