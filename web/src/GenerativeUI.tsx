import { t, getLocale, formatNumber, localizeText } from "./i18n";
import { useEffect, useId, useRef, useState } from "react";
import { parseUI, parseUIResponse, serializeUIResponse, uiRequestKey, type UISpec, type UIResponse, type UIValues } from "../../src/generative-ui";

interface Props {
  source: string;
  complete: boolean;
  streaming?: boolean;
  response?: UIResponse;
  disabled?: boolean;
  onSubmit: (text: string) => Promise<void>;
}

function RawSource({ source }: { source: string }) {
  return <details className="gen-ui-source"><summary>{t("chat.source")}</summary><pre tabIndex={0} aria-label={t("chat.sourceLabel")}>{source}</pre></details>;
}

export function UIResponseSummary({ response }: { response: UIResponse }) {
  const { request, values } = response;
  const entries = request.kind === "form"
    ? request.fields.map((field) => {
      const value = values[field.id];
      return [field.label, field.type === "select" ? field.options.find((option) => option.id === value)?.label ?? "—" : typeof value === "number" ? formatNumber(value) : String(value ?? "—")];
    })
    : [[t("chat.selection"), (request.kind === "choices" ? request.options : request.kind === "checklist" ? request.items : [])
      .filter((option) => Array.isArray(values.selection) ? values.selection.includes(option.id) : values.selection === option.id)
      .map((option) => option.label).join(", ") || t("chat.none")]];
  return <section className="gen-ui-summary" aria-label={t("chat.response")}><strong>{request.title}</strong><span className="gen-ui-status">{t("chat.sent")}</span><dl>{entries.map(([label, value], index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>;
}

function UITable({ spec }: { spec: Extract<UISpec, { kind: "table" }> }) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ id: string; descending: boolean } | null>(null);
  const rows = spec.rows.filter((row) => Object.values(row).some((value) => String(value ?? "").toLocaleLowerCase(getLocale()).includes(filter.toLocaleLowerCase(getLocale()))));
  if (sort) rows.sort((a, b) => {
    const left = a[sort.id], right = b[sort.id];
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), getLocale(), { numeric: true });
    return sort.descending ? -order : order;
  });
  return <div className="gen-ui-table">
    <label className="gen-ui-field">{t("chat.filterRows")}<input type="search" value={filter} maxLength={200} onChange={(event) => setFilter(event.target.value)} /></label>
    <p className="gen-ui-hint" role="status">{t(rows.length === 1 ? "chat.row" : "chat.rows", { count: formatNumber(rows.length) })} · {t("common.scrollHorizontal")}</p>
    <div className="gen-ui-table-scroll" tabIndex={0} role="region" aria-label={t("chat.tableTitle", { title: spec.title })}><table><caption>{spec.title}</caption><thead><tr>{spec.columns.map((column) => <th key={column.id} scope="col" aria-sort={sort?.id === column.id ? sort.descending ? "descending" : "ascending" : "none"}><button type="button" onClick={() => setSort({ id: column.id, descending: sort?.id === column.id ? !sort.descending : false })}>{column.label}{sort?.id === column.id ? sort.descending ? " ↓" : " ↑" : " ↕"}</button></th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{spec.columns.map((column) => { const value = row[column.id]; return <td key={column.id}>{typeof value === "number" ? formatNumber(value) : String(value ?? "—")}</td>; })}</tr>)}</tbody></table></div>
    {!rows.length && <p>{t("chat.noRows")}</p>}
  </div>;
}

