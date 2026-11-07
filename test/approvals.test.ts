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

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Tx } from "@earendil-works/pi-durable";
import { runProtectedEffect, type EffectGatewayApi } from "../src/durable/effect-gateway.js";

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
  // An observed fact cannot be overwritten or downgraded.
  const immutable = structuredClone(doc.receipts[0]);
  recordObservedReceipt(doc, "intent-1", { outcome: "different" }, LATER + 1);
  markReceiptUnknown(doc, "intent-1", "connecteur injoignable", LATER + 1);
  assert.deepEqual(doc.receipts[0], immutable);
  // An uncertain intent remains uncertain and its use remains consumed.
  const uncertain = emptyDoc();
  approve(uncertain);
  consumeGrantForEffect(uncertain, { ...ACTION, intentKey: "unknown", taskId: 43 }, NOW);
  markReceiptUnknown(uncertain, "unknown", "connecteur injoignable", LATER);
  assert.equal(uncertain.receipts[0]!.status, "unknown");
  assert.equal(recordObservedReceipt(uncertain, "unknown", { outcome: "guessed" }, LATER + 1).ok, false);
  assert.equal(uncertain.grants[0]!.remainingUses, 0);
  // Receipt sans intent associé : refusé (pas d'issue orpheline).
  assert.equal(recordObservedReceipt(doc, "intent-inconnu", { outcome: "x" }, NOW).ok, false);
});


test("unresolved effect and durable denial block fresh grants without consuming uses", () => {
  const doc = emptyDoc();
  approve(doc);
  consumeGrantForEffect(doc, { ...ACTION, intentKey: "old", taskId: 1 }, NOW);
  markReceiptUnknown(doc, "old", "external outcome unknown", LATER);
  approve(doc);
  const before = structuredClone(doc);
  assert.equal(consumeGrantForEffect(doc, { ...ACTION, intentKey: "new", taskId: 2 }, NOW).kind, "rejected");
  assert.deepEqual(doc, before);
  assert.equal(consumeGrantForEffect(doc, { ...ACTION, target: "other", intentKey: "old", taskId: 3 }, NOW).kind, "rejected");
  assert.deepEqual(doc, before);
  const denied = emptyDoc();
  const action = createPendingAction(denied, ACTION, NOW);
  decidePendingAction(denied, action.id, "denied", NOW);
  denied.grants.push({ ...before.grants[1]!, remainingUses: 1 });
  assert.equal(consumeGrantForEffect(denied, { ...ACTION, intentKey: "new", taskId: 2 }, NOW).kind, "rejected");
  assert.equal(denied.grants[0]!.remainingUses, 1);
});


test("gateway: observed dedup, uncertain effects and denial never create approval loops", async () => {
  const doc = emptyDoc();
  const action = { ...ACTION, expiresAt: Date.now() + 60_000 };
  const grant = createPendingAction(doc, action, Date.now());
  decidePendingAction(doc, grant.id, "approved", Date.now());
  const api: EffectGatewayApi = {
    taskId: 1, conversationId: "fixture",
    commit: async (change) => change({ doc: async () => doc } as unknown as Tx),
  };
  let calls = 0;
  const perform = async () => { calls++; return { outcome: "observed", reference: "external-1" }; };
  await runProtectedEffect(api, BACKGROUND_CONTEXT, action, "observed", perform);
  assert.equal((await runProtectedEffect(api, BACKGROUND_CONTEXT, action, "observed", perform)).kind, "duplicate");
  assert.equal(calls, 1);
  const fresh = createPendingAction(doc, action, Date.now());
  decidePendingAction(doc, fresh.id, "approved", Date.now());
  await assert.rejects(runProtectedEffect(api, BACKGROUND_CONTEXT, action, "uncertain", async () => {
    calls++;
    throw new Error("failed after external effect");
  }), /failed after external effect/);
  const another = createPendingAction(doc, action, Date.now());
  decidePendingAction(doc, another.id, "approved", Date.now());
  const before = structuredClone(doc);
  await assert.rejects(runProtectedEffect(api, BACKGROUND_CONTEXT, action, "replacement", perform), /réconcil/);
  await assert.rejects(runProtectedEffect(api, BACKGROUND_CONTEXT, action, "uncertain", perform), /réconcil/);
  await assert.rejects(runProtectedEffect(api, BACKGROUND_CONTEXT, { ...action, target: "other" }, "observed", perform), /scope mismatch/);
  assert.deepEqual(doc, before);
  assert.equal(calls, 2);
  assert.equal((await runProtectedEffect(api, BACKGROUND_CONTEXT, action, "observed", perform)).kind, "duplicate");
  const denied = createPendingAction(doc, { ...action, target: "refused" }, Date.now());
  decidePendingAction(doc, denied.id, "denied", Date.now());
  const denialBefore = structuredClone(doc);
  await assert.rejects(runProtectedEffect(api, BACKGROUND_CONTEXT, { ...action, target: "refused" }, "denied", perform));
  assert.deepEqual(doc, denialBefore);
});

test("gateway: receipt persistence failure preserves unknown, denial alone blocks new scopes", async () => {
  const doc = emptyDoc();
  const action = { ...ACTION, expiresAt: Date.now() + 60_000 };
  const pending = createPendingAction(doc, action, Date.now());
  decidePendingAction(doc, pending.id, "approved", Date.now());
  let commits = 0;
  const api: EffectGatewayApi = {
    taskId: 1, conversationId: "fixture",
    commit: async (change) => {
      commits++;
      if (commits === 2) throw new Error("receipt commit unavailable");
      return change({ doc: async () => doc } as unknown as Tx);
    },
  };
  let calls = 0;
  await assert.rejects(runProtectedEffect(api, BACKGROUND_CONTEXT, action, "write-failure", async () => {
    calls++;
    return { outcome: "effect happened" };
  }), /receipt commit unavailable/);
  assert.equal(calls, 1);
  assert.equal(doc.receipts[0]!.status, "unknown");
  assert.equal(doc.grants[0]!.remainingUses, 0);

  const deniedDoc = emptyDoc();
  const refused = createPendingAction(deniedDoc, action, Date.now());
  decidePendingAction(deniedDoc, refused.id, "denied", Date.now());
  const denialApi: EffectGatewayApi = {
    ...api, commit: async (change) => change({ doc: async () => deniedDoc } as unknown as Tx),
  };
  const before = structuredClone(deniedDoc);
  await assert.rejects(runProtectedEffect(denialApi, BACKGROUND_CONTEXT, { ...action, target: "new-scope" }, "new", async () => {
    calls++;
    return { outcome: "must not happen" };
  }), /action_denied/);
  assert.deepEqual(deniedDoc, before, "no new approval request even for a new scope");
  assert.equal(calls, 1);
});
