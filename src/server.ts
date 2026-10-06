import { execFile } from "node:child_process";
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import type { Db } from "./db.js";
import { packageVersion, piVersion } from "./pi.js";
import type { Paths } from "./paths.js";
import {
  API_PROTOCOLS, deleteProvider, listProviders, listSkills, mcpAdapterDetected,
  readMcp, upsertProvider, validateMcpConfig, writeMcp, type ProviderInput,
} from "./registry.js";
import {
  applyAgent, createAgent, deleteAgent, getAgent, listAgents, unapplyAgent,
  updateAgent, validateAgent, type AgentInput,
} from "./agents.js";

const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>Cogitator</title>
<style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
main{text-align:center}h1{font-weight:600;letter-spacing:.02em}p{color:#8b949e}</style></head>
<body><main><h1>Cogitator</h1><p>Panneau de contrôle pi — serveur en ligne. L'UI complète arrive en M6.</p></main></body>
</html>`;

// ---------- Mini routeur ----------

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}

type Handler = (ctx: Ctx) => Promise<void> | void;
type Route = [method: string, pattern: string, handler: Handler];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function matchRoute(routes: Route[], method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const pSeg = pattern.split("/").filter(Boolean);
    const uSeg = pathname.split("/").filter(Boolean);
    if (pSeg.length !== uSeg.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pSeg.length; i++) {
      const p = pSeg[i]!;
      const u = uSeg[i]!;
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(u);
      else if (p !== u) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error("body trop volumineux")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("JSON invalide")); }
    });
    req.on("error", reject);
  });
}

// ---------- App ----------

// Checker auth réel pour la route validate (la fonction validateAgent reste injectable pour les tests)
function checkAuthReadyFor(provider: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("pi", ["auth", "check", "--provider", provider, "--json"], { timeout: 15_000 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout).status === "ready"); }
      catch { resolve(err ? false : null); }
    });
  });
}

export interface AppOptions {
  db: Db;
  dbPath: string;
  dbVersion: number;
  paths: Paths;
}

export function createApp(opts: AppOptions): Server {
  const { db, dbPath, dbVersion, paths } = opts;

  const routes: Route[] = [
    ["GET", "/api/health", (ctx) => {
      sendJson(ctx.res, 200, {
        ok: true,
        version: packageVersion(),
        pi_version: piVersion(),
        sessions_active: 0, // pool en M2
        mcp_adapter_detected: mcpAdapterDetected(paths),
        db: { path: dbPath, version: dbVersion },
      });
    }],

    // Registry
    ["GET", "/api/providers", async (ctx) => {
      sendJson(ctx.res, 200, { providers: await listProviders(paths) });
    }],
    ["POST", "/api/providers", (ctx) => {
      const b = (ctx.body ?? {}) as ProviderInput & { id?: string };
      if (!b.id) return sendJson(ctx.res, 400, { error: "id requis" });
      const { error } = upsertProvider(paths, b.id, b);
      if (error) return sendJson(ctx.res, 400, { error });
      sendJson(ctx.res, 201, { ok: true });
    }],
    ["PUT", "/api/providers/:id", (ctx) => {
      const { error } = upsertProvider(paths, ctx.params.id!, (ctx.body ?? {}) as ProviderInput);
      if (error) return sendJson(ctx.res, 400, { error });
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["DELETE", "/api/providers/:id", (ctx) => {
      deleteProvider(paths, ctx.params.id!);
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["GET", "/api/skills", (ctx) => {
      sendJson(ctx.res, 200, { skills: listSkills(paths) });
    }],
    ["GET", "/api/mcp", (ctx) => {
      sendJson(ctx.res, 200, readMcp(paths));
    }],
    ["PUT", "/api/mcp", (ctx) => {
      const invalid = validateMcpConfig(ctx.body);
      if (invalid) return sendJson(ctx.res, 400, { error: invalid });
      writeMcp(paths, ctx.body as { mcpServers: Record<string, unknown> });
      sendJson(ctx.res, 200, { ok: true });
    }],

    // Agents
    ["GET", "/api/agents", (ctx) => {
      sendJson(ctx.res, 200, { agents: listAgents(db) });
    }],
    ["POST", "/api/agents", (ctx) => {
      const input = ctx.body as AgentInput;
      if (!input?.name || !input?.provider || !input?.model) {
        return sendJson(ctx.res, 400, { error: "name, provider, model requis" });
      }
      const preset = createAgent(db, input);
      const apply = applyAgent(paths, preset);
      sendJson(ctx.res, 201, { agent: preset, apply });
    }],
    ["GET", "/api/agents/:id", (ctx) => {
      const agent = getAgent(db, ctx.params.id!);
      if (!agent) return sendJson(ctx.res, 404, { error: "agent introuvable" });
      sendJson(ctx.res, 200, { agent });
    }],
    ["PUT", "/api/agents/:id", (ctx) => {
      const preset = updateAgent(db, ctx.params.id!, ctx.body as AgentInput);
      if (!preset) return sendJson(ctx.res, 404, { error: "agent introuvable" });
      const apply = applyAgent(paths, preset);
      sendJson(ctx.res, 200, { agent: preset, apply });
    }],
    ["DELETE", "/api/agents/:id", (ctx) => {
      const existing = getAgent(db, ctx.params.id!);
      if (!existing) return sendJson(ctx.res, 404, { error: "agent introuvable" });
      deleteAgent(db, ctx.params.id!);
      const deleted = unapplyAgent(paths, existing.slug);
      sendJson(ctx.res, 200, { ok: true, unapplied: deleted });
    }],
    ["POST", "/api/agents/:id/validate", async (ctx) => {
      const preset = getAgent(db, ctx.params.id!);
      if (!preset) return sendJson(ctx.res, 404, { error: "agent introuvable" });
      const result = await validateAgent(paths, preset, checkAuthReadyFor);
      sendJson(ctx.res, 200, result);
    }],
  ];

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};
      const found = matchRoute(routes, req.method ?? "GET", url.pathname);
      if (!found) return sendJson(res, 404, { error: `not found: ${url.pathname}` });
      await found.handler({ params: found.params, query: url.searchParams, body, req, res });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export { sendJson, API_PROTOCOLS };
