import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevRef.current = document.activeElement as HTMLElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = [...panelRef.current.querySelectorAll<HTMLElement>(
        "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex=\"-1\"])",
      )].filter((el) => !el.hasAttribute("disabled"));
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevRef.current?.focus();
    };
  }, [props.onClose]);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal ${props.wide ? "modal-wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titleId}>{props.title}</h2>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Fermer" onClick={props.onClose}>
            <Icon name="close" />
          </button>
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
  return (
    <span className="badge">
      {props.color ? <span className="dot" style={{ background: props.color }} /> : null}
      {props.children}
    </span>
  );
}

export function statusColor(status: string): string {
  switch (status) {
    case "active": return "#4cb782";
    case "idle": return "#80858d";
    case "spawning": return "#e2a336";
    case "dead": case "error": case "timeout": return "#eb5757";
    case "ok": return "#5e6ad2";
    case "skipped": case "killed": return "#e2a336";
    case "running": return "#f2994a";
    default: return "#80858d";
  }
}

export function Empty(props: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {props.title ? <p className="empty-title">{props.title}</p> : null}
      <p className="empty-body">{props.children}</p>
      {props.action}
    </div>
  );
}

export function ErrorText(props: { error: string | null }) {
  if (!props.error) return null;
  return <div className="error-text" role="alert">{props.error}</div>;
}

export function PageHead(props: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub ? <p className="sub">{props.sub}</p> : null}
      </div>
      {props.actions ? <div className="page-actions">{props.actions}</div> : null}
    </header>
  );
}

export function IconBtn(props: {
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  name: IconName;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${props.danger ? "danger" : ""}`}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.name} />
    </button>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Skeleton(props: { rows?: number }) {
  return (
    <div className="list" aria-hidden="true">
      {Array.from({ length: props.rows ?? 4 }, (_, i) => (
        <div key={i} className="list-row skeleton-row" style={{ "--i": i } as CSSProperties}>
          <div className="skeleton-line" />
          <div className="skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

/** Signature de la remontée de message : `toast("…")` ou `toast("…", true)` pour une erreur. */
export type ToastFn = (text: string, isError?: boolean) => void;

interface ToastEntry {
  id: number;
  text: string;
  isError: boolean;
}

const ToastContext = createContext<ToastFn | null>(null);

const TOAST_TTL_MS = 5000;

let toastSequence = 0;

/** File de toasts globale : un seul propriétaire (le provider), consommée via useToast(). */
export function ToastProvider(props: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const toast = useCallback<ToastFn>((text, isError = false) => {
    const id = ++toastSequence;
    setToasts((current) => [...current, { id, text, isError }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_TTL_MS);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {props.children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.isError ? "err" : ""}`}>
            <Icon name={t.isError ? "warning" : "check"} size={14} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Remonte un message à l'utilisateur — plus aucun composant ne reçoit `toast` en prop. */
export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast doit être utilisé sous <ToastProvider>");
  return toast;
}
