/**
 * Driver subprocess des scénarios SIGKILL du ticket #15 : ouvre la runtime de
 * mission PRODUCTION (src/durable/mission-runtime) avec un faux provider et
 * l'extension fixture, atteint un point de crash (le parent envoie SIGKILL),
 * puis rouvre le même stockage et prouve la reprise. Aucun appel modèle réel.
 *
 * Usage : tsx durable-driver.ts drive <scope> <seed|reopen>:<scenario> <witnessJSON>
 */

import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { DurableMissionRuntime } from "../../src/durable/mission-runtime.js";
import { digest } from "../../src/durable/profile.js";
import { makeFixtureExtension } from "./durable-fixture-tools.js";

const [, , command, scope, mode, witnessRaw = "{}"] = process.argv;
if (command !== "drive" || !scope || !mode) throw new Error("usage: drive <scope> <seed|reopen>:<scenario> [witnessJSON]");
const [phase, scenario = "generation"] = mode.split(":");

const never = () => new Promise<never>(() => {});

const workspace = join(scope!, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "fixture.txt"), "before\n");

const seed = phase === "seed";
const faux = fauxProvider(
  scenario === "generation" && seed ? { tokensPerSecond: 10, tokenSize: { min: 1, max: 1 } } : {},
);
// File de réponses par phase : le seed amorce l'appel d'outil / la génération
// lente ; la rouverture continue APRÈS le point d'interruption (l'outil rejoué
// depuis son checkpoint n'a pas besoin d'un nouvel appel d'outil du modèle).
if (scenario === "generation") {
  faux.setResponses([fauxAssistantMessage(seed ? "partial ".repeat(1000) : "recovered")]);
} else if (scenario === "effect" || scenario === "intent") {
  faux.setResponses(seed ? [fauxAssistantMessage(fauxToolCall("fixture_effect", {}), { stopReason: "toolUse" })] : [fauxAssistantMessage("must not resume")]);
} else if (scenario === "worker") {
  faux.setResponses(
    seed
      ? [fauxAssistantMessage(fauxToolCall("fixture_worker", {}), { stopReason: "toolUse" })]
      : [fauxAssistantMessage("recovered tool"), fauxAssistantMessage("resumed answer")],
  );
} else {
  faux.setResponses(
    seed
      ? [fauxAssistantMessage(fauxToolCall("fixture_edit", {}), { stopReason: "toolUse" })]
      : [fauxAssistantMessage("recovered tool")],
  );
}

const models = createModels();
models.setProvider(faux.provider);
const extension = makeFixtureExtension({
  scope: scope!, crash: seed,
  effectScenario: scenario === "effect" || scenario === "intent" ? scenario : undefined,
  beforeCrash: async () => {
    await runtime.setBudgetPolicy({ missionCalls: 0 });
    assert.equal((await runtime.submit("replacement queued before crash", "queued")).queued, true);
  },
});
const registry = createRegistry();
registry.install(extension);

const runtime = await DurableMissionRuntime.open({
  dir: join(scope!, "durable-state"),
  cwd: workspace,
  model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
  presetDigest: digest('{"profile":"ticket-15-test-v1"}'),
  models,
  registry,
  agentExtensions: [extension],
  toolchain: { commands: ["node"], mcpServers: [] },
});

const effectAction = {
  operation: "fixture.external", target: "local-counter", artifactDigest: digest("artifact"), argumentDigest: digest("{}"),
  consequence: "simulated", expiresAt: Date.now() + 60_000, allowedUses: 1,
};
if (phase === "seed") {
  if (scenario === "effect" || scenario === "intent") {
    const action = await runtime.requestPendingAction(effectAction);
    await runtime.decideApproval(action.id, "approved");
  }
  if (scenario === "generation") {
    const streaming = Promise.withResolvers<void>();
    const detach = await runtime.onCommitted((events) => {
      if (events.some((event) => event.type === "message_update")) streaming.resolve();
    });
    const submitted = await runtime.submit("first", "first");
    await streaming.promise;
    detach();
    process.send?.({ point: "streaming", submissionId: submitted.submissionId });
  } else {
    // edit / worker : le point de crash est émis par l'outil lui-même.
    await runtime.submit("tool", "tool");
  }
  await never(); // Le parent tue ce processus encore actif (SIGKILL réel).
}

// ---------- Reouverture après SIGKILL : la reprise est prouvée ici ----------