function UIInputs({ spec, values, setValue, prefix }: { spec: Exclude<UISpec, { kind: "table" }>; values: UIValues; setValue: (id: string, value: UIValues[string]) => void; prefix: string }) {
  if (spec.kind === "form") return <>{spec.fields.map((field) => <label className="gen-ui-field" key={field.id}>
    <span>{field.label}{field.required ? t("chat.required") : ""}</span>
    {field.type === "select" ? <select required={field.required} value={String(values[field.id] ?? "")} onChange={(event) => setValue(field.id, event.target.value)}><option value="">{t("chat.choose")}</option>{field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
      : field.type === "textarea" ? <textarea required={field.required} maxLength={4000} rows={3} value={String(values[field.id] ?? "")} onChange={(event) => setValue(field.id, event.target.value)} />
      : <input type={field.type} step={field.type === "number" ? "any" : undefined} required={field.required} maxLength={4000} value={String(values[field.id] ?? "")} onChange={(event) => setValue(field.id, field.type === "number" && event.target.value !== "" ? event.target.valueAsNumber : event.target.value)} />}
  </label>)}</>;
  const options = spec.kind === "choices" ? spec.options : spec.items;
  return <>{options.map((option) => <label key={option.id} className="gen-ui-option">
    <input type={spec.kind === "choices" ? "radio" : "checkbox"} name={`${prefix}-selection`} value={option.id} required={spec.kind === "choices"} checked={spec.kind === "choices" ? values.selection === option.id : Array.isArray(values.selection) && values.selection.includes(option.id)} onChange={(event) => {
      if (spec.kind === "choices") setValue("selection", option.id);
      else {
        const selection = Array.isArray(values.selection) ? values.selection : [];
        setValue("selection", event.target.checked ? [...selection, option.id] : selection.filter((id) => id !== option.id));
      }
    }} /><span><strong>{option.label}</strong>{option.description && <span className="gen-ui-hint">{option.description}</span>}</span>
  </label>)}</>;
}

function ValidUI({ spec, source, response, disabled, onSubmit }: Omit<Props, "complete"> & { spec: UISpec }) {
  const prefix = useId();
  const [values, setValues] = useState<UIValues>(spec.kind === "checklist" ? { selection: [] } : {});
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<UIResponse | null>(null);
  const saved = response && uiRequestKey(response.request) === uiRequestKey(spec) ? response : submitted;
  const resultRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const focusResult = useRef(false);
  useEffect(() => {
    if (saved && focusResult.current) {
      focusResult.current = false;
      resultRef.current?.focus();
    }
  }, [saved]);
  if (saved) return <div ref={resultRef} tabIndex={-1} aria-label={t("chat.responseTitle", { title: spec.title })} className="gen-ui" data-ui-kind={spec.kind} data-ui-id={spec.id}><UIResponseSummary response={saved} /><RawSource source={source} /></div>;
  return <section className="gen-ui" data-ui-kind={spec.kind} data-ui-id={spec.id} aria-labelledby={`${prefix}-title`}>
    <h3 id={`${prefix}-title`}>{spec.title}</h3>{spec.description && <p className="gen-ui-description">{spec.description}</p>}
    {spec.kind === "table" ? <UITable spec={spec} /> : <form onSubmit={async (event) => {
      event.preventDefault();
      if (sending.current || disabled) return;
      setError(null);
      try {
        const text = serializeUIResponse(spec, values);
        sending.current = true;
        focusResult.current = true;
        setPending(true);
        await onSubmit(text);
        setSubmitted(parseUIResponse(text));
      } catch (cause) {
        focusResult.current = false;
        setError(cause instanceof Error ? cause.message : t("chat.sendFailed"));
      }
      finally { sending.current = false; setPending(false); }
    }}>
      <fieldset disabled={disabled || pending}><legend>{spec.kind === "choices" ? t("chat.chooseResponse") : spec.kind === "checklist" ? t("chat.selectItems") : t("chat.yourResponse")}</legend>
        <UIInputs spec={spec} values={values} setValue={(id, value) => setValues((current) => {
          const next = { ...current, [id]: value };
          if (value === "") delete next[id];
          return next;
        })} prefix={prefix} />
        <p className="gen-ui-hint">{t("chat.safety")}</p>
        {disabled && !pending && <p className="gen-ui-hint" role="status">{t("chat.wait")}</p>}
        {spec.submitLabel && <p className="gen-ui-hint">{t("chat.intent", { label: spec.submitLabel })}</p>}
        <button type="submit" className="gen-ui-submit">{t("chat.submit")}</button>
      </fieldset>
      {pending && <p className="gen-ui-status" role="status">{t("chat.submitting")}</p>}
      {error && <p ref={errorRef} tabIndex={-1} className="gen-ui-error" role="alert">{localizeText(error)}{t("chat.valuesKept")}</p>}
    </form>}
    <RawSource source={source} />
  </section>;
}

export function GenerativeUI(props: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  if (!props.complete && props.streaming) return <section className="gen-ui"><p className="gen-ui-status" role="status">{t("chat.preparing")}</p><RawSource source={props.source} /></section>;
  const parsed = props.complete ? parseUI(props.source) : { ok: false as const, error: t("chat.incomplete") };
  if (parsed.ok) return <ValidUI key={uiRequestKey(parsed.value)} {...props} spec={parsed.value} />;
  return <section className="gen-ui gen-ui-invalid"><p className="gen-ui-error">{t("chat.unavailable", { error: localizeText(parsed.error) })}</p><RawSource source={props.source} />
    <p className="gen-ui-hint">{t("chat.askCorrection")}</p>
    <button type="button" className="gen-ui-submit" disabled={props.disabled || pending} onClick={async () => {
      if (sending.current) return;
      sending.current = true; setPending(true); setError(null);
      try { await props.onSubmit(t("chat.correctPrompt", { error: localizeText(parsed.error) })); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("chat.sendFailed")); }
      finally { sending.current = false; setPending(false); }
    }}>{t("chat.submit")}</button>
    {pending && <p role="status">{t("chat.submitting")}</p>}{error && <p className="gen-ui-error" role="alert">{localizeText(error)}{t("chat.retrySubmit")}</p>}
  </section>;
}
