/**
 * Tests unitaires des approbations persistées (ticket #16) : pending actions
 * immuables créées côté serveur, grants à scope exact (S3 : digests
 * artefact/arguments/cible/opération figés), expiration, révocation, uses
 * restants, consommation atomique + association d'intent, denials durables
 * sans re-demande identique (UA1), receipts (idempotence + issue observée,
 * jamais inférée).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumeGrantForEffect,
  createPendingAction,
  decidePendingAction,
  digest,
  findValidGrant,
  markReceiptUnknown,
  recordObservedReceipt,
  revokeGrant,
  type ApprovalsDoc,
} from "../src/durable/approvals.js";

const NOW = Date.parse("2026-10-12T10:00:00Z");
const LATER = NOW + 60_000;

function emptyDoc(): ApprovalsDoc {
  return { pendingActions: [], grants: [], receipts: [] };
}

const ACTION = {
  operation: "github.workflow_dispatch",
  target: "IgnitionAI/cogitator",
  artifactDigest: digest("commit-abc"),
  argumentDigest: digest(JSON.stringify({ ref: "main" })),
  consequence: "déclenche le workflow de production",
  expiresAt: LATER,
  allowedUses: 1,
};

function approve(doc: ApprovalsDoc): string {
  const action = createPendingAction(doc, ACTION, NOW);
  const result = decidePendingAction(doc, action.id, "approved", NOW);
  assert.equal(result.kind, "decided");
  return result.grant!.id;
}

test("grant : scope exact — un digest différent rejette (S3, pas de ref mutable)", () => {
  const doc = emptyDoc();
  const grantId = approve(doc);
  const grant = doc.grants.find((g) => g.id === grantId)!;
  // Même opération/cible mais artefact différent : rejeté.
  const mutated = findValidGrant(doc.grants, { ...grant, artifactDigest: digest("commit-evil") }, NOW);
  assert.ok("reason" in mutated);
  assert.match(mutated.reason, /S3/);
  // Arguments différents : rejeté.
  const otherArgs = findValidGrant(doc.grants, { ...grant, argumentDigest: digest(JSON.stringify({ ref: "dev" })) }, NOW);
  assert.ok("reason" in otherArgs);
  // Cible différente : rejeté.
  const otherTarget = findValidGrant(doc.grants, { ...grant, target: "IgnitionAI/autre" }, NOW);
  assert.ok("reason" in otherTarget);
  // Exact : valide.
  const exact = findValidGrant(doc.grants, grant, NOW);
  assert.ok("grant" in exact);
});

test("grant : expiration, révocation et épuisement des uses recheckés à la dispatch", () => {
  const doc = emptyDoc();
  const grantId = approve(doc);
  const grant = doc.grants.find((g) => g.id === grantId)!;
  assert.ok("reason" in findValidGrant(doc.grants, grant, LATER + 1), "expiré après expiresAt");
  assert.match(findValidGrant(doc.grants, grant, LATER + 1).reason as string, /expiré/);
  revokeGrant(doc, grantId);
  assert.match(findValidGrant(doc.grants, grant, NOW).reason as string, /révoqué/);
  // Deuxième grant non révoqué mais épuisé.
  const doc2 = emptyDoc();
  const gid2 = approve(doc2);
  const g2 = doc2.grants.find((g) => g.id === gid2)!;
  g2.remainingUses = 0;
  assert.match(findValidGrant(doc2.grants, g2, NOW).reason as string, /épuisé/);
});

test("consommation atomique : grant décrémenté ET intent associé dans le même commit", () => {
  const doc = emptyDoc();
  approve(doc);
  const effect = { ...ACTION, intentKey: "intent-1", taskId: 42 };
  const result = consumeGrantForEffect(doc, effect, NOW);
  assert.equal(result.kind, "consumed");
  assert.equal(doc.grants[0]!.remainingUses, 0, "use consommé");
  assert.equal(doc.receipts.length, 1, "intent associé");
  assert.equal(doc.receipts[0]!.status, "intent_committed");
  assert.equal(doc.receipts[0]!.intentKey, "intent-1");
  assert.equal(doc.receipts[0]!.taskId, 42);
  // Sans second grant, une nouvelle tentative est rejetée (uses restants recheckés).
  const again = consumeGrantForEffect(doc, { ...ACTION, intentKey: "intent-2", taskId: 43 }, NOW);
  assert.equal(again.kind, "rejected");
});

test("idempotence : la même clé d'intent n'est jamais re-consommée ni re-exécutée", () => {
  const doc = emptyDoc();
  approve(doc);
  const effect = { ...ACTION, intentKey: "intent-1", taskId: 42 };
  assert.equal(consumeGrantForEffect(doc, effect, NOW).kind, "consumed");
  const replay = consumeGrantForEffect(doc, effect, NOW);
  assert.equal(replay.kind, "duplicate");
  if (replay.kind === "duplicate") assert.equal(replay.receipt.intentKey, "intent-1");
  // Un seul use consommé malgré la reprise.
  assert.equal(doc.grants[0]!.remainingUses, 0);
  assert.equal(doc.receipts.length, 1);
});

test("pending action : création serveur immuable, demande identique jamais dupliquée (UA1)", () => {
  const doc = emptyDoc();
  const a1 = createPendingAction(doc, ACTION, NOW);
  const a2 = createPendingAction(doc, ACTION, NOW);
  assert.equal(a1.id, a2.id, "demande identique réutilisée");
  assert.equal(doc.pendingActions.length, 1);
  // Champs de scope immuables par construction API : seule la décision évolue,
  // via la fonction serveur (aucun mutateur exposé au client).
  const result = decidePendingAction(doc, a1.id, "approved", NOW);
  assert.equal(result.kind, "decided");
});

test("décision : approve crée le grant figé ; deny est durable et rejette les réécritures", () => {
  const doc = emptyDoc();
  const action = createPendingAction(doc, ACTION, NOW);
  const denied = decidePendingAction(doc, action.id, "denied", NOW, "trop risqué");
  assert.equal(denied.kind, "decided");
  assert.equal(doc.grants.length, 0, "deny ne crée aucun grant");
  assert.equal(doc.pendingActions[0]!.decision, "denied");
  assert.equal(doc.pendingActions[0]!.denialReason, "trop risqué");
  // Jamais re-demandé à l'identique, jamais re-décidé.
  const again = createPendingAction(doc, ACTION, NOW);
  assert.equal(again.decision, "denied");
  const redecide = decidePendingAction(doc, action.id, "approved", NOW);
  assert.equal(redecide.kind, "error");
  assert.match(redecide.reason, /déjà enregistrée/);
});

test("décision : pending action expiré reste visible et ne se décide pas (UA1)", () => {
  const doc = emptyDoc();
  const action = createPendingAction(doc, ACTION, NOW);
  const result = decidePendingAction(doc, action.id, "approved", LATER + 1);
  assert.equal(result.kind, "error");
  assert.match(result.reason, /expiré/);
  assert.equal(doc.pendingActions[0]!.decision, "pending", "expiration reste visible, pas de décision fantôme");
});

test("décision : le client ne peut pas approuver une action inexistante", () => {
  const doc = emptyDoc();
  const result = decidePendingAction(doc, "00000000-0000-0000-0000-000000000000", "approved", NOW);
  assert.equal(result.kind, "error");
  assert.match(result.reason, /introuvable/);
});

test("receipt : issue observée enregistrée, inconnue jamais relabellée", () => {
  const doc = emptyDoc();
  approve(doc);
  consumeGrantForEffect(doc, { ...ACTION, intentKey: "intent-1", taskId: 42 }, NOW);
  const observed = recordObservedReceipt(doc, "intent-1", { outcome: "workflow conclu", reference: "run-123" }, LATER);
  assert.equal(observed.ok, true);
  if (observed.ok) {
    assert.equal(observed.receipt.status, "observed");
    assert.equal(observed.receipt.observed?.reference, "run-123");
  }
  // Issue inconnue conservée comme telle (réconciliation owner requise).
  markReceiptUnknown(doc, "intent-1", "connecteur injoignable", LATER + 1);
  assert.equal(doc.receipts[0]!.status, "unknown");
  assert.match(doc.receipts[0]!.unknownReason!, /injoignable/);
  // Receipt sans intent associé : refusé (pas d'issue orpheline).
  assert.equal(recordObservedReceipt(doc, "intent-inconnu", { outcome: "x" }, NOW).ok, false);
});
