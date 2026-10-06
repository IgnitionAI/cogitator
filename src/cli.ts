#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { HOST, PORT } from "./config.js";
import { openDb } from "./db.js";
import { getPaths } from "./paths.js";
import { createApp } from "./server.js";

const paths = getPaths();
mkdirSync(paths.home, { recursive: true });
const { db, version } = openDb(paths.db);
const server = createApp({ db, dbPath: paths.db, dbVersion: version, paths });

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

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