if (scenario === "generation") {
  const prior = JSON.parse(witnessRaw) as { submissionId: number };
  assert(prior.submissionId > 0);
  assert.equal(runtime.recovery.needsAttention, false);
  const resubmitted = await runtime.submit("first", "first");
  assert.equal(resubmitted.submissionId, prior.submissionId, "même identité de soumission acceptée");
  assert.equal(resubmitted.duplicate, true, "resoumission du même requestId : aucun travail dupliqué");
  await runtime.waitForIdle();
  const entries = await runtime.transcript();
  assert.equal(entries.filter((e) => e.kind === "pi.user").length, 1);
  assert(entries.some((e) => e.model?.some((m) => m.role === "assistant" && m.stopReason === "aborted")), "partiel commité présent");
  assert(
    entries.some((e) => e.model?.some((m) => m.role === "assistant" && m.stopReason === "stop" && JSON.stringify(m.content).includes("recovered"))),
    "la génération interrompue reprend et se termine",
  );
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, "identités d'entrées uniques");
  assert.equal(faux.state.callCount, 1, "reprise de checkpoint : une seule invocation fraîche");
  await runtime.close();
  process.send?.({ recovered: "generation" });
} else if (scenario === "edit") {
  const resubmitted = await runtime.submit("tool", "tool");
  assert.equal(resubmitted.duplicate, true);
  await runtime.waitForIdle();
  const entries = await runtime.transcript();
  assert.equal(entries.filter((e) => e.kind === "pi.user").length, 1);
  const results = entries.filter((e) => e.kind === "pi.tool-result");
  assert.equal(results.length, 1);
  const message = results[0]?.model?.[0];
  assert(message?.role === "toolResult" && message.isError === false, "résultat d'outil autoritatif exigé");
  assert.deepEqual(message.content, [{ type: "text", text: "edit reconciled" }]);
  assert.equal(await readFile(join(workspace, "fixture.txt"), "utf8"), "after\n");
  await runtime.close();
  process.send?.({ recovered: "edit" });
} else if (scenario === "effect" || scenario === "intent") {
  const status = await runtime.missionStatus();
  assert.equal(status.state, "needs_attention");
  assert.equal(status.attentionCases.length, 1);
  const item = status.attentionCases[0]!;
  assert.equal(item.id, "effect:crashed-intent");
  assert.equal(item.reasonCode, "effect_outcome_unknown");
  assert.equal(item.intentKey, "crashed-intent");
  assert.equal(item.receipt?.status, "unknown");
  assert.equal(item.effect.operation, effectAction.operation);
  assert.equal(item.effect.target, effectAction.target);
  assert.equal(item.effect.artifactDigest, effectAction.artifactDigest);
  assert.equal(item.effect.argumentDigest, effectAction.argumentDigest);
  assert(item.taskId && item.grantId && item.pendingActionId && item.evidenceAt);
  assert(item.unknowns.length && item.ownerTask && item.continuationConditions.length);
  assert.equal((await runtime.submit("tool", "tool")).duplicate, true);
  assert.equal((await runtime.submit("queued", "queued")).duplicate, true);
  await assert.rejects(runtime.submit("new input", "new"), /réconcil/);
  const fresh = await runtime.requestPendingAction(effectAction);
  await runtime.decideApproval(fresh.id, "approved");
  await runtime.setBudgetPolicy({ missionCalls: 100 });
  await runtime.tryDrainQueue();
  await delay(100);
  await assert.rejects(runtime.waitForIdle(), /réconcil/);
  assert.equal(faux.state.callCount, 0, "no effective SDK resume or replacement drain");
  assert.equal((await runtime.approvalsView()).grants[0]!.remainingUses, 0);
  assert.equal((await runtime.approvalsView()).grants[1]!.remainingUses, 1);
  assert.equal((await runtime.missionStatus()).queueLength, 1);
  assert.deepEqual((await runtime.missionStatus()).attentionCases, status.attentionCases);
  const calls = await readFile(join(scope!, "external.calls"), "utf8").catch(() => "");
  assert.equal(calls, scenario === "effect" ? "effect\n" : "");
  await runtime.close();
  process.send?.({ recovered: scenario });
} else {
  // worker : orphelin vivant → observation/arrêt → disposition → reprise.
  assert.equal(runtime.recovery.needsAttention, true, "orphelin vivant : readiness fausse");
  const orphan = runtime.recovery.workers.find((w) => w.kind === "live-orphan");
  assert(orphan, "classification live-orphan attendue");
  assert(orphan.record.pid > 0);
  // Observer/arrêter via la socket privée, attendre le marqueur de sortie (pas de fuite).
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(join(scope!, "w.sock"));
    let response = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("arrêt de l'orphelin en timeout")));
    socket.on("connect", () => socket.write("stop"));
    socket.on("data", (data) => {
      response += data.toString();
    });
    socket.on("error", reject);
    socket.on("end", () => {
      assert.equal(response, "stopped");
      resolve();
    });
  });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      assert.equal(await readFile(join(scope!, "worker.exited"), "utf8"), "exited");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("worker orphelin non arrêté (fuite)");
      await delay(50);
    }
  }
  await runtime.resolveWorker(orphan.record.id, "recorded-stopped");
  assert.equal(runtime.recovery.needsAttention, false, "rétabli après classement de l'orphelin");
  const resumed = await runtime.submit("resume", "resume");
  assert.equal(resumed.duplicate, false);
  await runtime.waitForIdle();
  const entries = await runtime.transcript();
  assert.equal(entries.filter((e) => e.kind === "pi.user").length, 2);
  assert(
    entries.some((e) => e.model?.some((m) => m.role === "assistant" && m.stopReason === "stop" && JSON.stringify(m.content).includes("resumed"))),
    "le travail de remplacement se termine",
  );
  // Preuve d'absence de fuite : socket morte + marqueur de sortie.
  await assert.rejects(
    new Promise((_, reject) => {
      const socket = createConnection(join(scope!, "w.sock"));
      socket.on("connect", () => reject(new Error("socket encore active : fuite")));
      socket.on("error", reject);
    }),
  );
  await rm(join(scope!, "w.sock"), { force: true });
  await runtime.close();
  process.send?.({ recovered: "worker" });
}
