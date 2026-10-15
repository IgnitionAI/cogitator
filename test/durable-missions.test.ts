/**
 * Intégration serveur des missions durables (ticket #16, P3b) — faux provider,
 * extension fixture à effet protégé passant par la passerelle d'autorisation :
 *
 * - pending action créée côté serveur, visible via GET /approvals, décision
 *   approve/deny owner, grant figé consommé à la dispatch de façon atomique,
 *   receipt (intent + issue observée) enregistré ;
 * - scope exact : un artefact différent du grant n'est PAS dispatché (S3) ;
 * - deny durable → mission needs_attention (action_denied), jamais re-demandé ;
 * - revoke : plus aucune dispatch future ;
 * - admission : deux slots, la troisième mission file visiblement ; claim
 *   workspace exclusif ; le claim se relâche après l'arrêt des écritures ;
 * - budgets : envoi accepté mais retenu en budget_paused (limite nommée +
 *   prochaine action), déliement uniquement explicite (jamais implicite).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openDb } from "../src/db.js";
import { getConversation } from "../src/conversations.js";
import { getPaths } from "../src/paths.js";
import { PiPool, type PiClientLike } from "../src/pool.js";
import { createApp } from "../src/server.js";
import { DurableRuntimeManager } from "../src/durable/manager.js";
import { durableToolchainRegistry } from "../src/durable/compatibility.js";
import { digest } from "../src/durable/profile.js";
import { runProtectedEffect } from "../src/durable/effect-gateway.js";

/** Effets réellement « exécutés » par le fixture (le test vérifie qu'ils n'arrivent qu'avec grant). */
const performedEffects: Array<{ artifact: string; intentKey: string }> = [];
/** Promesses de blocage contrôlées par le test (missions « longues » pour l'admission). */
const slowGates = new Map<string, Promise<void>>();
const slowResolvers = new Map<string, () => void>();

function slowGate(key: string): Promise<void> {
  const existing = slowGates.get(key);
  if (existing) return existing;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  slowGates.set(key, promise);
  slowResolvers.set(key, resolve);
  return promise;
}

const deployTool = defineTool({
  name: "fixture_deploy",
  description: "Effet externe simulé (protégé par grant)",
  parameters: Type.Object({ artifact: Type.String(), note: Type.Optional(Type.String()) }),
  replay: "unsafe",
  async execute(args, api, ctx) {
    const artifact = String(args.artifact);
    // Clé d'idempotence stable pour la tentative (memo par tâche) : une reprise
    // dans la même tâche réutilise la même clé.
    const intentKey = await api.memo("deploy-intent", randomUUID(), ctx);
    const result = await runProtectedEffect(
      { taskId: api.taskId, conversationId: api.conversationId, commit: api.commit.bind(api) },
      ctx,
      {
        operation: "fixture.deploy",
        target: "fixture-remote",
        artifactDigest: digest(artifact),
        argumentDigest: digest(JSON.stringify(args)),
      },
      intentKey,
      async () => {
        performedEffects.push({ artifact, intentKey });
        return { outcome: "deployed", reference: `run-${performedEffects.length}` };
      },
    );
    return {
      content: [{ type: "text", text: result.kind === "performed" ? "effet déployé" : `déjà déployé (${result.outcome})` }],
      isError: false,
    };
  },
});

const slowTool = defineTool({
  name: "fixture_slow",
  description: "Travail long contrôlé par le test (admission)",
  parameters: Type.Object({ key: Type.String() }),
  replay: "unsafe",
  async execute(args) {
    await slowGate(String(args.key));
    return { content: [{ type: "text", text: `travail ${String(args.key)} terminé` }], isError: false };
  },
});

const fixtureExtension = defineExtension({ name: "fixture-effects", tools: [deployTool, slowTool] });

class RecordingClient implements PiClientLike {
  constructor(private opts: { cwd: string; args: string[] }) {}
  async start() {}
  async stop() {}
  onEvent() { return () => {}; }
  async getState() { return { sessionFile: "/tmp/fake.jsonl", isStreaming: false }; }
  async prompt() { return {}; }
  async abort() {}
  async setModel() { return {}; }
}

