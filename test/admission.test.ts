/**
 * Tests unitaires de l'admission (ticket #16) : deux slots, file visible,
 * claims workspace exclusifs, budgets (gate quotidien reset à minuit UTC
 * uniquement, limites de mission jamais reset implicitement, limite liante
 * nommée avec prochaine action — UA3).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MissionSlotPool,
  WorkspaceClaims,
  dailyUsage,
  evaluateBudget,
  rollDailyBaseline,
  utcDay,
} from "../src/durable/admission.js";

const T0 = Date.parse("2026-10-12T10:00:00Z");

test("slots : deux missions en concurrence, la troisième file visible", () => {
  const slots = new MissionSlotPool(2);
  assert.deepEqual(slots.tryAcquire("m1"), { admitted: true });
  assert.deepEqual(slots.tryAcquire("m2"), { admitted: true });
  const third = slots.tryAcquire("m3");
  assert.equal(third.admitted, false);
  assert.equal(third.reason, "slots_missions_pleins");
  assert.deepEqual(slots.queued, ["m3"]);
  // Réacquérir un détenteur : déjà admis, pas de double slot.
  assert.deepEqual(slots.tryAcquire("m1"), { admitted: true });
  // Libération : le premier en file est promu.
  assert.equal(slots.release("m1"), "m3");
  assert.deepEqual(slots.running, ["m2", "m3"]);
  assert.deepEqual(slots.queued, []);
  // Libération d'une mission non détentrice : aucune promotion fantôme.
  assert.equal(slots.release("inconnu"), null);
});

test("claims workspace : exclusif, deux jobs ne courent pas sur le même checkout", () => {
  const claims = new WorkspaceClaims();
  assert.deepEqual(claims.acquire("/ws/a", "m1"), { claimed: true });
  const racing = claims.acquire("/ws/a", "m2");
  assert.equal(racing.claimed, false);
  assert.equal(racing.heldBy, "m1");
  // Le détenteur peut re-vérifier son propre claim.
  assert.deepEqual(claims.acquire("/ws/a", "m1"), { claimed: true });
  // Relâchement uniquement par le détenteur.
  claims.release("/ws/a", "m2");
  assert.equal(claims.holder("/ws/a"), "m1");
  claims.release("/ws/a", "m1");
  assert.equal(claims.holder("/ws/a"), undefined);
  assert.deepEqual(claims.acquire("/ws/a", "m2"), { claimed: true });
});

test("budgets : la limite de mission ne se réinitialise JAMAIS implicitement", () => {
  const policy = { missionCalls: 3 };
  // Même après un passage de jour UTC, le cumul de mission compte toujours.
  const missionUsed = { calls: 3, tokens: 0 };
  const state = evaluateBudget(policy, missionUsed, { calls: 0, tokens: 0 }, T0);
  assert.equal(state.status, "budget_paused");
  if (state.status === "budget_paused") {
    assert.equal(state.binding.kind, "missionCalls");
    assert.equal(state.binding.used, 3);
    assert.match(state.binding.nextAction, /explicitement/);
    assert.doesNotMatch(state.binding.nextAction, /minuit/);
  }
  // En dessous de la limite : rien ne lie.
  assert.deepEqual(evaluateBudget(policy, { calls: 2, tokens: 0 }, { calls: 0, tokens: 0 }, T0), { status: "within" });
});

test("budgets : le gate quotidien se délie seul à minuit UTC (UA3)", () => {
  const policy = { dailyCalls: 5 };
  const baseline = { day: utcDay(T0), calls: 2, tokens: 0 };
  const totals = { calls: 7, tokens: 0 };
  // Dans le jour : consommation du jour = 7 − 2 = 5 → gate lié, la prochaine
  // action nomme minuit UTC.
  const before = evaluateBudget(policy, totals, dailyUsage(baseline, totals, T0), T0);
  assert.equal(before.status, "budget_paused");
  if (before.status === "budget_paused") {
    assert.equal(before.binding.kind, "dailyCalls");
    assert.equal(before.binding.used, 5);
    assert.match(before.binding.nextAction, /minuit UTC/);
  }
  // Minuit UTC passé : la base roule, la consommation du jour repart de zéro.
  const T1 = Date.parse("2026-10-13T00:00:00Z");
  const rolled = rollDailyBaseline(baseline, totals, T1);
  assert.equal(rolled.day, "2026-10-13");
  assert.equal(rolled.calls, 7);
  const after = evaluateBudget(policy, totals, dailyUsage(rolled, totals, T1), T1);
  assert.deepEqual(after, { status: "within" });
});

test("budgets : la limite liante nommée est celle qui bloque (mission avant quotidien)", () => {
  const policy = { missionCalls: 10, dailyCalls: 2 };
  const state = evaluateBudget(policy, { calls: 4, tokens: 0 }, { calls: 2, tokens: 0 }, T0);
  assert.equal(state.status, "budget_paused");
  if (state.status === "budget_paused") assert.equal(state.binding.kind, "dailyCalls");
});

test("budgets : limites tokens prises en compte", () => {
  const policy = { missionTokens: 1000 };
  const state = evaluateBudget(policy, { calls: 1, tokens: 1000 }, { calls: 0, tokens: 999 }, T0);
  assert.equal(state.status, "budget_paused");
  if (state.status === "budget_paused") assert.equal(state.binding.kind, "missionTokens");
});
