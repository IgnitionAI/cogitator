/**
 * Passerelle d'effets externes (Plan 0002 §5.4/§5.5, ADR-008 D6, S3) — le SEUL
 * chemin autorisé pour un outil à effet externe :
 *
 * 1. Avant l'effet : consommation du grant et association de l'intent (clé
 *    d'idempotence persistée) dans UN commit atomique ; le scope exact
 *    (opération, cible, digests artefact/arguments immuables) est rechecké
 *    immédiatement avant l'effet ; sans grant valide, une action en attente est
 *    créée côté serveur et l'appel est bloqué (mission `waiting_approval`) ;
 * 2. L'effet s'exécute ; l'issue OBSERVÉE côté distant est enregistrée en
 *    receipt — jamais inférée du texte du modèle ;
 * 3. Reprise : une tentative déjà associée (même clé) avec issue observée n'est
 *    JAMAIS re-exécutée ; une tentative sans issue établie exige une
 *    réconciliation explicite (jamais de rejeu aveugle, Plan 0002 §5.4.4).
 */

import type { Context } from "@earendil-works/chord";
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import {
  MissionApprovals,
  GrantRejectedError,
  consumeGrantForEffect,
  createPendingAction,
  markReceiptUnknown,
  recordObservedReceipt,
  type EffectDescriptor,
} from "./approvals.js";

/** Surface minimale d'api d'exécution d'outil utilisée par la passerelle. */
export interface EffectGatewayApi {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
}

export type ProtectedEffectResult =
  | { kind: "performed" }
  | { kind: "duplicate"; outcome: string; reference?: string };

/**
 * Exécute `perform` sous autorisation de grant. `perform` doit réaliser
 * l'effet et renvoyer l'issue observée (référence externe, code…).
 */
export async function runProtectedEffect(
  api: EffectGatewayApi,
  context: Context,
  descriptor: EffectDescriptor,
  intentKey: string,
  perform: () => Promise<{ outcome: string; reference?: string }>,
): Promise<ProtectedEffectResult> {
  const now = Date.now();
  const decision = await api.commit(async (tx) => {
    const doc = await tx.doc(MissionApprovals, api.conversationId);
    const result = consumeGrantForEffect(doc, { ...descriptor, intentKey, taskId: api.taskId }, now);
    if (result.kind === "rejected") {
      // Pas de grant valide : le serveur crée l'action en attente (immumable) ;
      // l'appel est bloqué, la mission passe visiblement en waiting_approval.
      createPendingAction(doc, {
        ...descriptor,
        consequence: descriptor.operation,
        expiresAt: now + 24 * 60 * 60 * 1000,
        allowedUses: 1,
      }, now);
      return { kind: "rejected" as const, reason: result.reason };
    }
    if (result.kind === "duplicate") return { kind: "duplicate" as const, receipt: result.receipt };
    return { kind: "consumed" as const };
  }, context);

  if (decision.kind === "rejected") {
    throw new GrantRejectedError(`${decision.reason} — action en attente de décision owner`);
  }
  if (decision.kind === "duplicate") {
    if (decision.receipt.status === "observed") {
      // Tentative déjà réalisée et observée : la reprise renvoie l'issue connue.
      return {
        kind: "duplicate",
        outcome: decision.receipt.observed?.outcome ?? "observé",
        reference: decision.receipt.observed?.reference,
      };
    }
    // Intent associé sans issue établie : réconciliation owner explicite.
    throw new GrantRejectedError(
      `tentative ${intentKey} déjà associée sans issue établie : réconcilier l'issue externe avant toute reprise`,
    );
  }

  let observed: { outcome: string; reference?: string };
  try {
    observed = await perform();
  } catch (err) {
    // L'issue externe est inconnue : on la conserve comme telle (jamais de
    // rejeu implicite) et on propage l'échec à l'outil.
    await api.commit((tx) => tx.doc(MissionApprovals, api.conversationId).then((doc) => markReceiptUnknown(doc, intentKey, err instanceof Error ? err.message : String(err), Date.now())), context);
    throw err;
  }
  await api.commit(
    (tx) => tx.doc(MissionApprovals, api.conversationId).then((doc) => recordObservedReceipt(doc, intentKey, observed, Date.now())),
    context,
  );
  return { kind: "performed" };
}
