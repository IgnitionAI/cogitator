import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import type { Db } from "./db.js";
import { packageVersion, piVersion } from "./pi.js";
import type { Paths } from "./paths.js";
import {
  API_PROTOCOLS, deleteProvider, listProviders, listSkills, mcpAdapterDetected,
  readMcp, upsertProvider, validateMcpConfig, writeMcp,
} from "./registry.js";
import {
  applyAgent, createAgent, deleteAgent, getAgent, listAgents, unapplyAgent,
  updateAgent, validateAgent, getDefaultAgentId, setDefaultAgent,
} from "./agents.js";
import {
  CronService, createTask, deleteTask, getTask, listRuns, listTasks, updateTask,
} from "./cron.js";
import {
  createConversation, deleteConversation, getConversation, listConversations,
  setConversationModel, setConversationTitle,
} from "./conversations.js";
import { PiPool } from "./pool.js";
import { makeSpawner, type Spawner } from "./spawner.js";
import { readHistory, readEntries } from "./history.js";
import { readFileChanges, readFileEvents, readFileDetail } from "./file-changes.js";
import { importSkills } from "./skills-import.js";
import {
  agentInputSchema, conversationCreateSchema, messageSchema, modelSwitchSchema,
  providerUpsertSchema, scheduleCreateSchema, scheduleUpdateSchema, skillImportSchema,
  workspaceCreateSchema, workspaceUpdateSchema,
} from "./schemas.js";
import type { SpawnConfig } from "./spawn.js";
import {
  browseDir, createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, updateWorkspace,
} from "./workspaces.js";

/** Localise web/dist en remontant depuis le module (marche en dev src/ comme en prod dist/src/ ou en paquet npm). */
function findWebDist(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "web", "dist");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const WEB_DIST = findWebDist();

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Sert le build statique de l'UI ; SPA fallback vers index.html. */
function serveStatic(res: ServerResponse, pathname: string): boolean {
  const root = WEB_DIST;
  if (!root || !existsSync(root)) return false;
  const rel = pathname === "/" ? "index.html" : pathname;
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) return false; // pas de traversal
  const target = existsSync(file) && statSync(file).isFile() ? file : join(root, "index.html");
  if (!existsSync(target)) return false;
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
  res.end(readFileSync(target));
  return true;
}

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

/** Valide un body brut contre un schéma zod ; répond 400 et renvoie null si invalide. */
function parseBody<T>(res: ServerResponse, schema: import("zod").ZodType<T>, body: unknown): T | null {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    sendJson(res, 400, {
      error: "entrée invalide",
      issues: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    });
    return null;
  }
  return result.data;
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
  cron?: CronService;
  events?: EventEmitter;
}

