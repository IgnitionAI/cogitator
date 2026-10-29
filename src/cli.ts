#!/usr/bin/env node
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { piCliPath, piCodingAgent } from "./host-pi.js";
import { authenticationRequired, HOST, PORT } from "./config.js";
import { CronService } from "./cron.js";
import { setConversationStatus } from "./conversations.js";
import { seedDefaultAgents } from "./default-agent.js";
import { openDb } from "./db.js";
import { getPaths } from "./paths.js";
import { PiPool } from "./pool.js";
import { createApp } from "./server.js";
import { authCommand } from "./auth-cli.js";
import { loadAuth, lockHome, protectedRequired, type AuthState } from "./auth-state.js";
import { listenOwnerSocket } from "./owner-transport.js";
import { makeSpawner } from "./spawner.js";
import { disposeSetprivShims, guardedRpcSpawn } from "./pi-child.js";
import { mkdirSync } from "node:fs";

const SWEEP_INTERVAL_MS = 60_000;
const CRON_TICK_MS = 30_000;
const paths = getPaths();
try {
  const required = authenticationRequired();
  const args = process.argv.slice(2);
  if (args[0] === "auth") await authCommand(paths.home, PORT, args.slice(1));
  else {
    if (args.length > 1 || args.some(arg => arg !== "--auth-required")) throw new Error("Usage: cogitator [--auth-required] | cogitator auth <init|recover|setup-key>");
    await start(required || args.length === 1);
  }
} catch (err) {
  console.error(`[cogitator] ${err instanceof Error ? err.message : "Startup failed"}`);
  process.exitCode = 1;
}

async function start(explicit: boolean): Promise<void> {
  mkdirSync(paths.home, { recursive: true });
  const unlock = process.platform === "win32" ? () => {} : lockHome(paths.home);
  let auth: AuthState | undefined;
  let db: ReturnType<typeof openDb>["db"] | undefined;
  const server = createServer((_req, res) => { res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" }); res.end('{"error":"AUTH_UNAVAILABLE"}'); });
  let privateServer: Server | undefined;
  try {
    auth = protectedRequired(paths.home, explicit) ? loadAuth(paths.home) : undefined;
    // Detect even an old incompatible binary on the configured port before catalog/seed side effects.
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(PORT, HOST, done); });
    privateServer = auth ? await listenOwnerSocket(server, paths.home) : undefined;
    const opened = openDb(paths.db);
    db = opened.db;
    seedDefaultAgents(db, paths);
    const catalog = db;
    const pool = new PiPool({
      factory: (opts) => new piCodingAgent.RpcClient(guardedRpcSpawn(piCliPath, opts)),
      callbacks: { onStatus: (convId, status) => setConversationStatus(catalog, convId, status) },
    });
    const events = new EventEmitter();
    const cron = new CronService({ db, pool, spawner: makeSpawner({ db, pool, paths }), notify: event => events.emit("event", event) });
    server.removeAllListeners("request");
    createApp({ db, dbPath: paths.db, dbVersion: opened.version, paths, pool, cron, events, auth, server });
    console.log(`[cogitator] ${auth ? auth.config.origin : `http://${HOST}:${PORT}`}`);
    const sweeper = setInterval(() => { pool.sweep().catch(() => undefined); }, SWEEP_INTERVAL_MS);
    cron.start(CRON_TICK_MS);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(sweeper); cron.stop();
      privateServer?.closeAllConnections(); server.closeAllConnections();
      await Promise.all([close(server), ...(privateServer ? [close(privateServer)] : [])]);
      await pool.dispose(); disposeSetprivShims(); auth?.db.close(); catalog.close(); unlock();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  } catch (err) {
    privateServer?.closeAllConnections(); server.closeAllConnections();
    if (privateServer?.listening) await close(privateServer);
    if (server.listening) await close(server);
    auth?.db.close(); db?.close(); unlock(); disposeSetprivShims();
    throw err;
  }
}
function close(server: Server): Promise<void> { return new Promise((done, reject) => server.close(err => err ? reject(err) : done())); }
