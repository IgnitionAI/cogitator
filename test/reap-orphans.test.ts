import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNED_PI_ENV, ownedPiMarker, reapOrphanOwnedPi } from "../src/reap-orphans.js";

const SPAWNER = join(import.meta.dirname, "fixtures", "reap-orphan-spawn.ts");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("reapOrphanOwnedPi tue un process marqué devenu orphelin (hôte mort, ppid quelconque)", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-"));
  const helper = spawn(process.execPath, ["--import", "tsx", SPAWNER, home], { stdio: ["ignore", "pipe", "pipe"] });
  const pid = Number(await new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    helper.stdout.on("data", (c: Buffer) => { out += String(c); });
    helper.stderr.on("data", (c: Buffer) => { err += String(c); });
    helper.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`spawn helper ${code}: ${err}`)));
  }));
  assert.ok(Number.isInteger(pid) && pid > 0, `pid orphelin invalide: ${pid}`);
  await new Promise((r) => setTimeout(r, 200));
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
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, [OWNED_PI_ENV]: marker, COGITATOR_HOME: home },
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  child.unref();
  assert.ok(pid && pid > 0);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(alive(pid), true);
  const { pids } = reapOrphanOwnedPi(home);
  assert.equal(pids.includes(pid), false, `hôte vivant, tué à tort: ${JSON.stringify(pids)}`);
  assert.equal(alive(pid), true);
  try { process.kill(pid, "SIGKILL"); } catch { /* déjà mort */ }
  rmSync(home, { recursive: true, force: true });
});

test("reapOrphanOwnedPi ne tue pas un process sans marqueur", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-unmarked-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
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
  try { process.kill(pid, "SIGKILL"); } catch { /* déjà mort */ }
  rmSync(home, { recursive: true, force: true });
});
