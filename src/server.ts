import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import {
  createConversation, deleteConversation, getConversation, listConversations,
  setConversationModel, setConversationSession, setConversationStatus, setConversationTitle,
} from "./conversations.js";
import { PiPool, PoolError, type PiClientFactory } from "./pool.js";
import { MCP_ENV_VAR, encodeMcpEnv } from "./mcp-env.js";
import { buildArgs, type SpawnConfig } from "./spawn.js";
import {
  browseDir, createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, updateWorkspace,
} from "./workspaces.js";

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
  pool: PiPool;
}

export function createApp(opts: AppOptions): Server {
  const { db, dbPath, dbVersion, paths, pool } = opts;
  const tmpDir = join(paths.home, "tmp");
  mkdirSync(tmpDir, { recursive: true });

  /** Spawn paresseux : (re)démarre le process pi de la conversation si besoin. */
  async function ensureSpawned(conv: ReturnType<typeof getConversation> & object): Promise<{ sessionFile?: string }> {
    const spawn = JSON.parse(conv.spawn_args || "{}") as SpawnConfig;
    const mcpEnv = encodeMcpEnv(spawn.mcpServers ?? []);
    const result = await pool.ensure(conv.id, {
      cwd: conv.workspace_dir ?? homedir(),
      args: buildArgs(spawn, tmpDir, conv.id),
      resumeSessionFile: conv.session_file,
      env: mcpEnv ? { [MCP_ENV_VAR]: mcpEnv } : undefined,
    });
    if (result.sessionFile) setConversationSession(db, conv.id, result.sessionFile);
    return result;
  }

  // Fan-out des événements pi vers les abonnés SSE par conversation
  const sseSubs = new Map<string, Set<(event: unknown) => void>>();
  pool.onEvent((convId, event) => {
    for (const l of sseSubs.get(convId) ?? []) l(event);
  });

  const routes: Route[] = [
    ["GET", "/api/health", (ctx) => {
      sendJson(ctx.res, 200, {
        ok: true,
        version: packageVersion(),
        pi_version: piVersion(),
        sessions_active: pool.size,
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

    // Workspaces (M3)
    ["GET", "/api/workspaces", (ctx) => {
      sendJson(ctx.res, 200, { workspaces: listWorkspaces(db) });
    }],
    ["POST", "/api/workspaces", (ctx) => {
      const b = (ctx.body ?? {}) as { dir?: string; name?: string; default_agent_id?: string };
      if (!b.dir) return sendJson(ctx.res, 400, { error: "dir requis" });
      const { workspace, error } = createWorkspace(db, {
        dir: b.dir,
        name: b.name,
        default_agent_id: b.default_agent_id ?? null,
      });
      if (error) return sendJson(ctx.res, 400, { error });
      sendJson(ctx.res, 201, { workspace });
    }],
    ["PUT", "/api/workspaces/:id", (ctx) => {
      const b = (ctx.body ?? {}) as { name?: string; default_agent_id?: string | null };
      const current = getWorkspace(db, ctx.params.id!);
      if (!current) return sendJson(ctx.res, 404, { error: "workspace introuvable" });
      if (b.default_agent_id && !db.prepare("SELECT 1 FROM agent_preset WHERE id = ?").get(b.default_agent_id)) {
        return sendJson(ctx.res, 400, { error: "agent par défaut introuvable" });
      }
      sendJson(ctx.res, 200, { workspace: updateWorkspace(db, ctx.params.id!, b) });
    }],
    ["DELETE", "/api/workspaces/:id", (ctx) => {
      if (!deleteWorkspace(db, ctx.params.id!)) return sendJson(ctx.res, 404, { error: "workspace introuvable" });
      sendJson(ctx.res, 200, { ok: true }); // les sessions pi survivent sur disque
    }],
    ["GET", "/api/fs/browse", (ctx) => {
      const result = browseDir(ctx.query.get("path"));
      if ("error" in result) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 200, result);
    }],

    // Conversations (M2)
    ["GET", "/api/conversations", (ctx) => {
      const workspaceId = ctx.query.get("workspace_id");
      sendJson(ctx.res, 200, { conversations: listConversations(db, workspaceId ?? undefined) });
    }],
    ["POST", "/api/conversations", async (ctx) => {
      const b = (ctx.body ?? {}) as {
        workspace_id?: string; prompt?: string; agent_id?: string;
        provider?: string; model?: string; thinking?: string;
        system_prompt?: string; skills?: string[]; tools?: string[];
        mcp_servers?: import("./mcp-env.js").McpServerEntry[];
      };
      let spawn: SpawnConfig;
      let agentId: string | null = null;
      if (b.workspace_id) {
        const ws = getWorkspace(db, b.workspace_id);
        if (!ws) return sendJson(ctx.res, 404, { error: "workspace introuvable" });
        // héritage : agent par défaut du workspace si rien de précisé
        if (!b.agent_id && !b.provider) agentId = ws.default_agent_id;
      }
      if (b.agent_id) agentId = b.agent_id;
      if (agentId) {
        const preset = getAgent(db, agentId);
        if (!preset) return sendJson(ctx.res, 404, { error: "agent introuvable" });
        agentId = preset.id;
        spawn = {
          provider: preset.provider, model: preset.model, thinking: preset.thinking,
          systemPrompt: preset.system_prompt || undefined,
          skills: preset.skills, tools: preset.tools_allowlist,
          mcpServers: preset.mcp_servers,
        };
      } else if (b.provider && b.model) {
        spawn = {
          provider: b.provider, model: b.model, thinking: b.thinking ?? null,
          systemPrompt: b.system_prompt, skills: b.skills, tools: b.tools,
          mcpServers: b.mcp_servers,
        };
      } else {
        return sendJson(ctx.res, 400, { error: "agent_id ou (provider + model) requis" });
      }
      let conv = createConversation(db, { workspaceId: b.workspace_id ?? null, agentId, spawn });
      if (b.prompt?.trim()) {
        await ensureSpawned(conv);
        await pool.prompt(conv.id, b.prompt.trim());
        setConversationTitle(db, conv.id, b.prompt.trim());
        conv = getConversation(db, conv.id)!;
      }
      sendJson(ctx.res, 201, { conversation: conv });
    }],
    ["GET", "/api/conversations/:id", (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      sendJson(ctx.res, 200, { conversation: conv, live: pool.isLive(conv.id) });
    }],
    ["GET", "/api/conversations/:id/events", async (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      const spawned = await ensureSpawned(conv);
      const res = ctx.res;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "session", sessionFile: spawned.sessionFile ?? conv.session_file })}\n\n`);
      const listener = (event: unknown) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      let subs = sseSubs.get(conv.id);
      if (!subs) sseSubs.set(conv.id, (subs = new Set()));
      subs.add(listener);
      ctx.req.on("close", () => {
        subs.delete(listener);
      });
    }],
    ["POST", "/api/conversations/:id/messages", async (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      const b = (ctx.body ?? {}) as { text?: string; images?: unknown[] };
      const text = (b.text ?? "").trim();
      if (!text && !b.images?.length) return sendJson(ctx.res, 400, { error: "text ou images requis" });
      await ensureSpawned(conv);
      await pool.prompt(conv.id, text, b.images);
      if (text) setConversationTitle(db, conv.id, text);
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["POST", "/api/conversations/:id/stop", async (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      await pool.abort(conv.id);
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["POST", "/api/conversations/:id/model", async (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      const b = (ctx.body ?? {}) as { provider?: string; id?: string };
      if (!b.provider || !b.id) return sendJson(ctx.res, 400, { error: "provider et id requis" });
      await pool.setModel(conv.id, b.provider, b.id);
      const spawn = { ...(JSON.parse(conv.spawn_args || "{}") as SpawnConfig), provider: b.provider, model: b.id };
      setConversationModel(db, conv.id, b.provider, b.id, spawn);
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["DELETE", "/api/conversations/:id", async (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      await pool.evict(conv.id);
      deleteConversation(db, conv.id);
      sendJson(ctx.res, 200, { ok: true }); // le .jsonl pi survit sur disque (I5)
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
