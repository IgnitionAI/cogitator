/**
 * Approbations persistées, grants révocables et receipts d'effets (Plan 0002 §5,
 * ADR-008 D6, Skeptic S3, UA1) — vérité Durable (D4) : pending actions, grants
 * et intents/receipts vivent dans le stockage Durable de la conversation.
 *
 * Contrats :
 * - UNE action privilégiée ne peut être approuvée que si le SERVEUR a créé un
 *   pending action immuable (operation, target, artifact/argument digests,
 *   expiry, allowed uses) ; le client n'invente jamais l'action à approuver ;
 * - le pending action est immuable : seul son état de décision change ;
 * - le grant est vérifiable à la dispatch : digests exacts (artefact/arguments/
 *   opération/cible, S3 — pas de ref mutable), expiration, révocation, uses
 *   restants, recheck immédiat avant CHAQUE effet protégé ;
 * - consommation du grant et association de l'intent (idempotency key) ATOMIQUES
 *   dans un même commit ;
 * - denial/expiry/cancellation sont des événements distincts (UA1) ; une demande
 *   identique n'est jamais re-demandée en boucle ;
 * - le receipt enregistre l'intent (clé d'idempotence) + l'issue OBSERVÉE côté
 *   distant : on ne déduit jamais le succès du texte du modèle.
 */

import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { digest } from "./profile.js";

export { digest };

/** Action sensible : identité canonique = digests immuables, jamais une ref mutable (S3). */
export type EffectDescriptor = {
  /** Opération protégée (ex. "github.workflow_dispatch"). */
  operation: string;
  /** Cible exacte (ex. "IgnitionAI/cogitator"). */
  target: string;
  /** Digest SHA-256 des bytes de l'artefact/commit exact à exécuter. */
  artifactDigest: string;
  /** Digest SHA-256 de l'ensemble d'arguments exact. */
  argumentDigest: string;
}

/** Action en attente créée côté serveur, immuable dans ses champs de scope. */
export type PendingAction = EffectDescriptor & {
  /** Identifiant serveur (le client ne le choisit pas). */
  id: string;
  /** Conséquence affichée telle quelle au panneau d'approbation. */
  consequence: string;
  /** Expiration du pending action (ms epoch). */
  expiresAt: number;
  /** Nombre d'utilisations autorisées par le grant qui en découlera. */
  allowedUses: number;
  createdAt: number;
  /** Décision owner ; "expired" est un état dérivé, pas une décision. */
  decision: "pending" | "approved" | "denied";
  decidedAt: number;
  /** Dénégation durable (UA1) : motif affiché, jamais re-demandé à l'identique. */
  denialReason?: string;
}

/** Grant : décision approuvée, durable et révocable, consommé à la dispatch. */
export type ApprovalGrant = EffectDescriptor & {
  id: string;
  pendingActionId: string;
  expiresAt: number;
  /** Uses restants ; recheck immédiat avant chaque effet protégé. */
  remainingUses: number;
  revoked: boolean;
  decidedAt: number;
}

export type ReceiptStatus = "intent_committed" | "observed" | "unknown";

/** Receipt : intent (idempotency key) + issue observée ; jamais inférée du texte. */
export type EffectReceipt = EffectDescriptor & {
  /** Clé d'idempotence stable de la TENTATIVE (persistée avant l'effet). */
  intentKey: string;
  grantId: string;
  /** Tâche Durable ayant consommé le grant (association atomique). */
  taskId: number;
  status: ReceiptStatus;
  /** Issue observée côté distant (référence externe, code, …). */
  observed?: { at: number; outcome: string; reference?: string };
  /** L'issue n'a pas pu être établie : réconciliation owner requise (jamais de replay aveugle). */
  unknownReason?: string;
  updatedAt: number;
}

export type ApprovalsDoc = {
  pendingActions: PendingAction[];
  grants: ApprovalGrant[];
  receipts: EffectReceipt[];
}

const emptyApprovals = (): ApprovalsDoc => ({ pendingActions: [], grants: [], receipts: [] });

/** Document conversationnel unique : approbations et effets de la mission. */
export const MissionApprovals = defineDoc<ApprovalsDoc>({
  kind: "cogitator.mission-approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: emptyApprovals,
});

// ---------- Erreurs de dispatch (motifs vérifiables, jamais génériques) ----------

export class GrantRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`effet protégé refusé : ${reason}`);
    this.name = "GrantRejectedError";
  }
}

/** Recherche un grant valide pour l'effet EXACT, immédiatement avant la dispatch. */
export function findValidGrant(
  grants: readonly ApprovalGrant[],
  effect: EffectDescriptor,
  now: number,
): { grant: ApprovalGrant } | { reason: string } {
  const candidates = grants.filter(
    (g) =>
      g.operation === effect.operation &&
      g.target === effect.target &&
      g.artifactDigest === effect.artifactDigest &&
      g.argumentDigest === effect.argumentDigest,
  );
  if (candidates.length === 0) return { reason: "aucun grant pour cette action exacte (artefact/arguments/cible figés, S3)" };
  const revoked = candidates.find((g) => g.revoked);
  if (revoked && candidates.every((g) => g.revoked)) return { reason: "grant révoqué : plus aucune dispatch future autorisée" };
  const expired = candidates.find((g) => g.expiresAt <= now);
  if (expired && candidates.every((g) => g.expiresAt <= now || g.revoked)) {
    return { reason: "grant expiré : renouvellement owner requis (l'expiration reste visible, UA1)" };
  }
  const usable = candidates.find((g) => !g.revoked && g.expiresAt > now && g.remainingUses > 0);
  if (!usable) return { reason: "grant épuisé (uses restants = 0)" };
  return { grant: usable };
}

