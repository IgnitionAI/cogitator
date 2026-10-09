import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { localizeText, setLocale, t, useLocale } from "./i18n";

export function LanguagePicker() {
  const locale = useLocale();
  return <label className="language-picker">
    <span>{t("common.language")}</span>
    <select value={locale} onChange={(event) => setLocale(event.target.value === "fr" ? "fr" : "en")}>
      <option value="fr" lang="fr">Français</option>
      <option value="en" lang="en">English</option>
    </select>
  </label>;
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="modal-backdrop"
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); props.onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <div
        className={`modal ${props.wide ? "modal-wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titleId}>{props.title}</h2>
          <LanguagePicker />
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={props.onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </dialog>
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
    case "active": case "ok": return "var(--success)";
    case "idle": return "var(--subtle)";
    case "spawning": case "skipped": case "killed": return "var(--todo)";
    case "dead": case "error": case "timeout": return "var(--urgent)";
    case "running": return "var(--progress)";
    default: return "var(--subtle)";
  }
}

export function Empty(props: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {props.title ? <p className="empty-title">{props.title}</p> : null}
      <div className="empty-body">{props.children}</div>
      {props.action}
    </div>
  );
}

export function ErrorText(props: { error: string | null }) {
  if (!props.error) return null;
  return <div className="error-text" role="alert">{localizeText(props.error)}</div>;
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
    <div className="list" role="status">
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: props.rows ?? 4 }, (_, i) => (
        <div key={i} className="list-row skeleton-row" aria-hidden="true" style={{ "--i": i } as CSSProperties}>
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
  useLocale();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const toast = useCallback<ToastFn>((text, isError = false) => {
    const id = ++toastSequence;
    setToasts((current) => [...current, { id, text, isError }]);
    if (!isError) setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_TTL_MS);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {props.children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((entry) => (
          <div key={entry.id} className={`toast ${entry.isError ? "err" : ""}`}>
            <Icon name={entry.isError ? "warning" : "check"} size={14} />
            <span>{localizeText(entry.text)}</span>
            <IconBtn name="close" label={t("common.dismissNotification")} onClick={() => setToasts((current) => current.filter((item) => item.id !== entry.id))} />
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
