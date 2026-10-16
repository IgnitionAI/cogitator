import { localizeText, t } from "./i18n";

export type QueueFailure = { kind: "queue"; text: string; reason: "failed" | "stopped"; error?: string };

export function appendRecoveredMessage(draft: string, message: string): string {
  return draft ? `${draft}\n\n${message}` : message;
}

/** Recovery only restores editable text, never sends another prompt. */
export function QueueRecovery({ item, onRestore }: { item: QueueFailure; onRestore: (text: string) => void }) {
  return <div className="msg msg-status" role="alert">
    <p>{t(item.reason === "failed" ? "chat.queueFailed" : "chat.queueStopped")}</p>
    {item.error ? <p>{localizeText(item.error)}</p> : null}
    <p className="queue-message">{item.text}</p>
    <button type="button" className="btn btn-sm" onClick={() => onRestore(item.text)}>{t("chat.restoreQueued")}</button>
  </div>;
}