/**
 * Consommation atomique : décrémente le grant ET associe l'intent (receipt
 * "intent_committed" avec la clé d'idempotence et la tâche) dans la MÊME
 * mutation de document. Une tentative déjà associée à cette clé n'est jamais
 * re-consommée : on renvoie le receipt existant (déduplication/reprise).
 */
export function consumeGrantForEffect(
  doc: ApprovalsDoc,
  effect: EffectDescriptor & { intentKey: string; taskId: number },
  now: number,
): { kind: "consumed" } | { kind: "duplicate"; receipt: EffectReceipt } | { kind: "rejected"; reason: string } {
  const prior = doc.receipts.find((r) => r.intentKey === effect.intentKey);
  if (prior) return { kind: "duplicate", receipt: prior };
  const found = findValidGrant(doc.grants, effect, now);
  if ("reason" in found) return { kind: "rejected", reason: found.reason };
  found.grant.remainingUses -= 1;
  doc.receipts.push({
    ...effect,
    grantId: found.grant.id,
    taskId: effect.taskId,
    status: "intent_committed",
    updatedAt: now,
  });
  return { kind: "consumed" };
}

/**
 * Crée un pending action côté serveur. Une demande IDENTIQUE (mêmes digests +
 * opération + cible) déjà pending ou déjà déniée n'est pas dupliquée (UA1) :
 * on renvoie l'existant. Champs de scope immuables après création.
 */
export function createPendingAction(
  doc: ApprovalsDoc,
  input: EffectDescriptor & { consequence: string; expiresAt: number; allowedUses: number },
  now: number,
): PendingAction {
  const identical = doc.pendingActions.find(
    (p) =>
      p.decision !== "approved" &&
      p.operation === input.operation &&
      p.target === input.target &&
      p.artifactDigest === input.artifactDigest &&
      p.argumentDigest === input.argumentDigest,
  );
  if (identical) return identical;
  const action: PendingAction = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    decision: "pending",
    decidedAt: 0,
  };
  doc.pendingActions.push(action);
  return action;
}

export type ApprovalDecisionResult =
  | { kind: "decided"; pendingAction: PendingAction; grant?: ApprovalGrant }
  | { kind: "error"; reason: string };

/**
 * Décision owner sur un pending action immuable. Approuver crée le grant
 * (copie des digests figés, expiry, allowed uses) ; dénier est durable et ne
 * re-demandera jamais l'action identique. Les décisions ne se réécrivent pas.
 */
export function decidePendingAction(
  doc: ApprovalsDoc,
  pendingActionId: string,
  decision: "approved" | "denied",
  now: number,
  denialReason?: string,
): ApprovalDecisionResult {
  const action = doc.pendingActions.find((p) => p.id === pendingActionId);
  if (!action) return { kind: "error", reason: "pending action introuvable (le client ne peut pas en inventer un)" };
  if (action.decision !== "pending") return { kind: "error", reason: `décision déjà enregistrée (${action.decision}) — les décisions sont durables` };
  if (action.expiresAt <= now) return { kind: "error", reason: "pending action expiré : renouveler ou annuler (l'expiration reste visible, UA1)" };
  action.decision = decision;
  action.decidedAt = now;
  if (decision === "denied") action.denialReason = denialReason ?? "refus owner";
  if (decision === "approved") {
    const grant: ApprovalGrant = {
      operation: action.operation,
      target: action.target,
      artifactDigest: action.artifactDigest,
      argumentDigest: action.argumentDigest,
      id: randomUUID(),
      pendingActionId: action.id,
      expiresAt: action.expiresAt,
      remainingUses: action.allowedUses,
      revoked: false,
      decidedAt: now,
    };
    doc.grants.push(grant);
    return { kind: "decided", pendingAction: action, grant };
  }
  return { kind: "decided", pendingAction: action };
}

/** Révocation : bloque les FUTURES dispatches ; n'annule pas un effet déjà accepté. */
export function revokeGrant(doc: ApprovalsDoc, grantId: string): { ok: true } | { ok: false; reason: string } {
  const grant = doc.grants.find((g) => g.id === grantId);
  if (!grant) return { ok: false, reason: "grant introuvable" };
  grant.revoked = true;
  return { ok: true };
}

/** Enregistre l'issue OBSERVÉE d'une tentative déjà associée (jamais inférée). */
export function recordObservedReceipt(
  doc: ApprovalsDoc,
  intentKey: string,
  observed: { outcome: string; reference?: string },
  now: number,
): { ok: true; receipt: EffectReceipt } | { ok: false; reason: string } {
  const receipt = doc.receipts.find((r) => r.intentKey === intentKey);
  if (!receipt) return { ok: false, reason: "intent inconnu : la tentative n'a pas été associée à un grant" };
  receipt.status = "observed";
  receipt.observed = { at: now, ...observed };
  receipt.updatedAt = now;
  return { ok: true, receipt };
}

/** Marque une tentative dont l'issue externe ne peut être établie (réconciliation requise). */
export function markReceiptUnknown(doc: ApprovalsDoc, intentKey: string, reason: string, now: number): void {
  const receipt = doc.receipts.find((r) => r.intentKey === intentKey);
  if (!receipt) return;
  receipt.status = "unknown";
  receipt.unknownReason = reason;
  receipt.updatedAt = now;
}