export function createApp(opts: AppOptions): Server {
  const { db, dbPath, dbVersion, paths, pool, cron } = opts;
  const events = opts.events ?? new EventEmitter();
  events.setMaxListeners(100);
  const spawner = makeSpawner({ db, pool, paths });

  /** Spawn paresseux : (re)démarre le process pi de la conversation si besoin. */
  async function ensureSpawned(conv: ReturnType<typeof getConversation> & object): Promise<{ sessionFile?: string }> {
    return spawner.ensure(conv as Parameters<Spawner["ensure"]>[0]);
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
      const b = parseBody(ctx.res, providerUpsertSchema, ctx.body);
      if (!b) return;
      if (!b.id) return sendJson(ctx.res, 400, { error: "id requis", issues: ["id: requis"] });
      const { error } = upsertProvider(paths, b.id, b);
      if (error) return sendJson(ctx.res, 400, { error });
      sendJson(ctx.res, 201, { ok: true });
    }],
    ["PUT", "/api/providers/:id", (ctx) => {
      const b = parseBody(ctx.res, providerUpsertSchema, ctx.body);
      if (!b) return;
      const { error } = upsertProvider(paths, ctx.params.id!, b);
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
    ["POST", "/api/skills/import", async (ctx) => {
      const b = parseBody(ctx.res, skillImportSchema, ctx.body);
      if (!b) return;
      const destRoot = paths.skillsDirs[0] ?? join(paths.piAgentDir, "skills");
      const result = await importSkills(b.source, destRoot, b.overwrite === true);
      if (result.error && result.imported.length === 0) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 200, { ...result, dest: destRoot, skills: listSkills(paths) });
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
      const input = parseBody(ctx.res, agentInputSchema, ctx.body);
      if (!input) return;
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
      const input = parseBody(ctx.res, agentInputSchema, ctx.body);
      if (!input) return;
      const preset = updateAgent(db, ctx.params.id!, input);
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
    ["POST", "/api/agents/:id/default", (ctx) => {
      if (!setDefaultAgent(db, ctx.params.id!)) return sendJson(ctx.res, 404, { error: "agent introuvable" });
      sendJson(ctx.res, 200, { ok: true });
    }],

    // Workspaces (M3)
    ["GET", "/api/workspaces", (ctx) => {
      sendJson(ctx.res, 200, { workspaces: listWorkspaces(db) });
    }],
    ["POST", "/api/workspaces", (ctx) => {
      const b = parseBody(ctx.res, workspaceCreateSchema, ctx.body);
      if (!b) return;
      const { workspace, error } = createWorkspace(db, b);
      if (error) return sendJson(ctx.res, 400, { error });
      sendJson(ctx.res, 201, { workspace });
    }],
    ["PUT", "/api/workspaces/:id", (ctx) => {
      const b = parseBody(ctx.res, workspaceUpdateSchema, ctx.body);
      if (!b) return;
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

    // Activité dev agrégée d'un workspace (toutes les conversations)
    ["GET", "/api/workspaces/:id/activity", (ctx) => {
      const ws = getWorkspace(db, ctx.params.id!);
      if (!ws) return sendJson(ctx.res, 404, { error: "workspace introuvable" });
      const convs = db
        .prepare("SELECT id, session_file FROM conversation WHERE workspace_id = ? AND session_file IS NOT NULL ORDER BY updated_at DESC LIMIT 20")
        .all(ws.id) as Array<{ id: string; session_file: string }>;
      const merged = new Map<string, import("./file-changes.js").FileChange>();
      for (const c of convs) {
        for (const f of readFileChanges(c.session_file)) {
          const existing = merged.get(f.path);
          if (existing) {
            existing.edits += f.edits;
            existing.additions += f.additions;
            existing.deletions += f.deletions;
            existing.kind = existing.kind === "write" ? "write" : f.kind;
            if (f.lastAt > existing.lastAt) {
              existing.lastAt = f.lastAt;
              existing.lastConversationId = c.id;
            }
          } else {
            merged.set(f.path, { ...f, lastConversationId: c.id });
          }
        }
      }
      const files = [...merged.values()]
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
        .slice(0, 100);
      const totals = files.reduce(
        (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
        { additions: 0, deletions: 0 },
      );
      sendJson(ctx.res, 200, { files, totals, conversations: convs.length });
    }],

    // Feed chronologique d'un workspace (toutes conversations fusionnées)
    ["GET", "/api/workspaces/:id/feed", (ctx) => {
      const ws = getWorkspace(db, ctx.params.id!);
      if (!ws) return sendJson(ctx.res, 404, { error: "workspace introuvable" });
      const convs = db
        .prepare("SELECT id, title, session_file FROM conversation WHERE workspace_id = ? AND session_file IS NOT NULL ORDER BY updated_at DESC LIMIT 20")
        .all(ws.id) as Array<{ id: string; title: string; session_file: string }>;
      const events = convs.flatMap((c) =>
        readFileEvents(c.session_file, 200).map((e) => ({
          ...e,
          hunks: undefined, // le feed n'a pas besoin du contenu
          conversationId: c.id,
          conversationTitle: c.title || "(sans titre)",
        })),
      );
      events.sort((a, b) => b.at.localeCompare(a.at));
      sendJson(ctx.res, 200, { events: events.slice(0, 100), conversations: convs.length });
    }],

    // Conversations (M2)
    ["GET", "/api/conversations", (ctx) => {
      const workspaceId = ctx.query.get("workspace_id");
      sendJson(ctx.res, 200, { conversations: listConversations(db, workspaceId ?? undefined) });
    }],
    ["POST", "/api/conversations", async (ctx) => {
      const b = parseBody(ctx.res, conversationCreateSchema, ctx.body);
      if (!b) return;
      let spawn: SpawnConfig;
      let agentId: string | null = null;
      if (b.workspace_id) {
        const ws = getWorkspace(db, b.workspace_id);
        if (!ws) return sendJson(ctx.res, 404, { error: "workspace introuvable" });
        // héritage : agent par défaut du workspace si rien de précisé
        if (!b.agent_id && !b.provider) agentId = ws.default_agent_id;
      }
      if (b.agent_id) agentId = b.agent_id;
      if (!agentId && !b.provider) {
        // repli : agent par défaut global (le Majordome si seedé)
        agentId = getDefaultAgentId(db);
        if (!agentId) return sendJson(ctx.res, 400, { error: "aucun agent par défaut — précise agent_id ou provider+model" });
      }
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
    ["GET", "/api/conversations/:id/history", (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      sendJson(ctx.res, 200, {
        messages: readHistory(conv.session_file ?? ""),
        entries: readEntries(conv.session_file ?? ""),
      });
    }],
    ["GET", "/api/conversations/:id/files", (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      sendJson(ctx.res, 200, { files: readFileChanges(conv.session_file ?? "") });
    }],
    ["GET", "/api/conversations/:id/file", (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      const path = ctx.query.get("path");
      if (!path) return sendJson(ctx.res, 400, { error: "path requis" });
      sendJson(ctx.res, 200, { path, operations: readFileDetail(conv.session_file ?? "", path) });
    }],
    ["POST", "/api/conversations/:id/messages", async (ctx) => {
      const conv = getConversation(db, ctx.params.id!);
      if (!conv) return sendJson(ctx.res, 404, { error: "conversation introuvable" });
      const b = parseBody(ctx.res, messageSchema, ctx.body);
      if (!b) return;
      const text = (b.text ?? "").trim();
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
      const b = parseBody(ctx.res, modelSwitchSchema, ctx.body);
      if (!b) return;
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

    // Schedules (M5)
    ["GET", "/api/schedules", (ctx) => {
      sendJson(ctx.res, 200, { schedules: listTasks(db) });
    }],
    ["POST", "/api/schedules", (ctx) => {
      const b = parseBody(ctx.res, scheduleCreateSchema, ctx.body);
      if (!b) return;
      const { task, error } = createTask(db, b);
      if (error) return sendJson(ctx.res, 400, { error });
      sendJson(ctx.res, 201, { schedule: task });
    }],
    ["PUT", "/api/schedules/:id", (ctx) => {
      const b = parseBody(ctx.res, scheduleUpdateSchema, ctx.body);
      if (!b) return;
      const task = updateTask(db, ctx.params.id!, b);
      if (!task) return sendJson(ctx.res, 400, { error: "schedule introuvable ou expression cron invalide" });
      sendJson(ctx.res, 200, { schedule: task });
    }],
    ["DELETE", "/api/schedules/:id", (ctx) => {
      if (!deleteTask(db, ctx.params.id!)) return sendJson(ctx.res, 404, { error: "schedule introuvable" });
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["POST", "/api/schedules/:id/run", (ctx) => {
      if (!cron) return sendJson(ctx.res, 503, { error: "cron indisponible" });
      const task = getTask(db, ctx.params.id!);
      if (!task) return sendJson(ctx.res, 404, { error: "schedule introuvable" });
      // fire-and-forget : le run est tracé et observable via /runs + /events
      void cron.fireNow(task.id).catch(() => undefined);
      sendJson(ctx.res, 202, { ok: true });
    }],
    ["GET", "/api/schedules/:id/runs", (ctx) => {
      const limit = Number(ctx.query.get("limit") ?? 50);
      sendJson(ctx.res, 200, { runs: listRuns(db, ctx.params.id!, Number.isFinite(limit) ? limit : 50) });
    }],

    // Events global (SSE)
    ["GET", "/api/events", (ctx) => {
      const res = ctx.res;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const listener = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      events.on("event", listener);
      ctx.req.on("close", () => events.off("event", listener));
    }],
  ];

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/") && serveStatic(res, url.pathname)) return;
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
