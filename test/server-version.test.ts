import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertNoLiveInstance,
  compareVersions,
  ensureCompatibleServer,
  probeServer,
  UNAVAILABLE_MESSAGE,
  type CompatDeps,
  type HealthProbe,
} from "../src/server-compat.js";
import {
  readServerIdentity,
  removeServerIdentity,
  serverIdentityPath,
  writeServerIdentity,
  type ServerIdentity,
} from "../src/server-identity.js";

const INSTALLED = "0.5.2";
const BASE = "http://127.0.0.1:5320";
const PID = 424_242;

function identity(overrides: Partial<ServerIdentity> = {}): ServerIdentity {
  return { pid: PID, version: "0.5.1", port: 5320, startedAt: "2026-11-03T10:00:00.000Z", ...overrides };
}

/**
 * Monde simulé : `probe` décrit ce qui répond, `alive` les pids vivants.
 * Aucun socket ni process réel — seule la logique de décision est exercée.
 */
function harness(world: {
  probe: () => HealthProbe;
  identity?: ServerIdentity | null;
  alive?: number[];
  onKill?: () => void;
  onSpawn?: () => void;
}) {
  const alive = new Set<number>(world.alive ?? []);
  const calls = { kills: [] as Array<{ pid: number; signal: NodeJS.Signals }>, spawned: 0, probes: 0 };
  let now = 0;
  const deps: CompatDeps = {
    installedVersion: INSTALLED,
    baseUrl: BASE,
    probeServer: async () => {
      calls.probes++;
      return world.probe();
    },
    readIdentity: () => world.identity ?? null,
    isAlive: (pid) => alive.has(pid),
    kill: (pid, signal) => {
      calls.kills.push({ pid, signal });
      alive.delete(pid);
      world.onKill?.();
    },
    spawnServer: () => {
      calls.spawned++;
      world.onSpawn?.();
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    startupAttempts: 3,
    startupPollMs: 1,
    stopTimeoutMs: 10,
    stopPollMs: 1,
  };
  return { deps, calls };
}

test("version du serveur égale à la version installée : connexion sans kill ni spawn", async () => {
  const { deps, calls } = harness({
    probe: () => ({ kind: "cogitator", version: INSTALLED }),
    identity: identity({ version: INSTALLED }),
    alive: [PID],
  });
  const outcome = await ensureCompatibleServer(deps);
  assert.deepEqual(outcome, { action: "connected", version: INSTALLED });
  assert.deepEqual(calls.kills, []);
  assert.equal(calls.spawned, 0);
});

test("version du serveur plus récente : connexion sans kill ni spawn", async () => {
  const { deps, calls } = harness({
    probe: () => ({ kind: "cogitator", version: "0.6.0" }),
    identity: identity({ version: "0.6.0" }),
    alive: [PID],
  });
  const outcome = await ensureCompatibleServer(deps);
  assert.equal(outcome.action, "connected");
  assert.deepEqual(calls.kills, []);
  assert.equal(calls.spawned, 0);
});

test("serveur plus ancien + pidfile cohérent : SIGTERM sur le bon pid puis un seul spawn", async () => {
  let phase: "old" | "stopped" | "new" = "old";
  const { deps, calls } = harness({
    probe: () =>
      phase === "new"
        ? { kind: "cogitator", version: INSTALLED }
        : phase === "old"
          ? { kind: "cogitator", version: "0.5.1" }
          : { kind: "down" },
    identity: identity(),
    alive: [PID],
    onKill: () => {
      phase = "stopped";
    },
    onSpawn: () => {
      phase = "new";
    },
  });
  const outcome = await ensureCompatibleServer(deps);
  assert.deepEqual(outcome, { action: "restarted", version: INSTALLED, stoppedPid: PID });
  assert.deepEqual(calls.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assert.equal(calls.spawned, 1);
});

test("serveur plus ancien mais pidfile absent : aucun kill, message d'erreur actuel", async () => {
  const { deps, calls } = harness({
    probe: () => ({ kind: "cogitator", version: "0.5.1" }),
    identity: null,
    alive: [PID],
  });
  const outcome = await ensureCompatibleServer(deps);
  assert.deepEqual(outcome, { action: "unavailable", reason: "incoherent-pidfile" });
  assert.deepEqual(calls.kills, []);
  assert.equal(calls.spawned, 0);
  assert.match(UNAVAILABLE_MESSAGE, /stop incompatible previous instances/);
});

for (const [label, identityOverride] of [
  ["version différente de celle qui répond", identity({ version: "0.5.0" })],
  ["pid mort", identity()],
  ["port différent", identity({ port: 5321 })],
] as const) {
  test(`serveur plus ancien mais pidfile incohérent (${label}) : aucun kill`, async () => {
    const { deps, calls } = harness({
      probe: () => ({ kind: "cogitator", version: "0.5.1" }),
      identity: identityOverride,
      alive: label === "pid mort" ? [] : [PID],
    });
    const outcome = await ensureCompatibleServer(deps);
    assert.deepEqual(outcome, { action: "unavailable", reason: "incoherent-pidfile" });
    assert.deepEqual(calls.kills, []);
    assert.equal(calls.spawned, 0);
  });
}

test("rien n'écoute : un spawn puis attente, comme aujourd'hui", async () => {
  let phase: "down" | "new" = "down";
  const { deps, calls } = harness({
    probe: () => (phase === "new" ? { kind: "cogitator", version: INSTALLED } : { kind: "down" }),
    onSpawn: () => {
      phase = "new";
    },
  });
  const outcome = await ensureCompatibleServer(deps);
  assert.deepEqual(outcome, { action: "started", version: INSTALLED });
  assert.equal(calls.spawned, 1);
  assert.deepEqual(calls.kills, []);
});

test("serveur plus ancien qui refuse de mourir : aucun redémarrage (jamais de SIGKILL)", async () => {
  const { deps, calls } = harness({
    probe: () => ({ kind: "cogitator", version: "0.5.1" }),
    identity: identity(),
    alive: [PID],
    onKill: () => undefined, // le pid reste marqué vivant
  });
  // le pid ne meurt pas : après la borne, on renonce au lieu d'escalader
  const outcome = await ensureCompatibleServer({ ...deps, isAlive: () => true });
  assert.deepEqual(outcome, { action: "unavailable", reason: "stop-timeout" });
  assert.deepEqual(calls.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assert.equal(calls.spawned, 0);
});

test("pidfile : écriture 0600, relecture, suppression conditionnée au pid", () => {
  const home = mkdtempSync(join(tmpdir(), "cogitator-pidfile-"));
  try {
    writeServerIdentity(home, identity());
    assert.equal(statSync(serverIdentityPath(home)).mode & 0o777, 0o600);
    assert.deepEqual(readServerIdentity(home), identity());
    removeServerIdentity(home, PID + 1); // autre instance : ne supprime rien
    assert.deepEqual(readServerIdentity(home), identity());
    removeServerIdentity(home, PID);
    assert.equal(readServerIdentity(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("garde de démarrage : refuse d'écraser un pidfile porté par un serveur qui répond", async () => {
  const home = mkdtempSync(join(tmpdir(), "cogitator-pidfile-"));
  try {
    writeServerIdentity(home, identity());
    await assert.rejects(
      assertNoLiveInstance(home, { probeServer: async () => ({ kind: "cogitator", version: "0.5.1" }), isAlive: (pid) => pid === PID }),
      /already running/,
    );
    // pid mort → pidfile périmé, remplaçable en silence
    await assert.doesNotReject(
      assertNoLiveInstance(home, { probeServer: async () => ({ kind: "down" }), isAlive: () => false }),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("probeServer : /api/health Cogitator → version lue", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.4.9", pi_version: "1.1.0", db: { version: 10 } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.deepEqual(await probeServer(url), { kind: "cogitator", version: "0.4.9" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("probeServer : /api/health non Cogitator → aucun kill, service étranger", async () => {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ hello: "world" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.deepEqual(await probeServer(url), { kind: "foreign" });
    const { deps, calls } = harness({ probe: () => ({ kind: "foreign" }), identity: identity(), alive: [PID] });
    const outcome = await ensureCompatibleServer({ ...deps, baseUrl: url });
    assert.deepEqual(outcome, { action: "unavailable", reason: "foreign-service" });
    assert.deepEqual(calls.kills, []);
    assert.equal(calls.spawned, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("compareVersions : semver simple et pré-versions", () => {
  assert.equal(compareVersions("0.5.2", "0.5.2"), 0);
  assert.equal(compareVersions("0.5.1", "0.5.2"), -1);
  assert.equal(compareVersions("0.6.0", "0.5.2"), 1);
  assert.equal(compareVersions("0.5", "0.5.0"), 0);
  assert.equal(compareVersions("0.5.2-dev.1", "0.5.2"), -1);
  assert.equal(compareVersions("0.5.2", "0.5.2-dev.1"), 1);
});
