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
      <div className="muted">Avant (modification demandée)</div>
      <pre className="diff-old" tabIndex={0} aria-label="Texte avant modification">{oldText || "(vide)"}</pre>
      <div className="muted">Après (modification demandée)</div>
      <pre className="diff-new" tabIndex={0} aria-label="Texte après modification">{newText || "(vide)"}</pre>
    </div>;
  })}</>;
}

function ResultBody({ result }: { result: string }) {
  const parsed = parseJson(result);
  // ponytail: flat tables only, nested or large JSON remains fully readable as text.
  if (isRecord(parsed)) {
    const entries = Object.entries(parsed);
    if (entries.length > 0 && entries.length <= 30 && entries.every(([, value]) => value === null || typeof value !== "object")) {
      return <div className="md-table-wrap" role="region" tabIndex={0} aria-label="Résultat JSON">
        <p className="md-scroll-hint">Défilement horizontal si nécessaire.</p>
        <table className="md-table"><caption>Résultat JSON</caption><tbody>{entries.map(([key, value]) =>
          <tr key={key}><th scope="row">{key}</th><td>{String(value)}</td></tr>,
        )}</tbody></table>
      </div>;
    }
  }
  return <pre className="tool-result" tabIndex={0} aria-label="Résultat de l’outil">{parsed === undefined ? result : JSON.stringify(parsed, null, 2)}</pre>;
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
  const status = props.isError ? "Erreur" : props.state === "running" ? "En cours" : "Terminé";
  return <details className={`tool-chip ${props.state}${props.isError ? " error" : ""}`}>
    <summary className="tool-head">
      <Icon name={props.isError ? "warning" : props.state === "running" ? "clock" : "check"} size={14} />
      <span className="tool-name">{props.name}</span>
      {typeof target === "string" ? <span className="tool-summary">{target}</span> : null}
      <span className="tool-status">{status}</span>
    </summary>
    <div className="tool-body">
      {props.name === "edit" ? <EditDiff args={args} /> : null}
      {props.result !== undefined ? <ResultBody result={props.result} /> : <p className="muted">{props.state === "running" ? "Résultat en attente." : "Aucun résultat disponible."}</p>}
      {props.isError ? <p className="tool-recovery">Consulte l’erreur ci-dessus, puis demande à l’agent de corriger la cause ou de réessayer.</p> : null}
      <details className="tool-arguments"><summary>Arguments bruts</summary>
        <pre className="tool-args" tabIndex={0} aria-label="Arguments de l’outil">{props.args ?? "Aucun argument."}</pre>
      </details>
    </div>
  </details>;
}
