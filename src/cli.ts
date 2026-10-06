#!/usr/bin/env node
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import { HOST, PORT } from "./config.js";
import { CronService } from "./cron.js";
import { setConversationStatus } from "./conversations.js";
import { seedDefaultAgent } from "./default-agent.js";
import { openDb } from "./db.js";
import { getPaths } from "./paths.js";
import { PiPool } from "./pool.js";
import { createApp } from "./server.js";
import { makeSpawner } from "./spawner.js";

const paths = getPaths();
mkdirSync(paths.home, { recursive: true });
const { db, version } = openDb(paths.db);

// Seed du Majordome (agent opérateur par défaut) si aucun agent n'existe
{
  const { created } = seedDefaultAgent(db, paths);
  if (created) console.log("[cogitator] agent par défaut créé : Majordome");
}

// I3 : tout spawn passe par ce pool (factory RpcClient officiel, cli.js du pi résolu)
const factory = (opts: { cwd: string; args: string[]; env?: Record<string, string> }) =>
  new RpcClient({ cliPath: join(getPackageDir(), "dist/cli.js"), cwd: opts.cwd, args: opts.args, env: opts.env });

const pool = new PiPool({
  factory,
  callbacks: { onStatus: (convId, status) => setConversationStatus(db, convId, status) },
});

const events = new EventEmitter();
const spawner = makeSpawner({ db, pool, paths });
const cron = new CronService({
  db, pool, spawner,
  notify: (event) => events.emit("event", event),
});

const server = createApp({ db, dbPath: paths.db, dbVersion: version, paths, pool, cron, events });

server.listen(PORT, HOST, () => {
  console.log(`[cogitator] http://${HOST}:${PORT}`);
  console.log(`[cogitator] data: ${paths.home}`);
  console.log(`[cogitator] pi agents: ${paths.piAgentsDir}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[cogitator] port ${PORT} déjà utilisé — Cogitator tourne déjà ? (COGITATOR_PORT pour changer)`);
    process.exit(1);
  }
  throw err;
});

// Recyclage idle toutes les minutes
const sweeper = setInterval(() => {
  pool.sweep().catch(() => undefined);
}, 60_000);
cron.start(30_000); // tick cron toutes les 30 s

async function shutdown(): Promise<void> {
  clearInterval(sweeper);
  cron.stop();
  await pool.dispose();
  server.close();
  db.close();
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown());
}
