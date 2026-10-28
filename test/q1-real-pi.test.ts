/** Preuves lot 2 : vrai binaire `pi` (install locale, pas de publish). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../src/db.js";
import { PiPool } from "../src/pool.js";
import { enqueue, LaneDispatcher, listItems } from "../src/team-queue.js";
import { OWNED_PI_ENV, reapOrphanOwnedPi } from "../src/reap-orphans.js";

const PI_BIN = "/workspace/ci-local/pi-prefix/bin/pi";
const PI_CLI = "/workspace/ci-local/pi-prefix/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const PI_PKG = join(dirname(PI_CLI), "..");
const havePi = existsSync(PI_BIN) && existsSync(PI_CLI);

function piHome(root: string): string {
  const piAgent = join(root, ".pi", "agent");
  mkdirSync(piAgent, { recursive: true });
  writeFileSync(join(piAgent, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));
  writeFileSync(join(piAgent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "local-fixture-only" } }));
  writeFileSync(join(piAgent, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.4" }));
  return root;
}

async function loadRpcClient(): Promise<new (opts: object) => {
  start(): Promise<void>;
  prompt(text: string): Promise<unknown>;
  process?: { pid?: number };
}> {
  const mod = await import(pathToFileURL(join(PI_PKG, "dist/index.js")).href) as {
    RpcClient: new (opts: object) => { start(): Promise<void>; prompt(text: string): Promise<unknown>; process?: { pid?: number } };
  };
  return mod.RpcClient;
}

test("e2e pi réel : un message passe par queue_item jusqu'au process rpc", { timeout: 90_000, skip: !havePi }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-real-pi-"));
  const home = piHome(dir);
  const { db } = openDb(join(dir, "c.db"));
  db.prepare("INSERT INTO conversation (id, provider, model) VALUES ('c1', 'openai', 'gpt-5.4')").run();
  let rpcPid: number | undefined;
  const RpcClient = await loadRpcClient();
  const pool = new PiPool({
    factory: (opts) => {
      const client = new RpcClient({
        cliPath: PI_CLI,
        cwd: opts.cwd,
        args: ["--model", "openai/gpt-5.4", "--offline", "--no-extensions", "--no-skills", "--no-tools", "--no-prompt-templates"],
        env: { ...opts.env, HOME: home, [OWNED_PI_ENV]: "1", COGITATOR_HOME: home },
      });
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
  await pool.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("kill -9 de l'hôte : le process pi enfant meurt (stdin coupé), pas d'orphelin durable", { timeout: 90_000, skip: !havePi }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-orphan-pi-"));
  const home = piHome(dir);
  const driver = join(import.meta.dirname, "fixtures", "real-pi-orphan-driver.ts");
  const child = fork(driver, [home, PI_CLI, PI_PKG], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, HOME: home, PATH: `${dirname(PI_BIN)}:${process.env.PATH ?? ""}` },
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
  await new Promise((r) => setTimeout(r, 400));
  let leftover = true;
  try { process.kill(msg.rpcPid, 0); } catch { leftover = false; }
  if (leftover) {
    const { pids } = reapOrphanOwnedPi(home);
    if (!pids.includes(msg.rpcPid)) {
      try { process.kill(msg.rpcPid, "SIGKILL"); } catch { /* déjà mort */ }
    }
    await new Promise((r) => setTimeout(r, 150));
    let still = true;
    try { process.kill(msg.rpcPid, 0); } catch { still = false; }
    assert.equal(still, false, "si un orphelin survit, le reap (ou SIGKILL) doit l'éliminer");
  }
  rmSync(dir, { recursive: true, force: true });
  // RpcClient spawn sans detached : SIGKILL de l'hôte ferme le stdin du rpc → le process pi meurt.
  assert.equal(leftover, false, "le process pi meurt avec l'hôte (stdin coupé), pas d'orphelin durable");
});
