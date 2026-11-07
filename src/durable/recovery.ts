/** Read-only recovery contracts derived from authoritative approval records. */
import type { ApprovalsDoc, EffectDescriptor, EffectReceipt } from "./approvals.js";

export interface AttentionCase {
  version: 1;
  id: string;
  revision: 1;
  reasonCode: "effect_outcome_unknown" | "action_denied";
  reason: string;
  effect: EffectDescriptor;
  intentKey?: string;
  receipt?: EffectReceipt;
  grantId?: string;
  taskId?: number;
  pendingActionId?: string;
  evidenceAt: number;
  unknowns: string[];
  ownerTask: string;
  continuationConditions: string[];
}

function effectScope(effect: EffectDescriptor): EffectDescriptor {
  return {
    operation: effect.operation, target: effect.target,
    artifactDigest: effect.artifactDigest, argumentDigest: effect.argumentDigest,
  };
}

export function attentionCases(doc: ApprovalsDoc): AttentionCase[] {
  const effects: AttentionCase[] = doc.receipts.filter((receipt) => receipt.status === "unknown").map((receipt) => ({
    version: 1, revision: 1, id: `effect:${receipt.intentKey}`,
    reasonCode: "effect_outcome_unknown",
    reason: receipt.unknownReason ?? "issue externe inconnue : réconciliation requise",
    effect: effectScope(receipt), intentKey: receipt.intentKey, receipt: structuredClone(receipt),
    grantId: receipt.grantId, taskId: receipt.taskId,
    pendingActionId: doc.grants.find((grant) => grant.id === receipt.grantId)?.pendingActionId,
    evidenceAt: receipt.updatedAt,
    unknowns: ["Whether the exact external effect occurred and its authoritative outcome/reference."],
    ownerTask: "Inspect the exact target using the intent identity and connector evidence; reconcile the outcome before continuing. No resolution API is available in this slice.",
    continuationConditions: [
      "Authoritative external evidence must establish and reconcile this intent's outcome.",
      "Do not replay an unresolved intent; a new grant or message is not reconciliation evidence.",
      "Consumed uses stay consumed; a new effect requires separate exact, valid authorization.",
    ],
  }));
  const denials: AttentionCase[] = doc.pendingActions.filter((action) => action.decision === "denied").map((action) => ({
    version: 1, revision: 1, id: `denial:${action.id}`, reasonCode: "action_denied",
    reason: `action_denied: ${action.denialReason ?? "refus owner"}`,
    effect: effectScope(action), pendingActionId: action.id, evidenceAt: action.decidedAt,
    unknowns: ["The owner's explicit decision about how this mission may continue."],
    ownerTask: "Review the refused action and decide whether to cancel, revise the mission or explicitly reopen authorization. No resolution/reopening API is available in this slice.",
    continuationConditions: [
      "The durable refusal must be addressed through an explicit supported owner workflow before continuation.",
      "A new message or unrelated grant does not clear the refusal.",
      "Any uncertain effect requires independent reconciliation before new authorization.",
    ],
  }));
  return [...effects, ...denials].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
