import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { getPaths } from "../src/paths.js";
import { SelfUpdater, selfUpdateSupport, spawnRelauncher, type SelfUpdateDeps } from "../src/self-update.js";
import { PackageManager } from "../src/packages.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { PiPool } from "../src/pool.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("support : installation gérée par pi uniquement (ni source, ni service)", () => {
  const home = mkdtempSync(join(tmpdir(), "cog-su-"));
  try {
    const paths = getPaths({ COGITATOR_HOME: home, COGITATOR_PI_AGENT_DIR: join(home, "pi") });
    const managed = join(home, "pi", "npm", "node_modules", "@ignitionai", "cogitator");
    const source = join(home, "opt", "cogitator");
    mkdirSync(managed, { recursive: true }); mkdirSync(source, { recursive: true });
    assert.deepEqual(selfUpdateSupport(paths, managed, {}), { supported: true });
    assert.deepEqual(selfUpdateSupport(paths, source, {}), { supported: false, reason: "NOT_PI_MANAGED" });
    assert.deepEqual(selfUpdateSupport(paths, null, {}), { supported: false, reason: "SOURCE_BUILD" });
    assert.deepEqual(selfUpdateSupport(paths, managed, { INVOCATION_ID: "x" }), { supported: false, reason: "SERVICE_MANAGED" });
    assert.deepEqual(selfUpdateSupport(paths, managed, { COGITATOR_SELF_UPDATE: "0" }), { supported: false, reason: "SERVICE_MANAGED" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function fakeDeps(over: Partial<SelfUpdateDeps> = {}) {
  const calls: string[] = [];
  let installed = "0.6.0";
  const deps: SelfUpdateDeps = {
    support: () => ({ supported: true }),
    release: async () => ({ current: "0.6.0", latest: "0.7.0", status: "available" }),
    busy: async () => 0,
    install: async (source) => { calls.push(`install ${source}`); installed = "0.7.0"; },
    installedVersion: () => installed,
    relaunch: () => { calls.push("relaunch"); },
    shutdown: () => { calls.push("shutdown"); },
    ...over,
  };
  return { deps, calls };
}

test("mise à jour : refus (non supporté, à jour, occupé), puis installation → relance → arrêt", async () => {
  await assert.rejects(new SelfUpdater(fakeDeps({ support: () => ({ supported: false, reason: "NOT_PI_MANAGED" }) }).deps).start(), /SELF_UPDATE_NOT_PI_MANAGED/);
  await assert.rejects(new SelfUpdater(fakeDeps({ release: async () => ({ current: "0.7.0", latest: "0.7.0", status: "current" }) }).deps).start(), /SELF_UPDATE_NOT_AVAILABLE/);
  const busy = fakeDeps({ busy: async () => 2 });
  await assert.rejects(new SelfUpdater(busy.deps).start(), /SELF_UPDATE_BUSY/);
  assert.deepEqual(busy.calls, [], "rien installé tant que des conversations travaillent");

  const { deps, calls } = fakeDeps({ busy: async () => 1 });
  const updater = new SelfUpdater(deps);
  const started = await updater.start(true);
  assert.deepEqual(started, { status: "installing", target: "0.7.0" });
  await assert.rejects(updater.start(true), /SELF_UPDATE_RUNNING/);
  await wait(20);
  assert.equal(updater.state.status, "restarting");
  assert.deepEqual(calls, ["install npm:@ignitionai/cogitator@0.7.0", "relaunch"]);
  await wait(600);
  assert.deepEqual(calls.at(-1), "shutdown");
});

test("mise à jour : échec d'installation ou mauvaise version → erreur, pas de redémarrage", async () => {
  const failing = fakeDeps({ install: async () => { throw new Error("La commande pi a échoué"); } });
  const a = new SelfUpdater(failing.deps); await a.start(); await wait(20);
  assert.equal(a.state.status, "error"); assert.match(a.state.error!, /pi a échoué/);
  assert.ok(!failing.calls.includes("relaunch"));
  const mismatch = fakeDeps({ install: async () => {}, installedVersion: () => "0.6.0" });
  const b = new SelfUpdater(mismatch.deps); await b.start(); await wait(20);
  assert.equal(b.state.status, "error"); assert.match(b.state.error!, /inattendue/);
  assert.ok(!mismatch.calls.includes("relaunch"));
  // Une nouvelle tentative reste possible après une erreur.
  await assert.doesNotReject(b.start());
});

test("relanceur réel : attend la sortie du processus, puis relance la commande", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-relaunch-"));
  try {
    const marker = join(dir, "started");
    const old = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600)"], { stdio: "ignore" });
    spawnRelauncher(old.pid!, process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`]);
    await wait(300);
    assert.equal(existsSync(marker), false, "pas de relance tant que l'ancien processus vit");
    for (let i = 0; i < 50 && !existsSync(marker); i++) await wait(100);
    assert.equal(existsSync(marker), true, "relancé après la sortie");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("extensions : « Tout mettre à jour » installe les versions plus récentes (hors Cogitator), recharge une fois", async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-pkg-"));
  const realFetch = globalThis.fetch;
  try {
    const paths = getPaths({ COGITATOR_HOME: home, COGITATOR_PI_AGENT_DIR: join(home, "pi") });
    const versions: Record<string, [string, string]> = { "pi-a": ["1.0.0", "1.1.0"], "pi-b": ["2.0.0", "2.0.0"], "pi-c": ["1.0.0", "1.2.0"], "@ignitionai/cogitator": ["0.6.0", "0.7.0"] };
    mkdirSync(join(home, "pi"), { recursive: true });
    writeFileSync(join(home, "pi", "settings.json"), JSON.stringify({ packages: Object.keys(versions).map((n) => `npm:${n}`) }));
    for (const [name, [installed]] of Object.entries(versions)) {
      const dir = join(home, "pi", "npm", "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: installed }));
    }
    globalThis.fetch = (async (url: string) => {
      const name = decodeURIComponent(String(url).split("/").slice(-2, -1)[0]!);
      const latest = versions[name]![1];
      const keywords = name === "pi-c" ? [] : ["pi-package"]; // pi-c n'est plus un package pi valide
      return new Response(JSON.stringify({ name, version: latest, keywords }), { status: 200 });
    }) as typeof fetch;
    const runs: string[] = [];
    let refreshes = 0;
    const manager = new PackageManager(paths, async () => { refreshes++; return 0; }, async (action, source) => { runs.push(`${action} ${source}`); });
    const op = manager.startAll(["@ignitionai/cogitator"]);
    for (let i = 0; i < 50 && op.status === "running"; i++) await wait(20);
    assert.equal(op.status, "done");
    assert.deepEqual(runs, ["install npm:pi-a@1.1.0"]);
    assert.deepEqual(op.updated, ["pi-a"]);
    assert.deepEqual(op.failed?.map((f) => f.name), ["pi-c"]);
    assert.equal(op.total, 2);
    assert.equal(refreshes, 1, "une seule recharge des extensions");
    assert.throws(() => { manager.startAll(); manager.startAll(); }, /déjà en cours/);
  } finally { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); }
});

test("HTTP : état, application avec dépendances injectées, refus si occupé", async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-su-http-"));
  const { db, version } = openDb(join(home, "c.db"));
  const { deps, calls } = fakeDeps({ busy: async () => 1 });
  const app = createApp({ db, dbPath: join(home, "c.db"), dbVersion: version, paths: getPaths({ COGITATOR_HOME: home }),
    pool: new PiPool({ factory: () => { throw new Error("no pi"); } }), selfUpdate: deps });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const post = (body: unknown) => fetch(`${base}/api/app-updates/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const busy = await post({});
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { error: "SELF_UPDATE_BUSY", busy: 1 });
    const ok = await post({ force: true });
    assert.equal(ok.status, 202);
    await wait(30);
    const state = await (await fetch(`${base}/api/app-updates/state`)).json();
    assert.equal(state.state.status, "restarting");
    assert.equal(state.state.target, "0.7.0");
    assert.ok(calls.includes("relaunch"));
  } finally { app.close(); db.close(); rmSync(home, { recursive: true, force: true }); }
});
