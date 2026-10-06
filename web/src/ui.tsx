import type { ReactNode } from "react";

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className={`modal ${props.wide ? "modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="btn btn-ghost" onClick={props.onClose}>✕</button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function Badge(props: { color?: string; children: ReactNode }) {
  return <span className="badge" style={props.color ? { background: props.color } : undefined}>{props.children}</span>;
}

export function statusColor(status: string): string {
  switch (status) {
    case "active": return "#1a7f37";
    case "idle": return "#57606a";
    case "spawning": return "#9a6700";
    case "dead": case "error": case "timeout": return "#cf222e";
    case "ok": return "#1a7f37";
    case "skipped": case "killed": return "#9a6700";
    case "running": return "#0969da";
    default: return "#57606a";
  }
}

export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>;
}

export function ErrorText(props: { error: string | null }) {
  if (!props.error) return null;
  return <div className="error-text">{props.error}</div>;
}
