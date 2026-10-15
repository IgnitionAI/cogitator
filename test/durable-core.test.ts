/**
 * Tests unitaires du seam durable (ticket #15) : bail d'exécution OS
 * (y compris libération après SIGKILL), profil gelé (preflight fail-closed),
 * classification des orphelins, bornes du requestId, runtime_kind figé,
 * admission fail closed des capacités non classées.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { openDb } from "../src/db.js";
import { createConversation, getConversation } from "../src/conversations.js";
import { setConversationTitle } from "../src/conversations.js";
import { requestIdSchema } from "../src/schemas.js";
import { acquireRuntimeLease, RuntimeLeaseError } from "../src/durable/lease.js";
import {
  DURABLE_SDK_PIN,
  assertProfileFrozen,
  freezeMissionProfile,
  installedDurableSdkVersion,
  digest,
  MissionProfileFrozenError,
} from "../src/durable/profile.js";
import { classifyWorker, pidAlive } from "../src/durable/workers.js";
import { assertDurableAdmission, DurableAdmissionError, durableToolchainRegistry } from "../src/durable/compatibility.js";
import { DurableMissionRuntime } from "../src/durable/mission-runtime.js";

test("bail d'exécution : double acquisition refusée, libération puis réacquisition OK", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-lease-"));
  try {
    const lease = acquireRuntimeLease(dir);
    assert.throws(() => acquireRuntimeLease(dir), RuntimeLeaseError);
    lease.release();
    const again = acquireRuntimeLease(dir);
    again.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bail d'exécution : SIGKILL du détenteur libère le verrou OS", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-lease-kill-"));
  try {
    const holder = join(import.meta.dirname, "fixtures", "lease-holder.ts");
    await new Promise<void>((resolve, reject) => {
      const child = fork(holder, [dir], {
        execArgv: ["--import", "tsx"],
        env: { PATH: process.env.PATH ?? "" },
        silent: true,
      });
      let stderr = "";
      child.stderr?.on("data", (c) => {
        stderr += String(c);
      });
      child.on("message", (m) => {
        if (m === "acquired") child.kill("SIGKILL");
      });
      child.on("close", (code, signal) => {
        if (signal !== "SIGKILL") reject(new Error(`holder exit ${code}/${signal}: ${stderr}`));
        else resolve();
      });
      child.on("error", reject);
    });
    // Le verrou OS a été libéré par la mort du détenteur : réacquisition immédiate.
    const lease = acquireRuntimeLease(dir);
    lease.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profil gelé : SDK pinné, preflight rejette toute divergence (fail closed)", () => {
  assert.equal(installedDurableSdkVersion(), DURABLE_SDK_PIN);
  const frozen = freezeMissionProfile(digest("preset-a"), {
    commands: ["node", "git"],
    mcpServers: ["skills"],
    extensions: ["fixture-v1"],
  });
  // Cohérent : aucun rejet.
  assertProfileFrozen({ ...frozen, createdAt: 1 }, frozen, ["fixture-v1"]);
  // Divergences : SDK, preset, commandes, MCP, extensions, extension absente.
  assert.throws(() => assertProfileFrozen({ ...frozen, sdk: "0.0.1", createdAt: 1 }, frozen, ["fixture-v1"]), MissionProfileFrozenError);
  assert.throws(() => assertProfileFrozen({ ...frozen, presetDigest: digest("preset-b"), createdAt: 1 }, frozen, ["fixture-v1"]), MissionProfileFrozenError);
  assert.throws(
    () => assertProfileFrozen({ ...frozen, toolchain: { ...frozen.toolchain, commands: ["node", "curl"] }, createdAt: 1 }, frozen, ["fixture-v1"]),
    MissionProfileFrozenError,
  );
  assert.throws(
    () => assertProfileFrozen({ ...frozen, toolchain: { ...frozen.toolchain, mcpServers: [] }, createdAt: 1 }, frozen, ["fixture-v1"]),
    MissionProfileFrozenError,
  );
  assert.throws(() => assertProfileFrozen({ ...frozen, createdAt: 1 }, frozen, ["autre-extension"]), MissionProfileFrozenError);
  // Pas de profil du tout : refus d'ouverture.
  assert.throws(() => assertProfileFrozen(undefined, frozen, ["fixture-v1"]), MissionProfileFrozenError);
});

test("classification des orphelins : vivant / mort sans issue / résolu", async () => {
  const { spawn } = await import("node:child_process");
  const short = spawn(process.execPath, ["-e", "setTimeout(()=>{},50)"]);
  await new Promise((r) => short.on("exit", r));
  const deadPid = short.pid!;
  assert.equal(pidAlive(deadPid), false, "pid récemment terminé");
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-3), false);
  const record = { id: "w1", pid: process.pid, command: "fixture", dispatchedAt: 1 };
  assert.equal(classifyWorker(record).kind, "live-orphan");
  assert.equal(classifyWorker({ ...record, pid: deadPid }).kind, "exited-unknown");
  assert.equal(classifyWorker({ ...record, disposition: "recorded-stopped" }).kind, "resolved");
  assert.equal(classifyWorker({ ...record, pid: deadPid, disposition: "completed" }).kind, "resolved");
});

test("requestId borné : schéma accepte stable, rejette hors bornes/caractères", () => {
  assert.equal(requestIdSchema.safeParse("req-1.2_3").success, true);
  assert.equal(requestIdSchema.safeParse("a".repeat(128)).success, true);
  assert.equal(requestIdSchema.safeParse("a".repeat(129)).success, false);
  assert.equal(requestIdSchema.safeParse("").success, false);
  assert.equal(requestIdSchema.safeParse("-leading-dash").success, false);
  assert.equal(requestIdSchema.safeParse("avec espaces").success, false);
  assert.equal(requestIdSchema.safeParse("slash/inside").success, false);
});

test("runtime_kind figé à la création : classic par défaut, durable jamais mutable", () => {
  const home = mkdtempSync(join(tmpdir(), "cog-db-v7-"));
  try {
    const { db } = openDb(join(home, "cogitator.db"));
    const classic = createConversation(db, { spawn: { provider: "p", model: "m" } });
    assert.equal(classic.runtime_kind, "classic");
    const durable = createConversation(db, { spawn: { provider: "p", model: "m" }, runtimeKind: "durable" });
    assert.equal(durable.runtime_kind, "durable");
    // Aucun setter : les mises à jour existantes ne touchent pas runtime_kind.
    setConversationTitle(db, durable.id, "titre");
    assert.equal(getConversation(db, durable.id)!.runtime_kind, "durable");
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("admission durable fail closed : MCP non classé refusé, aucun travail caché", () => {
  const registry = durableToolchainRegistry({});
  assert.equal(registry.approvedMcpServers.size, 0);
  assert.throws(
    () => assertDurableAdmission(registry, { provider: "p", model: "m", mcpServers: [{ name: "evil" }] }),
    DurableAdmissionError,
  );
  // Snapshot sans MCP : admis.
  assertDurableAdmission(registry, { provider: "p", model: "m" });
  // Approbation explicite par l'exploitation : admis ensuite.
  const approved = durableToolchainRegistry({ COGITATOR_DURABLE_APPROVED_MCPS: "skills" });
  assertDurableAdmission(approved, { provider: "p", model: "m", mcpServers: [{ name: "skills" }] });
  assert.throws(() => assertDurableAdmission(approved, { provider: "p", model: "m", mcpServers: [{ name: "evil" }] }), DurableAdmissionError);
});

test("preflight d'ouverture : même stockage, presetDigest divergent → refus", { timeout: 30_000 }, async () => {
  const scope = mkdtempSync(join(tmpdir(), "cog-preflight-"));
  try {
    const open = (preset: string) => {
      const models = createModels();
      models.setProvider(fauxProvider({}).provider);
      return DurableMissionRuntime.open({
        dir: join(scope, "state"),
        cwd: scope,
        model: { provider: "faux", modelId: "faux-1" },
        presetDigest: digest(preset),
        models,
        registry: createRegistry(),
        agentExtensions: [],
        toolchain: { commands: [], mcpServers: [] },
      });
    };
    const first = await open("preset-a");
    await first.close();
    await assert.rejects(() => open("preset-b"), MissionProfileFrozenError);
    // Cohérent : rouvre sans erreur.
    const second = await open("preset-a");
    await second.close();
  } finally {
    rmSync(scope, { recursive: true, force: true });
  }
});
