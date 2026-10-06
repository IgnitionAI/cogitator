#!/usr/bin/env node
import { join } from "node:path";
import { HOST, PORT, HOME } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./server.js";

const { db, version } = openDb();
const server = createApp({ db, dbPath: join(HOME, "cogitator.db"), dbVersion: version });

server.listen(PORT, HOST, () => {
  console.log(`[cogitator] http://${HOST}:${PORT}`);
  console.log(`[cogitator] data: ${HOME}`);
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
