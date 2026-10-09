import { t, formatNumber } from "./i18n";
import { Icon } from "./icons";

function parseJson(text?: string): unknown {
  try { return text === undefined ? undefined : JSON.parse(text); }
  catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function EditDiff({ args }: { args: Record<string, unknown> }) {
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  return <>{edits.map((edit: unknown, index) => {
    if (!isRecord(edit)) return null;
    const oldText = edit.oldText ?? edit.old_string;
    const newText = edit.newText ?? edit.new_string;
    if (typeof oldText !== "string" || typeof newText !== "string") return null;
    return <div key={index} className="diff-hunk">
      <div className="muted">{t("chat.before")}</div>
      <pre className="diff-old" tabIndex={0} aria-label={t("chat.beforeText")}>{oldText || t("chat.empty")}</pre>
      <div className="muted">{t("chat.after")}</div>
      <pre className="diff-new" tabIndex={0} aria-label={t("chat.afterText")}>{newText || t("chat.empty")}</pre>
    </div>;
  })}</>;
}

function ResultBody({ result }: { result: string }) {
  const parsed = parseJson(result);
  // ponytail: flat tables only, nested or large JSON remains fully readable as text.
  if (isRecord(parsed)) {
    const entries = Object.entries(parsed);
    if (entries.length > 0 && entries.length <= 30 && entries.every(([, value]) => value === null || typeof value !== "object")) {
      return <div className="md-table-wrap" role="region" tabIndex={0} aria-label={t("chat.jsonResult")}>
        <p className="md-scroll-hint">{t("chat.horizontalScroll")}</p>
        <table className="md-table"><caption>{t("chat.jsonResult")}</caption><tbody>{entries.map(([key, value]) =>
          <tr key={key}><th scope="row">{key}</th><td>{typeof value === "number" ? formatNumber(value) : String(value)}</td></tr>,
        )}</tbody></table>
      </div>;
    }
  }
  return <pre className="tool-result" tabIndex={0} aria-label={t("chat.toolResult")}>{parsed === undefined ? result : JSON.stringify(parsed, null, 2)}</pre>;
}

export function ToolResult(props: {
  name: string;
  args?: string;
  result?: string;
  isError?: boolean;
  state: "running" | "done";
}) {
  const parsed = parseJson(props.args);
  const args = isRecord(parsed) ? parsed : {};
  const target = props.name === "bash" ? args.command : ["read", "write", "edit"].includes(props.name) ? args.path ?? args.file_path : undefined;
  const status = props.isError ? t("chat.error") : props.state === "running" ? t("chat.running") : t("chat.done");
  return <details className={`tool-chip ${props.state}${props.isError ? " error" : ""}`}>
    <summary className="tool-head">
      <Icon name={props.isError ? "warning" : props.state === "running" ? "clock" : "check"} size={14} />
      <span className="tool-name">{props.name}</span>
      {typeof target === "string" ? <span className="tool-summary">{target}</span> : null}
      <span className="tool-status">{status}</span>
    </summary>
    <div className="tool-body">
      {props.name === "edit" ? <EditDiff args={args} /> : null}
      {props.result !== undefined ? <ResultBody result={props.result} /> : <p className="muted">{props.state === "running" ? t("chat.resultPending") : t("chat.noResult")}</p>}
      {props.isError ? <p className="tool-recovery">{t("chat.toolRecovery")}</p> : null}
      <details className="tool-arguments"><summary>{t("chat.rawArgs")}</summary>
        <pre className="tool-args" tabIndex={0} aria-label={t("chat.toolArgs")}>{props.args ?? t("chat.noArgs")}</pre>
      </details>
    </div>
  </details>;
}
