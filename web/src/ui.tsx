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
  // Linear : la couleur vit dans un point-glyphe, jamais en remplissage
  return (
    <span className="badge">
      {props.color ? <span className="dot" style={{ background: props.color }} /> : null}
      {props.children}
    </span>
  );
}

export function statusColor(status: string): string {
  // Couleurs-glyphes Linear : success / progress / todo / urgent / done
  switch (status) {
    case "active": return "#4cb782";
    case "idle": return "#62666d";
    case "spawning": return "#e2a336";
    case "dead": case "error": case "timeout": return "#eb5757";
    case "ok": return "#5e6ad2";
    case "skipped": case "killed": return "#e2a336";
    case "running": return "#f2994a";
    default: return "#62666d";
  }
}

export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>;
}

export function ErrorText(props: { error: string | null }) {
  if (!props.error) return null;
  return <div className="error-text">{props.error}</div>;
}
