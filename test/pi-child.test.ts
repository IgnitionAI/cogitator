import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeSetprivShims, guardedRpcSpawn, linuxSetprivPath, piRpcWrapPath, reapStaleSetprivShims } from "../src/pi-child.js";
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

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** Repli watchdog : le wrapper doit relayer chaque signal d'arrêt à l'enfant qu'il a spawné. */
async function assertSignalKillsChild(signal: NodeJS.Signals): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `cog-wrap-${signal.toLowerCase()}-`));
  const fakeCli = join(dir, "fake-cli.js");
  writeFileSync(fakeCli, "setInterval(() => {}, 1000);\n");
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
  // Le wrapper installe ses handlers juste après `spawn` : laisser passer un tour pour éviter
  // de lui envoyer le signal avant (action par défaut = wrapper tué, enfant orphelin).
  await new Promise((r) => setTimeout(r, 200));
  try {
    process.kill(wrapPid, signal);
    await new Promise((r) => wrap.once("close", r));
    const goneDeadline = Date.now() + 2_000;
    while (!processIsGone(childPid) && Date.now() < goneDeadline) await new Promise((r) => setTimeout(r, 30));
    assert.equal(processIsGone(childPid), true, `${signal} au wrapper doit tuer l'enfant`);
  } finally {
    for (const pid of [wrapPid, childPid]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* déjà mort */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Non couvert : un cas avec un vrai binaire `pi`. RpcClient envoie le même SIGTERM/SIGINT/SIGHUP
// au même wrapper, et un vrai `pi` n'ajoute qu'un délai de démarrage (résolution providers) qui
// rendrait le test tributaire d'une installation locale : la sémantique de relais est déjà
// couverte ici, et le chemin setpriv (sans wrapper) est couvert par q1-real-pi.test.ts quand
// COGITATOR_PI_BIN est fourni.
test("SIGTERM/SIGINT/SIGHUP au wrapper tuent l'enfant (setpriv forcé off)", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-wrap-fallback-"));
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
    rmSync(dir, { recursive: true, force: true });
  }
  for (const signal of SIGNALS) await assertSignalKillsChild(signal);
});

const notLinux = process.platform === "linux" ? false : "/proc indisponible (hors Linux)";

test("reapStaleSetprivShims : shims orphelins supprimés, shim d'un process vivant conservé", { timeout: 15_000, skip: notLinux }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-shim-reap-"));
  const makeShimDir = (name: string): string => {
    const dir = join(home, name);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return dir;
  };
  const orphan = makeShimDir("pdeathsig-orphan");
  const live = makeShimDir("pdeathsig-live");
  // Un process vivant dont le PATH référence `live` : son shim ne doit jamais être ramassé.
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, PATH: `${live}:${process.env.PATH ?? ""}` },
    stdio: "ignore",
  });
  try {
    const holderPid = holder.pid;
    assert.ok(holderPid);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(`/proc/${holderPid}/environ`, "utf8").includes(live)) break;
      } catch { /* pas encore exec'é */ }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(reapStaleSetprivShims(home).includes(live), false, "le shim d'un process vivant est conservé");
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(orphan), false, "le shim orphelin est supprimé");
  } finally {
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("close", r));
    rmSync(home, { recursive: true, force: true });
  }
});

test("shim setpriv : PATH recalculé à l'exécution, sans le dossier du shim", { timeout: 15_000, skip: process.platform !== "linux" || !linuxSetprivPath() ? "setpriv indisponible" : false }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-shim-path-"));
  const runShim = (shimDir: string, path: string): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn(join(shimDir, "node"), ["-e", "process.stdout.write(process.env.PATH ?? '')"], {
      env: { ...process.env, PATH: path },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("exit", () => resolve(stdout));
  });
  try {
    const spawnOpts = guardedRpcSpawn("/tmp/missing-pi-cli.js", {
      cwd: home,
      args: [],
      env: { COGITATOR_HOME: home, PATH: process.env.PATH ?? "" },
    });
    const shimDir = spawnOpts.shimDir;
    assert.ok(shimDir);
    // Le PATH du shim est celui de l'appelant au moment de l'exécution, pas celui du premier spawn.
    assert.equal(await runShim(shimDir, `${shimDir}:/opt/late-path`), "/opt/late-path");
    assert.equal(await runShim(shimDir, shimDir), "", "PATH réduit au shim : vidé, pas de boucle sur le shim");
    assert.equal(await runShim(shimDir, `/opt/other:${shimDir}:/opt/late-path`), `/opt/other:${shimDir}:/opt/late-path`);
  } finally {
    disposeSetprivShims();
    rmSync(home, { recursive: true, force: true });
  }
});
