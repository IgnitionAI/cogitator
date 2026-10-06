import { createServer, type Server } from "node:http";
import type { Db } from "./db.js";
import { packageVersion, piVersion } from "./pi.js";

const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>Cogitator</title>
<style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
main{text-align:center}h1{font-weight:600;letter-spacing:.02em}p{color:#8b949e}</style></head>
<body><main><h1>Cogitator</h1><p>Panneau de contrôle pi — M0 : serveur en ligne. L'UI arrive en M6.</p></main></body>
</html>`;

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface AppOptions {
  db: Db;
  dbPath: string;
  dbVersion: number;
}

export function createApp(opts: AppOptions): Server {
  const { db, dbPath, dbVersion } = opts;
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        version: packageVersion(),
        pi_version: piVersion(),
        sessions_active: 0, // pool en M2
        db: { path: dbPath, version: dbVersion },
      });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

export { sendJson };
