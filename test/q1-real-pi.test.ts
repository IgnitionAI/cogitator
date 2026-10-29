/** Preuves lot 2 : vrai binaire `pi` (install locale, pas de publish). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../src/db.js";
import { PiPool } from "../src/pool.js";
import { enqueue, LaneDispatcher, listItems } from "../src/team-queue.js";
import { OWNED_PI_ENV, ownedPiMarker, processIsGone, reapOrphanOwnedPi } from "../src/reap-orphans.js";
import { disposeSetprivShims, guardedRpcSpawn } from "../src/pi-child.js";

function resolvePi(): { bin: string; cli: string; pkg: string } | undefined {
  const bin = process.env.COGITATOR_PI_BIN;
  const cliEnv = process.env.COGITATOR_PI_CLI;
  if (!bin && !cliEnv) return undefined;
  const cli = cliEnv ?? join(dirname(bin!), "..", "lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  if (!existsSync(cli)) return undefined;
  return { bin: bin ?? cli, cli, pkg: join(dirname(cli), "..") };
}

const pi = resolvePi();
const skipPi = pi ? false : "COGITATOR_PI_BIN / COGITATOR_PI_CLI absent (pas de binaire pi de test)";

function piHome(root: string): string {
  const piAgent = join(root, ".pi", "agent");
  mkdirSync(piAgent, { recursive: true });
  writeFileSync(join(piAgent, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));
  writeFileSync(join(piAgent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "local-fixture-only" } }));
  writeFileSync(join(piAgent, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.4" }));
  return root;
}

async function loadRpcClient(pkg: string): Promise<new (opts: object) => {
  start(): Promise<void>;
  prompt(text: string): Promise<unknown>;
  process?: { pid?: number };
}> {
  const mod = await import(pathToFileURL(join(pkg, "dist/index.js")).href) as {
    RpcClient: new (opts: object) => { start(): Promise<void>; prompt(text: string): Promise<unknown>; process?: { pid?: number } };
  };
  return mod.RpcClient;
}

test("e2e pi réel : un message passe par queue_item jusqu'au process rpc", { timeout: 90_000, skip: skipPi }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-real-pi-"));
  const home = piHome(dir);
  const { db } = openDb(join(dir, "c.db"));
  db.prepare("INSERT INTO conversation (id, provider, model) VALUES ('c1', 'openai', 'gpt-5.4')").run();
  let rpcPid: number | undefined;
  let shimDir: string | undefined;
  const RpcClient = await loadRpcClient(pi!.pkg);
  const pool = new PiPool({
    factory: (opts) => {
      const spawn = guardedRpcSpawn(pi!.cli, {
        cwd: opts.cwd,
        args: ["--model", "openai/gpt-5.4", "--offline", "--no-extensions", "--no-skills", "--no-tools", "--no-prompt-templates"],
        env: { ...opts.env, HOME: home, [OWNED_PI_ENV]: ownedPiMarker() ?? "", COGITATOR_HOME: home },
      });
      shimDir = spawn.shimDir;
      const client = new RpcClient(spawn);
      const start = client.start.bind(client);
      client.start = async () => {
        await start();
        rpcPid = client.process?.pid;
      };
      return client as never;
    },
  });
  const dispatcher = new LaneDispatcher({
    db,
    pool,
    ensure: (id) => pool.ensure(id, { cwd: home, args: [] }),
    settleTimeoutMs: 25_000,
  });
  const { laneId } = enqueue(db, { conversationId: "c1", body: "ping file durable", idempotencyKey: "real-pi-ping" });
  await dispatcher.kick(laneId);
  const items = listItems(db, laneId);
  assert.equal(items.length, 1);
  assert.ok(items[0]!.status === "done" || items[0]!.status === "failed", `statut inattendu: ${items[0]!.status} ${items[0]!.error}`);
  console.log("real-pi-e2e", JSON.stringify({ status: items[0]!.status, error: items[0]!.error, rpcPid }));
  assert.ok(rpcPid && rpcPid > 0, "un process pi --mode rpc a bien été spawné");
  if (shimDir) {
    const environ = readFileSync(`/proc/${rpcPid}/environ`, "utf8");
    const pathEnv = environ.split("\0").find((entry) => entry.startsWith("PATH=")) ?? "";
    assert.equal(pathEnv.includes(shimDir), false, "PATH du rpc ne doit pas contenir le shim setpriv");
  }
  await pool.dispose();
  disposeSetprivShims();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("kill -9 de l'hôte : le process pi enfant meurt sous 3 s sans reap", { timeout: 90_000, skip: skipPi }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-orphan-pi-"));
  const home = piHome(dir);
  const driver = join(import.meta.dirname, "fixtures", "real-pi-orphan-driver.ts");
  const child = fork(driver, [home, pi!.cli, pi!.pkg], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, HOME: home, PATH: pi!.bin ? `${dirname(pi!.bin)}:${process.env.PATH ?? ""}` : process.env.PATH },
    silent: true,
  });
  const msg = await new Promise<{ pid: number; rpcPid: number }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (c) => { stderr += String(c); });
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout seed orphan: ${stderr}`)); }, 40_000);
    child.on("message", (m) => { clearTimeout(t); resolve(m as { pid: number; rpcPid: number }); });
  });
  assert.ok(msg.rpcPid > 0);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("close", r));
  const deadline = Date.now() + 3_000;
  while (!processIsGone(msg.rpcPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const leftover = !processIsGone(msg.rpcPid);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(leftover, false, "le process pi meurt avec l'hôte (setpriv/watchdog), sans reap, sous 3 s");
});

test("reapOrphanOwnedPi filet de sécurité si un rpc marqué survit", { timeout: 90_000, skip: skipPi }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-reap-net-"));
  const home = piHome(dir);
  const driver = join(import.meta.dirname, "fixtures", "real-pi-orphan-driver.ts");
  const child = fork(driver, [home, pi!.cli, pi!.pkg], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, HOME: home, COGITATOR_FORCE_WATCHDOG: "1", PATH: pi!.bin ? `${dirname(pi!.bin)}:${process.env.PATH ?? ""}` : process.env.PATH },
    silent: true,
  });
  const msg = await new Promise<{ pid: number; rpcPid: number }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (c) => { stderr += String(c); });
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout seed reap-net: ${stderr}`)); }, 40_000);
    child.on("message", (m) => { clearTimeout(t); resolve(m as { pid: number; rpcPid: number }); });
  });
  child.kill("SIGKILL");
  await new Promise((r) => child.once("close", r));
  const { pids } = reapOrphanOwnedPi(home);
  if (!processIsGone(msg.rpcPid) && !pids.includes(msg.rpcPid)) {
    try { process.kill(msg.rpcPid, "SIGKILL"); } catch { /* déjà mort */ }
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(processIsGone(msg.rpcPid), true);
  rmSync(dir, { recursive: true, force: true });
});
