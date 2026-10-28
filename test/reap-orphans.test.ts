import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNED_PI_ENV, reapOrphanOwnedPi } from "../src/reap-orphans.js";

test("reapOrphanOwnedPi tue un process marqué devenu orphelin (ppid 1)", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-reap-"));
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const env = { ...process.env, ${JSON.stringify(OWNED_PI_ENV)}: "1", COGITATOR_HOME: ${JSON.stringify(home)} };
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env, detached: true, stdio: "ignore" });
    process.stdout.write(String(g.pid));
    g.unref();
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const pid = Number(await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += String(c); });
    child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`spawn helper ${code}`)));
  }));
  assert.ok(Number.isInteger(pid) && pid > 0, `pid orphelin invalide: ${pid}`);
  await new Promise((r) => setTimeout(r, 200));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, true, "l'orphelin doit encore vivre avant le reap");
  const { pids } = reapOrphanOwnedPi(home);
  assert.ok(pids.includes(pid), `reap n'a pas vu ${pid}: ${JSON.stringify(pids)}`);
  await new Promise((r) => setTimeout(r, 100));
  let still = true;
  try { process.kill(pid, 0); } catch { still = false; }
  assert.equal(still, false, "l'orphelin doit être mort après SIGKILL");
  rmSync(home, { recursive: true, force: true });
});
