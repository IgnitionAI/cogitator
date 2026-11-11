/**
 * Tranche 2 #17 / #47 / IGN-184 : identité persistée, inspect/stop/waitForExit
 * vérifiés, aucune disposition déclarative, aucun workspace libéré avant preuve
 * de sortie. Backends injectés uniquement — aucun démon Docker ni réseau réel.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { DurableRuntimeManager } from "../src/durable/manager.js";
import { DurableMissionRuntime } from "../src/durable/mission-runtime.js";
import { digest } from "../src/durable/profile.js";
import {
  classifyWorker,
  type WorkerCreationIntent,
  type WorkerIdentity,
  type WorkerRecord,
} from "../src/durable/workers.js";
import {
  WorkerSupervisor,
  type DiscoverObservation,
  type InspectObservation,
  type StopAcknowledgement,
  type WaitObservation,
  type WorkerBackend,
} from "../src/execution/worker-supervisor.js";
import { openDb } from "../src/db.js";
import { createConversation } from "../src/conversations.js";
import { getPaths } from "../src/paths.js";
import { durableToolchainRegistry } from "../src/durable/compatibility.js";

const IDENTITY: WorkerIdentity = {
  workerId: "w1",
  executionId: "exec-1",
  missionId: "mission-1",
  workspaceDir: "/ws/mission",
  backendId: "fake",
  immutableHandle: "handle-w1",
  starttime: "100",
  observationalPid: 4242,
};

const INTENT: WorkerCreationIntent = {
  workerId: "w1",
  executionId: "exec-1",
  missionId: "mission-1",
  workspaceDir: "/ws/mission",
  backendId: "fake",
  correlation: "corr-w1",
  specBinding: "/ws/mission",
  createdAt: 1,
};

function record(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: "w1",
    pid: IDENTITY.observationalPid,
    command: "fixture",
    dispatchedAt: 1,
    intent: INTENT,
    identity: IDENTITY,
    revision: 1,
    lifecycle: "started",
    ...overrides,
  };
}

class FakeBackend implements WorkerBackend {
  readonly id = "fake";
  inspectImpl: (identity: WorkerIdentity) => Promise<InspectObservation> = async () => ({ kind: "missing" });
  stopImpl: (identity: WorkerIdentity) => Promise<StopAcknowledgement> = async () => ({ kind: "acknowledged" });
  waitImpl: (identity: WorkerIdentity) => Promise<WaitObservation> = async () => ({ kind: "not_exited" });
  discoverImpl: (correlation: string) => Promise<DiscoverObservation> = async () => ({ kind: "none" });
  stopCalls: WorkerIdentity[] = [];
  inspectCalls = 0;

  async inspect(identity: WorkerIdentity): Promise<InspectObservation> {
    this.inspectCalls += 1;
    return this.inspectImpl(identity);
  }
  async stop(identity: WorkerIdentity): Promise<StopAcknowledgement> {
    this.stopCalls.push(identity);
    return this.stopImpl(identity);
  }
  async waitForExit(identity: WorkerIdentity): Promise<WaitObservation> {
    return this.waitImpl(identity);
  }
  async discover(correlation: string): Promise<DiscoverObservation> {
    return this.discoverImpl(correlation);
  }
}

test("un worker vivant est retrouvé après redémarrage", async () => {
  const backend = new FakeBackend();
  backend.inspectImpl = async (identity) => ({ kind: "running", identity });
  const first = new WorkerSupervisor(backend);
  const persisted = record();
  assert.equal((await first.classify(persisted)).kind, "live-orphan");
  const restarted = new WorkerSupervisor(backend);
  const found = await restarted.inspect(persisted);
  assert.equal(found.kind, "running");
  if (found.kind === "running") {
    assert.equal(found.identity.immutableHandle, IDENTITY.immutableHandle);
    assert.equal(found.identity.missionId, IDENTITY.missionId);
    assert.equal(found.identity.workspaceDir, IDENTITY.workspaceDir);
    assert.equal(found.identity.backendId, IDENTITY.backendId);
    assert.equal(found.identity.executionId, IDENTITY.executionId);
  }
  assert.equal((await restarted.classify(persisted)).kind, "live-orphan");
});

test("arrêt puis sortie confirmée avant tout remplacement", async () => {
  const backend = new FakeBackend();
  let running = true;
  backend.inspectImpl = async (identity) => (running ? { kind: "running", identity } : { kind: "missing" });
  backend.stopImpl = async () => ({ kind: "acknowledged" });
  backend.waitImpl = async () => {
    running = false;
    return { kind: "exited", writingStopped: true };
  };
  const supervisor = new WorkerSupervisor(backend);
  const live = record();
  await assert.rejects(() => supervisor.assertSafeToReplace([live]), /sortie/);
  const stopped = await supervisor.stop(live);
  assert.equal(stopped.kind, "acknowledged");
  assert.equal(backend.stopCalls.length, 1);
  const waited = await supervisor.waitForExit(live);
  assert.equal(waited.kind, "exited");
  if (waited.kind !== "exited") throw new Error("expected verified exit");
  const proven: WorkerRecord = {
    ...live,
    exitProof: { writingStopped: true, observedAt: 2 },
    lifecycle: "exit_verified",
  };
  await supervisor.assertSafeToReplace([proven]);
});

test("un worker mort sans reçu est classé inconnu", async () => {
  const backend = new FakeBackend();
  backend.inspectImpl = async () => ({ kind: "missing" });
  const supervisor = new WorkerSupervisor(backend);
  const dead = record({ disposition: "completed" });
  const classified = await supervisor.classify(dead);
  assert.equal(classified.kind, "exited-unknown");
  assert.equal(classifyWorker(dead, { kind: "missing" }).kind, "exited-unknown");
});

test("PID réutilisé, identité discordante ou inspection impossible : aucun signal, attention", async () => {
  const cases: Array<{ name: string; observation: InspectObservation }> = [
    { name: "pid_reuse", observation: { kind: "pid_reuse" } },
    {
      name: "identity_mismatch",
      observation: { kind: "identity_mismatch", observed: { ...IDENTITY, workerId: "other" } },
    },
    { name: "unavailable", observation: { kind: "unavailable", error: "EIO" } },
  ];
  for (const item of cases) {
    const backend = new FakeBackend();
    backend.inspectImpl = async () => item.observation;
    const supervisor = new WorkerSupervisor(backend);
    const classified = await supervisor.classify(record());
    assert.equal(classified.kind, "attention", item.name);
    const stop = await supervisor.stop(record());
    assert.equal(stop.kind, "refused", item.name);
    assert.equal(backend.stopCalls.length, 0, item.name);
  }
});

test("aucun workspace libéré avant la preuve de sortie", async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-ws-hold-"));
  try {
    const paths = getPaths({
      COGITATOR_HOME: home,
      COGITATOR_PI_AGENT_DIR: join(home, "pi"),
      COGITATOR_AGENTS_DIR: join(home, "agents"),
      COGITATOR_SKILLS_DIRS: join(home, "skills"),
    });
    const { db } = openDb(join(home, "cogitator.db"));
    const models = createModels();
    models.setProvider(fauxProvider({}).provider);
    const backend = new FakeBackend();
    let running = true;
    backend.inspectImpl = async (identity) => (running ? { kind: "running", identity } : { kind: "missing" });
    backend.stopImpl = async () => ({ kind: "acknowledged" });
    backend.waitImpl = async () => {
      running = false;
      return { kind: "exited", writingStopped: true };
    };
    const durable = new DurableRuntimeManager({
      paths,
      toolchain: durableToolchainRegistry({}),
      modelsFactory: () => models,
      workerBackend: backend,
    });
    const conv = createConversation(db, { spawn: { provider: "faux", model: "faux-1" }, runtimeKind: "durable" });
    const runtime = await durable.get(conv);
    const workspaceDir = runtime.workspaceDir;
    const identity: WorkerIdentity = {
      workerId: "live-w",
      executionId: "exec-live",
      missionId: runtime.missionId,
      workspaceDir,
      backendId: "fake",
      immutableHandle: "live-w",
      starttime: "1",
      observationalPid: 1,
    };
    await runtime.persistWorkerIntent({
      workerId: identity.workerId,
      executionId: identity.executionId,
      missionId: identity.missionId,
      workspaceDir,
      backendId: identity.backendId,
      correlation: "corr-live",
      specBinding: workspaceDir,
      createdAt: Date.now(),
    });
    await runtime.bindWorkerIdentity(identity);
    assert.equal(await runtime.canReleaseWorkspace(), false);
    assert.equal(durable.admissionSnapshot().claims[workspaceDir], conv.id, "claim retenu dès l'identité persistée");
    await durable.release(conv.id);
    assert.equal(durable.admissionSnapshot().claims[workspaceDir], conv.id, "claim conservé sans preuve de sortie");
    const still = await durable.get(conv);
    assert.equal(durable.admissionSnapshot().claims[workspaceDir], conv.id, "claim repris à la réouverture");
    await still.retireWorker(identity.workerId);
    assert.equal(await still.canReleaseWorkspace(), true);
    await durable.release(conv.id);
    assert.equal(durable.admissionSnapshot().claims[workspaceDir], undefined);
    await durable.dispose();
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fenêtre create/enregistrement : découverte unique liée, zéro ou plusieurs → attention", async () => {
  const unbound = record({ identity: undefined, lifecycle: "intent", pid: 0 });
  const none = new FakeBackend();
  none.discoverImpl = async () => ({ kind: "none" });
  assert.equal((await new WorkerSupervisor(none).reconcileCreation(unbound)).kind, "attention");

  const many = new FakeBackend();
  many.discoverImpl = async () => ({ kind: "ambiguous", count: 2 });
  assert.equal((await new WorkerSupervisor(many).reconcileCreation(unbound)).kind, "attention");

  const one = new FakeBackend();
  one.discoverImpl = async () => ({ kind: "one", identity: IDENTITY });
  const bound = await new WorkerSupervisor(one).reconcileCreation(unbound);
  assert.equal(bound.kind, "created");
  if (bound.kind === "created") assert.equal(bound.record.identity?.immutableHandle, IDENTITY.immutableHandle);
});

async function openMission(dir: string, cwd: string, backend?: WorkerBackend): Promise<DurableMissionRuntime> {
  const models = createModels();
  models.setProvider(fauxProvider({}).provider);
  return DurableMissionRuntime.open({
    dir,
    cwd,
    model: { provider: "faux", modelId: "faux-1" },
    presetDigest: digest("preset-worker"),
    models,
    registry: createRegistry(),
    agentExtensions: [],
    toolchain: { commands: [], mcpServers: [] },
    ...(backend ? { workerBackend: backend } : {}),
  });
}

test("reprise : worker vivant persisté est classé live-orphan à l'ouverture", { timeout: 30_000 }, async () => {
  const scope = mkdtempSync(join(tmpdir(), "cog-reopen-worker-"));
  const backend = new FakeBackend();
  backend.inspectImpl = async (identity) => ({ kind: "running", identity });
  try {
    const first = await openMission(join(scope, "state"), scope, backend);
    await first.persistWorkerIntent(INTENT);
    await first.bindWorkerIdentity({ ...IDENTITY, missionId: first.missionId, workspaceDir: scope });
    await first.close();
    const reopened = await openMission(join(scope, "state"), scope, backend);
    assert.equal(reopened.recovery.needsAttention, true);
    assert.equal(reopened.recovery.workers[0]?.kind, "live-orphan");
    await reopened.close();
  } finally {
    rmSync(scope, { recursive: true, force: true });
  }
});
