import { useEffect, useState } from "react";
import { artifactsApi, type ArtifactItem } from "./api";
import { formatDate, formatNumber, t } from "./i18n";
import { Icon } from "./icons";
import { Markdown } from "./markdown";

/** Sandbox iframe : scripts autorisés, mais origine opaque (pas de cookies ni d'accès à l'API). */
const FRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

function parseCsvRows(text: string, limit = 500): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length && rows.length <= limit; i++) {
    const c = text[i]!;
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; continue; }
    if (c === '"') quoted = true;
    else if (c === "," || c === ";") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); field = ""; if (row.some((v) => v)) rows.push(row); row = []; }
    else field += c;
  }
  row.push(field); if (row.some((v) => v)) rows.push(row);
  return rows;
}

/** Corps d'un artifact selon son type ; le texte est chargé seulement quand il faut le mettre en forme. */
export function ArtifactBody({ artifact, version }: { artifact: ArtifactItem; version: number }) {
  const url = artifactsApi.rawUrl(artifact.id, version);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const needsText = artifact.kind === "markdown" || artifact.kind === "table" || artifact.kind === "code";
  useEffect(() => {
    if (!needsText) return;
    let live = true;
    setText(null); setFailed(false);
    fetch(url, { credentials: "same-origin" }).then((r) => r.ok ? r.text() : Promise.reject(new Error(String(r.status))))
      .then((value) => { if (live) setText(value); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [url, needsText]);

  if (artifact.kind === "html") return <iframe className="artifact-frame" title={t("artifact.frame", { title: artifact.title })} src={url} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" />;
  if (artifact.kind === "image") return <div className="artifact-image"><img src={url} alt={artifact.title} /></div>;
  if (artifact.kind === "pdf") return <div className="artifact-pdf"><Icon name="files" size={28} /><p className="muted">{t("artifact.pdfHint")}</p></div>;
  if (failed) return <p className="error-text" role="alert">{t("artifact.loadFailed")}</p>;
  if (text === null) return <p className="muted" role="status">{t("common.loading")}</p>;
  if (artifact.kind === "markdown") return <div className="artifact-doc"><Markdown text={text} /></div>;
  if (artifact.kind === "table") {
    const rows = parseCsvRows(text);
    const [head, ...body] = rows;
    return <div className="artifact-table" role="region" tabIndex={0} aria-label={artifact.title}>
      <p className="muted">{t("artifact.rows", { count: formatNumber(body.length) })}</p>
      <table className="md-table"><thead><tr>{(head ?? []).map((cell, i) => <th key={i} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table>
    </div>;
  }
  return <pre className="artifact-code" tabIndex={0}>{text}</pre>;
}

/** En-tête + actions + contenu. `compact` : version panneau latéral du fil. */
export function ArtifactViewer(props: {
  artifact: ArtifactItem;
  agentName?: string;
  compact?: boolean;
  onExpand?: () => void;
  onThread?: () => void;
  onChanged?: (artifact: ArtifactItem | null) => void;
}) {
  const { artifact } = props;
  const latest = artifact.versions.at(-1)?.n ?? 1;
  const [version, setVersion] = useState(latest);
  useEffect(() => setVersion(latest), [artifact.id, latest]);
  const current = artifact.versions.find((v) => v.n === version);

  return <section className={`artifact-viewer${props.compact ? " is-compact" : ""}`} aria-label={artifact.title}>
    <header className="artifact-head">
      <div className="artifact-head-text">
        <h2>{artifact.title}</h2>
        <p className="muted">
          {t(`artifact.kind.${artifact.kind}`)}{props.agentName ? ` · ${t("artifact.by", { name: props.agentName })}` : ""}
          {current?.note ? ` · ${current.note}` : ""}
        </p>
      </div>
      {artifact.versions.length > 1 ? <label className="artifact-version">
        <span className="sr-only">{t("artifact.version")}</span>
        <select value={version} onChange={(e) => setVersion(Number(e.target.value))}>
          {[...artifact.versions].reverse().map((v) => <option key={v.n} value={v.n}>{t("artifact.versionOption", { n: formatNumber(v.n), date: formatDate(v.created_at, { dateStyle: "short", timeStyle: "short" }) })}</option>)}
        </select>
      </label> : null}
      <div className="artifact-actions">
        {props.compact && props.onExpand ? <button type="button" className="btn btn-sm" onClick={props.onExpand}>{t("artifact.expand")}</button> : null}
        <a className="btn btn-sm" href={artifactsApi.rawUrl(artifact.id, version)} target="_blank" rel="noreferrer">{t("artifact.newTab")} <span aria-hidden="true">↗</span></a>
        <a className="btn btn-sm" href={artifactsApi.rawUrl(artifact.id, version, true)} download>{t("artifact.download")}</a>
        {!props.compact ? <>
          {props.onThread && artifact.conversation_id ? <button type="button" className="btn btn-sm" onClick={props.onThread}>{t("artifact.thread")}</button> : null}
          <button type="button" className="btn btn-sm" onClick={() => {
            const title = prompt(t("artifact.renamePrompt"), artifact.title)?.trim();
            if (title && title !== artifact.title) void artifactsApi.rename(artifact.id, title).then((r) => props.onChanged?.(r.artifact));
          }}>{t("artifact.rename")}</button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => {
            if (confirm(t("artifact.deleteConfirm", { title: artifact.title }))) void artifactsApi.remove(artifact.id).then(() => props.onChanged?.(null));
          }}>{t("artifact.delete")}</button>
        </> : null}
      </div>
    </header>
    <div className="artifact-body"><ArtifactBody artifact={artifact} version={version} /></div>
  </section>;
}
