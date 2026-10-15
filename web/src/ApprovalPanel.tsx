/**
 * Panneau d'approbation des missions durables (#16) — DISTINCT des formulaires
 * génératifs : champs FIXES (opération, cible, commit/artefact, conséquence,
 * validité) créés côté serveur, jamais rendus depuis une spécification du
 * modèle ; navigation clavier complète (ordre de tabulation naturel, boutons
 * natifs, rôles ARIA explicites).
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import type { MissionStatusView, PendingActionView } from "./types";
import { Icon } from "./icons";

function shortDigest(digest: string): string {
  return digest.length <= 16 ? digest : `${digest.slice(0, 12)}…`;
}

/** Libellé de limite liante (UA3) — mapping explicite, clés i18n typées. */
function limitLabel(kind: string): string {
  const labels: Record<string, () => string> = {
    missionCalls: () => t("mission.limit.missionCalls"),
    missionTokens: () => t("mission.limit.missionTokens"),
    dailyCalls: () => t("mission.limit.dailyCalls"),
    dailyTokens: () => t("mission.limit.dailyTokens"),
  };
  return (labels[kind]?.() ?? kind);
}

function expiryLabel(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString();
}

/** Bannière d'état de mission : nomme la limite liante et la prochaine action (UA3). */
export function MissionBanner(props: { mission: MissionStatusView | null }) {
  const { mission } = props;
  if (!mission || mission.state === "idle" || mission.state === "running") return null;
  const binding = mission.budget.binding;
  return (
    <div className={`mission-banner is-${mission.state}`} role="status">
      <Icon name="warning" size={14} />
      <span className="mission-banner-state">{t(`mission.state.${mission.state}`)}</span>
      {mission.reason ? <span className="mission-banner-reason">{mission.reason}</span> : null}
      {mission.state === "budget_paused" && binding ? (
        <span className="mission-banner-next">
          {t("mission.bindingLimit", { kind: limitLabel(binding.kind), used: String(binding.used), limit: String(binding.limit) })}
          {" — "}
          {binding.nextAction}
        </span>
      ) : null}
      {mission.state === "queued" ? (
        <span className="mission-banner-next">{t("mission.queuedNext")}</span>
      ) : null}
    </div>
  );
}

/**
 * Panneau d'approbation : liste les actions en attente (décision approve/deny),
 * les grants (révocation) et les receipts (intent + issue observée).
 */
export function ApprovalPanel(props: {
  conversationId: string;
  pendingActions: PendingActionView[];
  onDecided: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // L'arrivée d'une demande d'approbation déplace le focus dans le panneau (clavier d'abord).
  const firstPendingId = props.pendingActions.find((p) => p.decision === "pending")?.id;
  useEffect(() => {
    if (!firstPendingId) return;
    panelRef.current?.querySelector<HTMLButtonElement>("button[data-approve]")?.focus();
  }, [firstPendingId]);

  const decide = async (pendingActionId: string, decision: "approved" | "denied") => {
    setBusyId(pendingActionId);
    setError(null);
    try {
      await api.decideApproval(props.conversationId, pendingActionId, decision);
      props.onDecided();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (props.pendingActions.length === 0) return null;
  return (
    <div className="approval-panel" ref={panelRef} role="region" aria-label={t("mission.approvalsTitle")}>
      <div className="approval-panel-head">
        <Icon name="warning" size={14} />
        <span>{t("mission.approvalsTitle")}</span>
        <span className="approval-panel-fixed">{t("mission.serverFixed")}</span>
      </div>
      {error ? <div className="error-text" role="alert">{error}</div> : null}
      {props.pendingActions.map((action) => (
        <div key={action.id} className={`approval-item is-${action.decision}`}>
          <dl className="approval-facts">
            <div><dt>{t("mission.operation")}</dt><dd className="mono">{action.operation}</dd></div>
            <div><dt>{t("mission.target")}</dt><dd className="mono">{action.target}</dd></div>
            <div><dt>{t("mission.artifact")}</dt><dd className="mono" title={action.artifactDigest}>{shortDigest(action.artifactDigest)}</dd></div>
            <div><dt>{t("mission.consequence")}</dt><dd>{action.consequence}</dd></div>
            <div>
              <dt>{t("mission.validity")}</dt>
              <dd>{t("mission.validityValue", { expiry: expiryLabel(action.expiresAt), uses: String(action.allowedUses) })}</dd>
            </div>
            {action.decision === "denied" ? (
              <div><dt>{t("mission.denial")}</dt><dd>{action.denialReason ?? t("mission.denied")}</dd></div>
            ) : null}
          </dl>
          {action.decision === "pending" ? (
            <div className="approval-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                data-approve={action.id}
                disabled={busyId === action.id}
                onClick={() => void decide(action.id, "approved")}
              >
                {t("mission.approve")}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busyId === action.id}
                onClick={() => void decide(action.id, "denied")}
              >
                {t("mission.deny")}
              </button>
            </div>
          ) : (
            <div className="approval-decision">{t(action.decision === "approved" ? "mission.approved" : "mission.denied")}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Grants et receipts d'une mission (révocation, issue observée — jamais inférée). */
export function GrantsPanel(props: {
  conversationId: string;
  grants: import("./types").ApprovalGrantView[];
  receipts: import("./types").EffectReceiptView[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  if (props.grants.length === 0 && props.receipts.length === 0) return null;
  const revoke = async (grantId: string) => {
    setError(null);
    try {
      await api.revokeGrant(props.conversationId, grantId);
      props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="approval-panel is-secondary" role="region" aria-label={t("mission.grantsTitle")}>
      {error ? <div className="error-text" role="alert">{error}</div> : null}
      {props.grants.map((grant) => (
        <div key={grant.id} className={`approval-item ${grant.valid ? "" : "is-spent"}`}>
          <dl className="approval-facts">
            <div><dt>{t("mission.operation")}</dt><dd className="mono">{grant.operation}</dd></div>
            <div><dt>{t("mission.target")}</dt><dd className="mono">{grant.target}</dd></div>
            <div>
              <dt>{t("mission.validity")}</dt>
              <dd>{t("mission.grantValue", {
                expiry: expiryLabel(grant.expiresAt),
                uses: String(grant.remainingUses),
                state: grant.revoked ? t("mission.revoked") : grant.valid ? t("mission.valid") : t("mission.spent"),
              })}</dd>
            </div>
          </dl>
          {!grant.revoked ? (
            <div className="approval-actions">
              <button type="button" className="btn btn-sm" onClick={() => void revoke(grant.id)}>
                {t("mission.revoke")}
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {props.receipts.map((receipt) => (
        <div key={receipt.intentKey} className={`approval-item is-receipt is-${receipt.status}`}>
          <dl className="approval-facts">
            <div><dt>{t("mission.operation")}</dt><dd className="mono">{receipt.operation}</dd></div>
            <div><dt>{t("mission.intent")}</dt><dd className="mono" title={receipt.intentKey}>{shortDigest(receipt.intentKey)}</dd></div>
            <div>
              <dt>{t("mission.outcome")}</dt>
              <dd>
                {receipt.status === "observed"
                  ? t("mission.observed", { outcome: receipt.observed?.outcome ?? "", reference: receipt.observed?.reference ?? "" })
                  : receipt.status === "unknown"
                    ? t("mission.unknownOutcome", { reason: receipt.unknownReason ?? "" })
                    : t("mission.intentCommitted")}
              </dd>
            </div>
          </dl>
        </div>
      ))}
    </div>
  );
}
