import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeSetprivShims, guardedRpcSpawn, linuxSetprivPath, piRpcWrapPath } from "../src/pi-child.js";
import { parseProcStat, processIsGone } from "../src/reap-orphans.js";

function childOf(ppid: number): number | undefined {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = parseProcStat(readFileSync(join("/proc", name, "stat"), "utf8"));
      if (stat?.ppid === ppid) return pid;
    } catch { /* disparu */ }
  }
  return undefined;
}

test("shim setpriv : mkdtemp sous home en 0700, nettoyé à dispose", { skip: process.platform !== "linux" || !linuxSetprivPath() ? "setpriv indisponible" : false }, () => {
  const home = mkdtempSync(join(tmpdir(), "cog-shim-home-"));
  try {
    const spawnOpts = guardedRpcSpawn("/tmp/missing-pi-cli.js", {
      cwd: home,
      args: [],
      env: { COGITATOR_HOME: home, PATH: process.env.PATH ?? "" },
    });
    assert.ok(spawnOpts.shimDir);
    assert.ok(spawnOpts.shimDir.startsWith(home + "/"));
    assert.equal(lstatSync(spawnOpts.shimDir).mode & 0o777, 0o700);
    disposeSetprivShims();
    assert.equal(existsSync(spawnOpts.shimDir), false);
  } finally {
    disposeSetprivShims();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SIGTERM au wrapper tue l'enfant (setpriv forcé off)", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-wrap-term-"));
  const fakeCli = join(dir, "fake-cli.js");
  writeFileSync(fakeCli, "setInterval(() => {}, 1000);\n");
  const prev = process.env.COGITATOR_PI_NO_SETPRIV;
  process.env.COGITATOR_PI_NO_SETPRIV = "1";
  try {
    const forced = guardedRpcSpawn(fakeCli, { cwd: dir, args: ["--mode", "rpc"], env: { COGITATOR_HOME: dir } });
    assert.equal(forced.cliPath, piRpcWrapPath());
    assert.equal(forced.shimDir, undefined);
  } finally {
    if (prev === undefined) delete process.env.COGITATOR_PI_NO_SETPRIV;
    else process.env.COGITATOR_PI_NO_SETPRIV = prev;
  }
  const wrap = spawn(process.execPath, [piRpcWrapPath(), "--mode", "rpc"], {
    env: { ...process.env, COGITATOR_PI_CLI: fakeCli, COGITATOR_PI_NO_SETPRIV: "1" },
    stdio: "ignore",
  });
  const wrapPid = wrap.pid;
  assert.ok(wrapPid);
  let childPid: number | undefined;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    childPid = childOf(wrapPid);
    if (childPid) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(childPid, "l'enfant du wrapper doit exister");
  process.kill(wrapPid, "SIGTERM");
  await new Promise((r) => wrap.once("close", r));
  const goneDeadline = Date.now() + 2_000;
  while (!processIsGone(childPid) && Date.now() < goneDeadline) await new Promise((r) => setTimeout(r, 30));
  assert.equal(processIsGone(childPid), true, "SIGTERM au wrapper doit tuer l'enfant");
  rmSync(dir, { recursive: true, force: true });
});
