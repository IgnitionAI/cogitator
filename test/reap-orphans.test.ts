import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNED_PI_ENV, ownedPiMarker, processIsGone, reapOrphanOwnedPi, startPeriodicReap } from "../src/reap-orphans.js";

const SPAWNER = join(import.meta.dirname, "fixtures", "reap-orphan-spawn.ts");

function alive(pid: number): boolean {
  return !processIsGone(pid);
}

async function spawnMarked(home: string, opts: { marker: string; rpc: boolean }): Promise<number> {
  const args = opts.rpc
    ? ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc"]
    : ["-e", "setInterval(() => {}, 1000)"];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, [OWNED_PI_ENV]: opts.marker, COGITATOR_HOME: home },
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  child.unref();
  assert.ok(pid && pid > 0);
  await new Promise((r) => setTimeout(r, 150));
  return pid;
}

async function spawnOrphanViaHelper(home: string, mode: "rpc" | "plain" = "rpc"): Promise<number> {
  const helper = spawn(process.execPath, ["--import", "tsx", SPAWNER, home, mode], { stdio: ["ignore", "pipe", "pipe"] });
  const pid = Number(await new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    helper.stdout.on("data", (c: Buffer) => { out += String(c); });
    helper.stderr.on("data", (c: Buffer) => { err += String(c); });
    helper.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`spawn helper ${code}: ${err}`)));
  }));
  assert.ok(Number.isInteger(pid) && pid > 0, `pid orphelin invalide: ${pid}`);
  await new Promise((r) => setTimeout(r, 200));
  return pid;
}

function killPid(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* déjà mort */ }
}

test("reapOrphanOwnedPi tue un process marqué devenu orphelin (hôte mort, ppid quelconque)", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-"));
  const pid = await spawnOrphanViaHelper(home, "rpc");
  assert.equal(alive(pid), true, "l'orphelin doit encore vivre avant le reap");
  const { pids } = reapOrphanOwnedPi(home);
  assert.ok(pids.includes(pid), `reap n'a pas vu ${pid}: ${JSON.stringify(pids)}`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false, "l'orphelin doit être mort après SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

test("reapOrphanOwnedPi ne tue pas un process marqué dont l'hôte est vivant", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-live-"));
  const marker = ownedPiMarker();
  assert.ok(marker, "marqueur de l'hôte de test");
  const pid = await spawnMarked(home, { marker, rpc: true });
  assert.equal(alive(pid), true);
  const { pids } = reapOrphanOwnedPi(home);
  assert.equal(pids.includes(pid), false, `hôte vivant, tué à tort: ${JSON.stringify(pids)}`);
  assert.equal(alive(pid), true);
  killPid(pid);
  rmSync(home, { recursive: true, force: true });
});

test("reapOrphanOwnedPi ne tue pas un process sans marqueur", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-unmarked-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc"], {
    env: { ...process.env, COGITATOR_HOME: home },
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  child.unref();
  assert.ok(pid && pid > 0);
  await new Promise((r) => setTimeout(r, 150));
  const { pids } = reapOrphanOwnedPi(home);
  assert.equal(pids.includes(pid), false);
  assert.equal(alive(pid), true);
  killPid(pid);
  rmSync(home, { recursive: true, force: true });
});

test("reapOrphanOwnedPi ignore un descendant détaché sans cmdline --mode rpc", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-desc-"));
  const pid = await spawnOrphanViaHelper(home, "plain");
  assert.equal(alive(pid), true);
  const { pids } = reapOrphanOwnedPi(home);
  assert.equal(pids.includes(pid), false, `descendant non-rpc tué: ${JSON.stringify(pids)}`);
  assert.equal(alive(pid), true);
  killPid(pid);
  rmSync(home, { recursive: true, force: true });
});

test("reapOrphanOwnedPi traite un starttime d'hôte falsifié comme orphelin", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-forge-"));
  const pid = await spawnMarked(home, { marker: `${process.pid}:1`, rpc: true });
  assert.equal(alive(pid), true);
  const { pids } = reapOrphanOwnedPi(home);
  assert.ok(pids.includes(pid), `starttime falsifié non reaped: ${JSON.stringify(pids)}`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false);
  rmSync(home, { recursive: true, force: true });
});

test("reap périodique tue un orphelin rpc sans tuer un hôte vivant", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-loop-"));
  const orphan = await spawnOrphanViaHelper(home, "rpc");
  const marker = ownedPiMarker();
  assert.ok(marker);
  const live = await spawnMarked(home, { marker, rpc: true });
  const loop = startPeriodicReap(home, 40);
  const deadline = Date.now() + 3_000;
  while (alive(orphan) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
  loop.stop();
  assert.equal(alive(orphan), false, "le reap périodique doit tuer l'orphelin");
  assert.equal(alive(live), true, "l'hôte vivant ne doit pas être tué");
  killPid(live);
  rmSync(home, { recursive: true, force: true });
});