async function fixture(opts: { slots?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cog-durable-missions-"));
  const paths = getPaths({
    COGITATOR_HOME: home,
    COGITATOR_PI_AGENT_DIR: join(home, "pi"),
    COGITATOR_AGENTS_DIR: join(home, "agents"),
    COGITATOR_SKILLS_DIRS: join(home, "skills"),
  });
  const { db, version } = openDb(paths.db);
  const pool = new PiPool({ factory: (o) => new RecordingClient(o) });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const durable = new DurableRuntimeManager({
    paths,
    toolchain: durableToolchainRegistry({}),
    modelsFactory: () => models,
    registryFactory: () => {
      const registry = createRegistry();
      registry.install(fixtureExtension);
      return registry;
    },
    agentExtensions: [fixtureExtension],
    missionSlots: opts.slots ?? 2,
  });
  const app = createApp({ db, dbPath: paths.db, dbVersion: version, paths, pool, events: new EventEmitter(), durable });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  function call(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path, method, headers: body !== undefined ? { "content-type": "application/json" } : {} },
        (res) => {
          let text = "";
          res.on("data", (c) => { text += String(c); });
          res.on("end", () => {
            let data: Record<string, unknown> = {};
            try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* réponses non-JSON ignorées */ }
            resolve({ status: res.statusCode!, data });
          });
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  async function createDurable(workspaceId?: string): Promise<string> {
    faux.setResponses([fauxAssistantMessage("mission prête")]);
    let ws: string | undefined = workspaceId;
    if (!ws) {
      // Chaque mission sans workspace explicite reçoit un checkout dédié : le
      // claim workspace est exclusif par dossier (deux missions sans workspace
      // partageraient sinon le homedir et se compéteraient à tort).
      const dir = join(home, "checkouts", randomUUID());
      mkdirSync(dir, { recursive: true });
      const created = await call("/api/workspaces", "POST", { name: dir.split("/").pop(), dir });
      assert.equal(created.status, 201);
      ws = (created.data.workspace as { id: string }).id;
    }
    const body: Record<string, unknown> = { runtime: "durable", provider: "faux", model: "faux-1", workspace_id: ws };
    const created = await call("/api/conversations", "POST", body);
    assert.equal(created.status, 201);
    return (created.data.conversation as { id: string }).id;
  }

  async function waitIdle(convId: string): Promise<void> {
    const runtime = await durable.get(getConversation(db, convId)!);
    await runtime.waitForIdle();
  }

  /** Attend une condition (file d'admission, états émis en asynchrone). */
  async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`timeout en attendant: ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    home, db, paths, durable, faux, port, call, createDurable, waitIdle, until,
    async close() {
      // Libère d'abord les outils lents éventuellement bloqués (le fixture
      // contrôle leur durée) : sinon dispose() attendrait leur fin indéfiniment.
      for (const resolve of slowResolvers.values()) resolve();
      server.close();
      await durable.dispose();
      db.close();
      await new Promise((r) => setTimeout(r, 50));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

type MissionResponse = { mission: { state: string; reason?: string; queueLength: number; budget: { binding?: { kind: string; limit: number; used: number; nextAction: string } } } };
type ApprovalsResponse = {
  pendingActions: Array<{ id: string; operation: string; target: string; artifactDigest: string; decision: string; expiresAt: number; allowedUses: number }>;
  grants: Array<{ id: string; remainingUses: number; revoked: boolean; valid: boolean }>;
  receipts: Array<{ intentKey: string; status: string; observed?: { outcome: string; reference?: string } }>;
};

const deployCall = fauxAssistantMessage(fauxToolCall("fixture_deploy", { artifact: "immutable-1" }), { stopReason: "toolUse" });
const deployFinal = fauxAssistantMessage("déploiement terminé");

test("approbation : pending action serveur → approve → dispatch consommé atomiquement → receipt observé", { timeout: 60_000 }, async () => {
  const fx = await fixture();
  try {
    const conv = await fx.createDurable();
    // 1. La mission tente l'effet SANS grant : blocage + pending action serveur.
    fx.faux.setResponses([deployCall, deployFinal]);
    const sent = await fx.call(`/api/conversations/${conv}/messages`, "POST", { text: "déploie immutable-1", requestId: "r1" });
    assert.equal(sent.status, 200);
    await fx.waitIdle(conv);

    const pending = (await fx.call(`/api/conversations/${conv}/approvals`)).data as unknown as ApprovalsResponse;
    assert.equal(pending.pendingActions.length, 1);
    assert.equal(pending.pendingActions[0]!.decision, "pending");
    assert.equal(pending.pendingActions[0]!.operation, "fixture.deploy");
    assert.equal(pending.pendingActions[0]!.target, "fixture-remote");
    assert.equal(pending.pendingActions[0]!.artifactDigest, digest("immutable-1"));
    assert.equal(pending.grants.length, 0);
    assert.equal(pending.receipts.length, 0, "aucun effet sans grant");
    assert.equal(performedEffects.length, 0, "l'effet n'a PAS eu lieu");

    let mission = (await fx.call(`/api/conversations/${conv}/mission`)).data as unknown as MissionResponse;
    assert.equal(mission.mission.state, "waiting_approval");

    // 2. Le client ne peut approuver que l'action serveur existante.
    const forged = await fx.call(`/api/conversations/${conv}/approvals`, "POST", { pendingActionId: randomUUID(), decision: "approved" });
    assert.equal(forged.status, 409);

    // 3. Approve → grant figé ; resubmit → dispatch : consommation + receipt atomiques.
    const decided = await fx.call(`/api/conversations/${conv}/approvals`, "POST", { pendingActionId: pending.pendingActions[0]!.id, decision: "approved" });
    assert.equal(decided.status, 200);
    fx.faux.setResponses([deployCall, deployFinal]);
    const retry = await fx.call(`/api/conversations/${conv}/messages`, "POST", { text: "réessaie le déploiement", requestId: "r2" });
    assert.equal(retry.status, 200);
    await fx.waitIdle(conv);

    assert.equal(performedEffects.length, 1, "l'effet a eu lieu exactement une fois");
    const after = (await fx.call(`/api/conversations/${conv}/approvals`)).data as unknown as ApprovalsResponse;
    assert.equal(after.grants.length, 1);
    assert.equal(after.grants[0]!.remainingUses, 0, "grant consommé");
    assert.equal(after.receipts.length, 1);
    assert.equal(after.receipts[0]!.status, "observed");
    assert.equal(after.receipts[0]!.observed?.outcome, "deployed");
    assert.ok(after.receipts[0]!.observed?.reference, "référence externe observée enregistrée");

    mission = (await fx.call(`/api/conversations/${conv}/mission`)).data as unknown as MissionResponse;
    assert.equal(mission.mission.state, "idle");
  } finally {
    performedEffects.length = 0;
    await fx.close();
  }
});

test("scope exact S3 : un artefact différent du grant n'est jamais dispatché", { timeout: 60_000 }, async () => {
  const fx = await fixture();
  try {
    const conv = await fx.createDurable();
    fx.faux.setResponses([deployCall, deployFinal]);
    await fx.call(`/api/conversations/${conv}/messages`, "POST", { text: "déploie immutable-1", requestId: "r1" });
    await fx.waitIdle(conv);
    const pending = (await fx.call(`/api/conversations/${conv}/approvals`)).data as unknown as ApprovalsResponse;
    await fx.call(`/api/conversations/${conv}/approvals`, "POST", { pendingActionId: pending.pendingActions[0]!.id, decision: "approved" });

    // Le modèle tente un artefact DIFFÉRENT : rejeté, nouvelle action en attente,
    // le grant du artefact approuvé reste intact.
    const mutatedCall = fauxAssistantMessage(fauxToolCall("fixture_deploy", { artifact: "mutable-evil" }), { stopReason: "toolUse" });
    fx.faux.setResponses([mutatedCall, deployFinal]);
    await fx.call(`/api/conversations/${conv}/messages`, "POST", { text: "déploie mutable-evil", requestId: "r2" });
    await fx.waitIdle(conv);

    const after = (await fx.call(`/api/conversations/${conv}/approvals`)).data as unknown as ApprovalsResponse;
    assert.equal(performedEffects.length, 0);
    assert.equal(after.grants[0]!.remainingUses, 1, "grant non consommé par un artefact différent");
    assert.equal(after.pendingActions.length, 2, "la tentative mutée crée sa propre action en attente");
    assert.equal(after.receipts.length, 0);
  } finally {
    performedEffects.length = 0;
    await fx.close();
  }
});

test("deny durable : needs_attention (action_denied), jamais re-demandé ; revoke bloque les futures dispatches", { timeout: 60_000 }, async () => {
  const fx = await fixture();
  try {
    const conv = await fx.createDurable();
    fx.faux.setResponses([deployCall, deployFinal]);
    await fx.call(`/api/conversations/${conv}/messages`, "POST", { text: "déploie immutable-1", requestId: "r1" });
    await fx.waitIdle(conv);
    const pending = (await fx.call(`/api/conversations/${conv}/approvals`)).data as unknown as ApprovalsResponse;

    const denied = await fx.call(`/api/conversations/${conv}/approvals`, "POST", { pendingActionId: pending.pendingActions[0]!.id, decision: "denied", denialReason: "pas ce soir" });
    assert.equal(denied.status, 200);
    const mission = (await fx.call(`/api/conversations/${conv}/mission`)).data as unknown as MissionResponse;
    assert.equal(mission.mission.state, "needs_attention");
    assert.match(mission.mission.reason ?? "", /action_denied/);
    // Réécriture de décision : refusée (durable).
    const redecide = await fx.call(`/api/conversations/${conv}/approvals`, "POST", { pendingActionId: pending.pendingActions[0]!.id, decision: "approved" });
    assert.equal(redecide.status, 409);
    // Nouvelle tentative identique : la demande déniée est réutilisée, jamais dupliquée.
    fx.faux.setResponses([deployCall, deployFinal]);
    await fx.call(`/api/conversations/${conv}/messages`, "POST", { text: "re-tente le même déploiement", requestId: "r2" });
    await fx.waitIdle(conv);
    const after = (await fx.call(`/api/conversations/${conv}/approvals`)).data as unknown as ApprovalsResponse;
    assert.equal(after.pendingActions.length, 1, "pas de re-demande identique (UA1)");
    assert.equal(after.pendingActions[0]!.decision, "denied");
    assert.equal(performedEffects.length, 0);

    // Révocation d'un grant existant : plus aucune dispatch future.
    const conv2 = await fx.createDurable();
    fx.faux.setResponses([deployCall, deployFinal]);
    await fx.call(`/api/conversations/${conv2}/messages`, "POST", { text: "déploie immutable-1", requestId: "r1" });
    await fx.waitIdle(conv2);
    const pending2 = (await fx.call(`/api/conversations/${conv2}/approvals`)).data as unknown as ApprovalsResponse;
    await fx.call(`/api/conversations/${conv2}/approvals`, "POST", { pendingActionId: pending2.pendingActions[0]!.id, decision: "approved" });
    let grants = (await fx.call(`/api/conversations/${conv2}/approvals`)).data as unknown as ApprovalsResponse;
    const revoked = await fx.call(`/api/conversations/${conv2}/approvals/${grants.grants[0]!.id}/revoke`, "POST", {});
    assert.equal(revoked.status, 200);
    fx.faux.setResponses([deployCall, deployFinal]);
    await fx.call(`/api/conversations/${conv2}/messages`, "POST", { text: "réessaie après révocation", requestId: "r2" });
    await fx.waitIdle(conv2);
    grants = (await fx.call(`/api/conversations/${conv2}/approvals`)).data as unknown as ApprovalsResponse;
    assert.equal(grants.grants[0]!.revoked, true);
    assert.equal(grants.receipts.length, 0, "révocation : aucune dispatch");
    assert.equal(performedEffects.length, 0);
  } finally {
    performedEffects.length = 0;
    await fx.close();
  }
});

test("admission : deux slots, la troisième mission file visiblement ; claim exclusif relâché après les écritures", { timeout: 90_000 }, async () => {
  const fx = await fixture({ slots: 2 });
  try {
    const slowCall = (key: string) => fauxAssistantMessage(fauxToolCall("fixture_slow", { key }), { stopReason: "toolUse" });
    const m1 = await fx.createDurable();
    const m2 = await fx.createDurable();
    const m3 = await fx.createDurable();
    // Réponses consommées en FIFO au moment de CHAQUE génération : on synchronise
    // sur faux.state.callCount pour que chaque mission reçoive son appel lent.
    fx.faux.setResponses([slowCall("a"), deployFinal]);
    await fx.call(`/api/conversations/${m1}/messages`, "POST", { text: "travail a", requestId: "a1" });
    await fx.until(async () => fx.faux.state.callCount === 1, "m1 a généré son appel lent");
    fx.faux.setResponses([slowCall("b"), deployFinal]);
    await fx.call(`/api/conversations/${m2}/messages`, "POST", { text: "travail b", requestId: "b1" });
    await fx.until(async () => fx.faux.state.callCount === 2, "m2 a généré son appel lent");
    // Les deux slots sont occupés par du travail encore en cours.
    assert.deepEqual(fx.durable.admissionSnapshot().running, [m1, m2]);

    const queuedSend = await fx.call(`/api/conversations/${m3}/messages`, "POST", { text: "travail c", requestId: "c1" });
    assert.equal(queuedSend.status, 200, "l'envoi est accepté, jamais refusé");
    const queuedAck = (queuedSend.data as { accepted: { queued: boolean } }).accepted;
    assert.equal(queuedAck.queued, true);
    const m3Status = (await fx.call(`/api/conversations/${m3}/mission`)).data as unknown as MissionResponse;
    assert.equal(m3Status.mission.state, "queued");
    assert.equal(m3Status.mission.queueLength, 1);
    assert.equal(m3Status.mission.reason, "slots_missions_pleins");

    // Libération d'un slot : la file est promue et dispatchée automatiquement.
    fx.faux.setResponses([deployFinal, deployFinal, deployFinal]);
    slowResolvers.get("a")!();
    await fx.waitIdle(m1);
    await fx.until(async () => fx.durable.admissionSnapshot().queued.length === 0, "m3 promue après libération du slot");
    await fx.waitIdle(m3);
    slowResolvers.get("b")!();
    await fx.waitIdle(m2);
    const done = (await fx.call(`/api/conversations/${m3}/mission`)).data as unknown as MissionResponse;
    assert.equal(done.mission.state, "idle");
    assert.equal(done.mission.queueLength, 0);
    // L'unique envoi de m3 est dispatché : rien perdu ni dupliqué dans la file.
    const runtime3 = await fx.durable.get(getConversation(fx.db, m3)!);
    const entries = await runtime3.transcript();
    assert.equal(entries.filter((e) => e.kind === "pi.user").length, 1);
  } finally {
    await fx.close();
  }
});

test("claim workspace : deux missions sur le même checkout ne courent pas en parallèle", { timeout: 90_000 }, async () => {
  const fx = await fixture({ slots: 2 });
  try {
    const checkout = join(fx.home, "shared-checkout");
    mkdirSync(checkout, { recursive: true });
    const ws = await fx.call("/api/workspaces", "POST", { name: "checkout-partagé", dir: checkout });
    assert.equal(ws.status, 201);
    const wsId = (ws.data.workspace as { id: string }).id;
    const m1 = await fx.createDurable(wsId);
    const m2 = await fx.createDurable(wsId);
    const slowCall = fauxAssistantMessage(fauxToolCall("fixture_slow", { key: "ws" }), { stopReason: "toolUse" });
    fx.faux.setResponses([slowCall, deployFinal]);
    await fx.call(`/api/conversations/${m1}/messages`, "POST", { text: "travail sur le checkout", requestId: "w1" });
    await fx.until(async () => fx.faux.state.callCount === 1, "m1 a généré");
    await fx.until(async () => (fx.durable.admissionSnapshot().running.length === 1), "m1 détient le claim");
    const racing = await fx.call(`/api/conversations/${m2}/messages`, "POST", { text: "même checkout", requestId: "w2" });
    assert.equal(racing.status, 200);
    assert.equal((racing.data as { accepted: { queued: boolean } }).accepted.queued, true);
    const m2Status = (await fx.call(`/api/conversations/${m2}/mission`)).data as unknown as MissionResponse;
    assert.equal(m2Status.mission.state, "queued");
    assert.match(m2Status.mission.reason ?? "", /workspace_claimed_par:/);
    // Le claim se relâche seulement après l'arrêt des écritures (waitForIdle).
    fx.faux.setResponses([deployFinal, deployFinal]);
    slowResolvers.get("ws")!();
    await fx.waitIdle(m1);
    await fx.until(async () => {
      const status = (await fx.call(`/api/conversations/${m2}/mission`)).data as unknown as MissionResponse;
      return status.mission.state !== "queued";
    }, "m2 admise après libération du claim");
    await fx.waitIdle(m2);
  } finally {
    await fx.close();
  }
});

test("budgets : envoi retenu en budget_paused (limite nommée + prochaine action), déliement uniquement explicite", { timeout: 90_000 }, async () => {
  const fx = await fixture();
  try {
    const conv = await fx.createDurable();
    // Limite de mission : 1 requête modèle. Aucun reset implicite n'existe.
    const budget = await fx.call(`/api/conversations/${conv}/budget`, "POST", { missionCalls: 1 });
    assert.equal(budget.status, 200);
    fx.faux.setResponses([fauxAssistantMessage("première réponse")]);
    await fx.call(`/api/conversations/${conv}/messages`, "POST", { text: "premier", requestId: "r1" });
    await fx.waitIdle(conv);

    // Deuxième envoi : ACCEPTÉ (jamais un échec invitant à dupliquer) mais retenu.
    const held = await fx.call(`/api/conversations/${conv}/messages`, "POST", { text: "second", requestId: "r2" });
    assert.equal(held.status, 200);
    assert.equal((held.data as { accepted: { queued: boolean } }).accepted.queued, true);
    const paused = (await fx.call(`/api/conversations/${conv}/mission`)).data as unknown as MissionResponse;
    assert.equal(paused.mission.state, "budget_paused");
    assert.equal(paused.mission.budget.binding?.kind, "missionCalls");
    assert.equal(paused.mission.budget.binding?.used, 1);
    assert.match(paused.mission.budget.binding?.nextAction ?? "", /explicitement/);

    // Relire l'état : la limite de mission n'a pas bougé (aucun reset implicite).
    const still = (await fx.call(`/api/conversations/${conv}/mission`)).data as unknown as MissionResponse;
    assert.equal(still.mission.state, "budget_paused");

    // Déliement EXPLICITE owner : la file se dispatch aussitôt.
    const raised = await fx.call(`/api/conversations/${conv}/budget`, "POST", { missionCalls: 5 });
    assert.equal(raised.status, 200);
    await fx.waitIdle(conv);
    const runtime = await fx.durable.get(getConversation(fx.db, conv)!);
    const entries = await runtime.transcript();
    assert.equal(entries.filter((e) => e.kind === "pi.user").length, 2, "les deux envois sont dispatchés, dans l'ordre");
  } finally {
    await fx.close();
  }
});
