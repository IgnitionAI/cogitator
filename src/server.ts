import { changeConfiguration, dismissConfiguration, ConfigurationError, recoverConfigurations } from "./classic-configuration.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import type { ZodType } from "zod";
import { HOST } from "./config.js";
import { requestAuthorization } from "./request-authorization.js";
import type { AuthState } from "./auth-state.js";
import { protectedRequired } from "./auth-state.js";
import { AuthError, ownerSession, requireApproved, sessionById } from "./native-auth.js";
import { authFailure, authJson, authRoute, browserHeaders, checkResponse, localCheck, responseChecks, validateBoundary } from "./auth-http.js";
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
  type AgentPreset,
} from "./agents.js";
import {
  CronService, createTask, deleteTask, getTask, listRuns, listTasks, updateTask,
} from "./cron.js";
import {
  createConversation, deleteConversation, getConversation, listConversations,
  setConversationTitle, type ConversationRow,
} from "./conversations.js";
import {
  appendGroupMessage, conversationGroupOwner, deleteGroup, getGroupWithMembers, insertGroup, listGroupMessages,
  listGroups, matchGroupMention, routeGroupMessage,
  type CreateGroupInput,
} from "./groups.js";
import { PiPool } from "./pool.js";
import { makeSpawner, type Spawner } from "./spawner.js";
import { composeRuntime, runtimeKindOf, type ConversationRuntime } from "./runtime.js";
import { DurableRuntimeManager } from "./durable/manager.js";
import { assertDurableAdmission, durableToolchainRegistry } from "./durable/compatibility.js";
import { readHistory, readEntries } from "./history.js";
import { readFileChanges, readFileEvents, readFileDetail, type FileChange } from "./file-changes.js";
import { workspaceTree, readWorkspaceFile } from "./workspace-files.js";
import {
  listCards, createCardGh, updateCardGh, moveCardGh, addCommentGh, closeCardGh,
  type BoardCard, type CardWrite,
} from "./board.js";
import { importSkills } from "./skills-import.js";
import {
  agentInputSchema, conversationCreateSchema, groupCreateSchema, messageSchema, modelSwitchSchema,
  providerUpsertSchema, scheduleCreateSchema, scheduleUpdateSchema, skillImportSchema,
  workspaceCreateSchema, workspaceUpdateSchema, boardCardSchema, boardCommentSchema,
  approvalDecisionSchema, budgetUpdateSchema,
  type BoardCardInput, type ConversationCreate, type GroupCreate,
} from "./schemas.js";
import { spawnConfigFromPreset, type SpawnConfig } from "./spawn.js";
import { enrollmentPolicyFromEnv } from "./execution/confinement.js";
import {
  browseDir, createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, updateWorkspace,
  type WorkspaceRow,
} from "./workspaces.js";

// ---------- Statique ----------

/** Localise web/dist en remontant depuis le module (marche en dev src/ comme en prod dist/src/ ou en paquet npm). */
function findWebDist(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_WEB_DIST_LOOKUP; i++) {
    const candidate = join(dir, "web", "dist");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const MAX_WEB_DIST_LOOKUP = 6;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Sert le build statique de l'UI ; SPA fallback vers index.html.
 *  Le dossier est résolu à chaque requête : un build web peut être (re)généré après le démarrage. */
function serveStatic(res: ServerResponse, pathname: string, publicOnly = false): boolean {
  const root = findWebDist();
  if (!root) return false;
  const target = resolveStaticFile(root, pathname, publicOnly);
  if (!target) return false;
  checkResponse(res);
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
  res.end(readFileSync(target));
  return true;
}

/** Resolve symlinks before serving: lexical prefix checks alone are not containment. */
export function resolveStaticFile(root: string, pathname: string, publicOnly = false): string | null {
  const rel = pathname === "/" ? "index.html" : pathname;
  const file = normalize(join(root, rel));
  if (relative(root, file).startsWith(`..${sep}`)) return null;
  if (publicOnly && pathname !== "/" && pathname !== "/index.html" && !/^\/assets\/[A-Za-z0-9_-]+\.(?:js|css|woff2)$/.test(pathname)) return null;
  if (publicOnly && !existsSync(file)) return null;
  const target = existsSync(file) && statSync(file).isFile() ? file : join(root, "index.html");
  if (!existsSync(target)) return null;
  const contained = relative(realpathSync(root), realpathSync(target));
  if (contained.startsWith(`..${sep}`) || contained === "..") return null;
  return target;
}

// ---------- Mini routeur ----------

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
  check: () => void;
}

type Handler = (ctx: Ctx) => Promise<void> | void;
type Route = [method: string, pattern: string, handler: Handler];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  checkResponse(res);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Répond 404 et renvoie null — garde d'existence commune à toutes les routes paramétrées. */
function notFound(res: ServerResponse, what: string): null {
  sendJson(res, 404, { error: `${what} introuvable` });
  return null;
}

function matchRoute(routes: Route[], method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  const uSeg = pathname.split("/").filter(Boolean);
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const pSeg = pattern.split("/").filter(Boolean);
    if (pSeg.length !== uSeg.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (const [i, segment] of pSeg.entries()) {
      const actual = uSeg[i]!;
      if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(actual);
      else if (segment !== actual) {
        matches = false;
        break;
      }
    }
    if (matches) return { handler, params };
  }
  return null;
}

// Doit rester cohérent avec messageSchema : 8 images × 15 Mo base64 + texte (~121 Mo).
const MAX_BODY_BYTES = 130_000_000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AuthError("INVALID_INPUT", 413));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AuthError("INVALID_INPUT", 400));
      }
    });
    req.on("error", reject);
  });
}

/** Valide un body brut contre un schéma zod ; répond 400 et renvoie null si invalide. */
function parseBody<T>(res: ServerResponse, schema: ZodType<T>, body: unknown): T | null {
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

// ---------- SSE ----------

type SseSend = (event: unknown) => void;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-store",
  connection: "keep-alive",
};

/** Ouvre un flux SSE et renvoie l'émetteur (`initial` = premier événement, ex. session_file). */
function openSse(res: ServerResponse, initial?: unknown): SseSend {
  checkResponse(res);
  res.writeHead(200, SSE_HEADERS);
  const send: SseSend = (event) => {
    try { checkResponse(res); if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { res.end(); }
  };
  const heartbeat = setInterval(() => {
    try { checkResponse(res); res.write(": heartbeat\n\n"); } catch { res.end(); }
  }, 15_000);
  heartbeat.unref();
  res.once("close", () => clearInterval(heartbeat));
  if (initial !== undefined) send(initial);
  return send;
}

const MAX_SSE_LISTENERS = 100;

// ---------- Auth pi ----------

const AUTH_CHECK_TIMEOUT_MS = 15_000;

/** Checker auth réel pour la route validate (la fonction validateAgent reste injectable pour les tests). */
function checkAuthReadyFor(provider: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("pi", ["auth", "check", "--provider", provider, "--json"], { timeout: AUTH_CHECK_TIMEOUT_MS }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout).status === "ready");
      } catch {
        resolve(err ? false : null);
      }
    });
  });
}

// ---------- Dépendances des routes ----------

interface Deps {
  db: Db;
  dbPath: string;
  dbVersion: number;
  paths: Paths;
  pool: PiPool;
  cron?: CronService;
  events: EventEmitter;
  spawner: Spawner;
  sseSubs: Map<string, Set<SseSend>>;
  groupSubs: Map<string, Set<SseSend>>;
  /** Point de composition explicite unique des runtimes (I3 amendé, Plan 0002 §6). */
  compose: (conv: ConversationRow) => ConversationRuntime;
  durable: DurableRuntimeManager;
}

/** Résout le :id d'une route en entité, ou répond 404 et renvoie null. */
function requireWorkspace(deps: Deps, ctx: Ctx): WorkspaceRow | null {
  return getWorkspace(deps.db, ctx.params.id!) ?? notFound(ctx.res, "workspace");
}

function requireConversation(deps: Deps, ctx: Ctx): ConversationRow | null {
  return getConversation(deps.db, ctx.params.id!) ?? notFound(ctx.res, "conversation");
}

function requireAgent(deps: Deps, ctx: Ctx): AgentPreset | null {
  return getAgent(deps.db, ctx.params.id!) ?? notFound(ctx.res, "agent");
}

// ---------- Groupes de routes ----------

/** Registry pi : providers, skills, MCP user-level. */
function registryRoutes(deps: Deps): Route[] {
  const { paths } = deps;
  return [
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
      // Mode distant : les imports par commande hôte (npx/npm) sont désactivés
      // (Plan 0002 §4 : pas d'import npm/npx côté hôte en mode distant).
      if (enrollmentPolicyFromEnv().remote && /^npx\s|^npm\s/.test(b.source.trim())) {
        return sendJson(ctx.res, 400, { error: "import par commande (npx/npm) désactivé en mode distant" });
      }
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
  ];
}

/** Presets d'agents + apply/unapply des définitions herdr. */
function agentRoutes(deps: Deps): Route[] {
  const { db, paths, events } = deps;
  const changed = () => events.emit("event", { type: "agents_changed" });
  return [
    ["GET", "/api/agents", (ctx) => {
      sendJson(ctx.res, 200, { agents: listAgents(db) });
    }],
    ["POST", "/api/agents", (ctx) => {
      const input = parseBody(ctx.res, agentInputSchema, ctx.body);
      if (!input) return;
      if (input.default_workspace_id && !getWorkspace(db, input.default_workspace_id)) {
        return sendJson(ctx.res, 404, { error: "workspace introuvable" });
      }
      const preset = createAgent(db, input);
      changed();
      sendJson(ctx.res, 201, { agent: preset, apply: applyAgent(paths, preset) });
    }],
    ["GET", "/api/agents/:id", (ctx) => {
      const agent = requireAgent(deps, ctx);
      if (!agent) return;
      sendJson(ctx.res, 200, { agent });
    }],
    ["PUT", "/api/agents/:id", (ctx) => {
      const input = parseBody(ctx.res, agentInputSchema, ctx.body);
      if (!input) return;
      if (input.default_workspace_id && !getWorkspace(db, input.default_workspace_id)) {
        return sendJson(ctx.res, 404, { error: "workspace introuvable" });
      }
      const preset = updateAgent(db, ctx.params.id!, input);
      if (!preset) return notFound(ctx.res, "agent");
      changed();
      sendJson(ctx.res, 200, { agent: preset, apply: applyAgent(paths, preset) });
    }],
    ["DELETE", "/api/agents/:id", (ctx) => {
      const existing = requireAgent(deps, ctx);
      if (!existing) return;
      deleteAgent(db, existing.id);
      changed();
      sendJson(ctx.res, 200, { ok: true, unapplied: unapplyAgent(paths, existing.slug) });
    }],
    ["POST", "/api/agents/:id/validate", async (ctx) => {
      const preset = requireAgent(deps, ctx);
      if (!preset) return;
      sendJson(ctx.res, 200, await validateAgent(paths, preset, checkAuthReadyFor));
    }],
    ["POST", "/api/agents/:id/default", (ctx) => {
      if (!setDefaultAgent(db, ctx.params.id!)) return notFound(ctx.res, "agent");
      changed();
      sendJson(ctx.res, 200, { ok: true });
    }],
  ];
}

/** Workspaces (dossier de projet) + file-picker + arborescence read-only. */
function workspaceRoutes(deps: Deps): Route[] {
  const { db } = deps;
  return [
    ["GET", "/api/workspaces", (ctx) => {
      sendJson(ctx.res, 200, { workspaces: listWorkspaces(db) });
    }],
    ["POST", "/api/workspaces", (ctx) => {
      const b = parseBody(ctx.res, workspaceCreateSchema, ctx.body);
      if (!b) return;
      const { workspace, error } = createWorkspace(db, b, enrollmentPolicyFromEnv());
      if (error) return sendJson(ctx.res, 400, { error });
      sendJson(ctx.res, 201, { workspace });
    }],
    ["PUT", "/api/workspaces/:id", (ctx) => {
      const b = parseBody(ctx.res, workspaceUpdateSchema, ctx.body);
      if (!b) return;
      if (!requireWorkspace(deps, ctx)) return;
      // updateWorkspace ne renvoie null que si l'agent par défaut visé n'existe pas
      const workspace = updateWorkspace(db, ctx.params.id!, b);
      if (!workspace) return sendJson(ctx.res, 400, { error: "agent par défaut introuvable" });
      sendJson(ctx.res, 200, { workspace });
    }],
    ["DELETE", "/api/workspaces/:id", (ctx) => {
      if (!deleteWorkspace(db, ctx.params.id!)) return notFound(ctx.res, "workspace");
      sendJson(ctx.res, 200, { ok: true }); // les sessions pi survivent sur disque
    }],
    ["GET", "/api/fs/browse", (ctx) => {
      const result = browseDir(ctx.query.get("path"));
      if ("error" in result) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 200, result);
    }],
    ["GET", "/api/workspaces/:id/tree", (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      sendJson(ctx.res, 200, { root: ws.dir, tree: workspaceTree(ws.dir) });
    }],
    ["GET", "/api/workspaces/:id/file", (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const path = ctx.query.get("path");
      if (!path) return sendJson(ctx.res, 400, { error: "path requis" });
      const { file, error } = readWorkspaceFile(ws.dir, path);
      if (error) return sendJson(ctx.res, 400, { error });
      sendJson(ctx.res, 200, { file });
    }],
    // Activité agrégée du workspace (toutes conversations confondues)
    ["GET", "/api/workspaces/:id/activity", (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const convs = db
        .prepare(`SELECT id, session_file FROM conversation
                  WHERE workspace_id = ? AND session_file IS NOT NULL
                  ORDER BY updated_at DESC LIMIT ?`)
        .all(ws.id, WORKSPACE_CONVERSATION_SCAN) as Array<{ id: string; session_file: string }>;
      const { files, totals } = aggregateFileChanges(convs);
      sendJson(ctx.res, 200, { files, totals, conversations: convs.length });
    }],
    // Feed chronologique d'un workspace (toutes conversations fusionnées)
    ["GET", "/api/workspaces/:id/feed", (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const convs = db
        .prepare(`SELECT id, title, session_file FROM conversation
                  WHERE workspace_id = ? AND session_file IS NOT NULL
                  ORDER BY updated_at DESC LIMIT ?`)
        .all(ws.id, WORKSPACE_CONVERSATION_SCAN) as Array<{ id: string; title: string; session_file: string }>;
      const events = convs.flatMap((c) =>
        readFileEvents(c.session_file, FEED_EVENTS_PER_CONVERSATION).map((e) => ({
          ...e,
          hunks: undefined, // le feed n'a pas besoin du contenu
          conversationId: c.id,
          conversationTitle: c.title || "(sans titre)",
        })),
      );
      events.sort((a, b) => b.at.localeCompare(a.at));
      sendJson(ctx.res, 200, { events: events.slice(0, FEED_MAX_EVENTS), conversations: convs.length });
    }],
  ];
}

const WORKSPACE_CONVERSATION_SCAN = 20;
const FEED_EVENTS_PER_CONVERSATION = 200;
const FEED_MAX_EVENTS = 100;
const AGGREGATED_FILES_MAX = 100;

interface FileChangeRow {
  id: string;
  session_file: string;
}

/** Fusionne les changements de plusieurs conversations (dernier passage par chemin). */
function aggregateFileChanges(convs: FileChangeRow[]): { files: FileChange[]; totals: { additions: number; deletions: number } } {
  const merged = new Map<string, FileChange>();
  for (const c of convs) {
    for (const f of readFileChanges(c.session_file)) {
      const existing = merged.get(f.path);
      if (!existing) {
        merged.set(f.path, { ...f, lastConversationId: c.id });
        continue;
      }
      existing.edits += f.edits;
      existing.additions += f.additions;
      existing.deletions += f.deletions;
      existing.kind = existing.kind === "write" ? "write" : f.kind;
      if (f.lastAt > existing.lastAt) {
        existing.lastAt = f.lastAt;
        existing.lastConversationId = c.id;
      }
    }
  }
  const files = [...merged.values()]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, AGGREGATED_FILES_MAX);
  const totals = files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
  return { files, totals };
}

/** Board kanban — réplique des GitHub Issues du repo (sidecar local pour les extras Cogitator). */
function boardRoutes(deps: Deps): Route[] {
  const { db } = deps;
  return [
    ["GET", "/api/workspaces/:id/board", async (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const result = await listCards(ws.dir);
      if ("error" in result) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 200, { cards: result.cards });
    }],
    ["POST", "/api/workspaces/:id/board/cards", async (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const input = parseBody(ctx.res, boardCardSchema, ctx.body);
      if (!input) return;
      const result = await createCardGh(ws.dir, toCardWrite(input));
      if ("error" in result) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 201, { card: result.card });
    }],
    ["PUT", "/api/workspaces/:id/board/cards/:cardId", async (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const input = parseBody(ctx.res, boardCardSchema, ctx.body);
      if (!input) return;
      const result = await updateCardGh(ws.dir, cardNumber(ctx), toCardWrite(input));
      if ("error" in result) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 200, { card: result.card });
    }],
    ["POST", "/api/workspaces/:id/board/cards/:cardId/move", async (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const b = (ctx.body ?? {}) as { status?: string };
      if (!b.status) return sendJson(ctx.res, 400, { error: "status requis" });
      const result = await moveCardGh(ws.dir, cardNumber(ctx), b.status);
      if ("error" in result) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 200, { card: result.card });
    }],
    ["POST", "/api/workspaces/:id/board/cards/:cardId/comments", async (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const input = parseBody(ctx.res, boardCommentSchema, ctx.body);
      if (!input) return;
      const result = await addCommentGh(ws.dir, cardNumber(ctx), input.text, input.author ?? "user");
      if ("error" in result) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 200, { card: result.card });
    }],
    // Lancer l'agent assigné sur un ticket : conversation dans le workspace + lien carte + in_progress
    ["POST", "/api/workspaces/:id/board/cards/:cardId/start", async (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const started = await startCardWork(deps, ws, cardNumber(ctx), ((ctx.body ?? {}) as { extra?: string }).extra, ctx.check);
      if ("error" in started) return sendJson(ctx.res, started.status, { error: started.error });
      sendJson(ctx.res, 201, started);
    }],
    ["DELETE", "/api/workspaces/:id/board/cards/:cardId", async (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const result = await closeCardGh(ws.dir, cardNumber(ctx));
      if ("error" in result) return sendJson(ctx.res, 400, { error: result.error });
      sendJson(ctx.res, 200, { ok: true, note: "issue fermée (GitHub ne supprime pas)" });
    }],
    // Activité agrégée d'une carte (conversations liées)
    ["GET", "/api/workspaces/:id/board/cards/:cardId/activity", async (ctx) => {
      const ws = requireWorkspace(deps, ctx);
      if (!ws) return;
      const found = await findCard(ws.dir, cardNumber(ctx));
      if ("error" in found) return sendJson(ctx.res, found.status, { error: found.error });
      const totals = { additions: 0, deletions: 0, files: 0 };
      const perConversation: Array<{ conversationId: string; additions: number; deletions: number }> = [];
      for (const convId of found.card.conversation_ids) {
        const conv = db.prepare("SELECT session_file FROM conversation WHERE id = ?").get(convId) as { session_file: string | null } | undefined;
        if (!conv?.session_file) continue;
        const changes = readFileChanges(conv.session_file);
        const additions = changes.reduce((n, f) => n + f.additions, 0);
        const deletions = changes.reduce((n, f) => n + f.deletions, 0);
        totals.additions += additions;
        totals.deletions += deletions;
        totals.files += changes.length;
        perConversation.push({ conversationId: convId, additions, deletions });
      }
      sendJson(ctx.res, 200, { totals, perConversation });
    }],
  ];
}

const cardNumber = (ctx: Ctx): number => Number(ctx.params.cardId);

/** Le body d'une carte couvre create et update : un seul mapping vers CardWrite. */
function toCardWrite(input: BoardCardInput): CardWrite {
  return {
    title: input.title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    labels: input.labels,
    assignee_agent_id: input.assignee_agent_id,
    conversation_ids: input.conversation_ids,
    blocks: input.blocks,
    blocked_by: input.blocked_by,
  };
}

/** Retrouve une carte par numéro d'issue, ou l'erreur HTTP à renvoyer. */
async function findCard(wsDir: string, number: number): Promise<{ card: BoardCard } | { error: string; status: number }> {
  const listed = await listCards(wsDir);
  if ("error" in listed) return { error: listed.error, status: 400 };
  const card = listed.cards.find((c) => c.number === number);
  return card ? { card } : { error: "carte introuvable", status: 404 };
}

/** Ticket → conversation pilotée par l'agent assigné, puis carte déplacée en in_progress. */
async function startCardWork(
  deps: Deps,
  ws: WorkspaceRow,
  number: number,
  extra?: string,
  check: () => void = () => {},
): Promise<{ conversation: ConversationRow; card: BoardCard } | { error: string; status: number }> {
  const found = await findCard(ws.dir, number);
  check();
  if ("error" in found) return found;
  const { card } = found;

  if (!card.assignee_agent_id) return { error: "carte sans agent assigné — assigne un agent Cogitator d'abord", status: 400 };
  const preset = getAgent(deps.db, card.assignee_agent_id);
  if (!preset) return { error: "agent assigné introuvable (supprimé ?)", status: 400 };

  const conv = createConversation(deps.db, {
    workspaceId: ws.id,
    agentId: preset.id,
    spawn: spawnConfigFromPreset(preset),
  });
  setConversationTitle(deps.db, conv.id, `#${card.number} ${card.title}`);
  const titled = getConversation(deps.db, conv.id)!;
  await deps.spawner.ensure(titled);
  check();
  await deps.pool.prompt(titled.id, ticketPrompt(card, extra));
  check();

  const moved = await moveCardGh(ws.dir, card.number, "in_progress");
  if ("error" in moved) return { conversation: titled, card };
  check();
  const linked = await updateCardGh(ws.dir, card.number, {
    title: moved.card.title,
    conversation_ids: [...new Set([...card.conversation_ids, conv.id])],
  });
  return { conversation: titled, card: "error" in linked ? moved.card : linked.card };
}

function ticketPrompt(card: BoardCard, extra?: string): string {
  return [
    `Ticket #${card.number} — ${card.title}`,
    card.description ? `\n${card.description}` : "",
    extra ? `\nPrécision : ${extra}` : "",
    `\n(issue GitHub : ${card.url} — mets à jour le board au besoin via les outils cogitator_board_*)`,
  ].join("");
}

/** Snapshot de spawn d'un preset (O6 du contrat) — partagé avec le cron via spawn.js. */

/** Conversations : création (agent hérité ou provider libre), SSE par session, messages. */
function conversationRoutes(deps: Deps): Route[] {
  const { db, pool } = deps;
  return [
    ["GET", "/api/conversations", (ctx) => {
      const workspaceId = ctx.query.get("workspace_id") ?? undefined;
      const agentId = ctx.query.get("agent_id") ?? undefined;
      sendJson(ctx.res, 200, { conversations: listConversations(db, workspaceId, agentId) });
    }],
    ["POST", "/api/conversations", async (ctx) => {
      const b = parseBody(ctx.res, conversationCreateSchema, ctx.body);
      if (!b) return;
      const resolved = resolveSpawnTarget(deps, b);
      if ("error" in resolved) return sendJson(ctx.res, resolved.status, { error: resolved.error });
      const runtimeKind = b.runtime ?? "classic";
      if (runtimeKind === "durable") {
        // Admission fail closed : capacités non classées → refus, aucun travail caché.
        try {
          assertDurableAdmission(durableToolchainRegistry(), resolved.spawn);
        } catch (err) {
          return sendJson(ctx.res, 403, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      let conv = createConversation(db, { workspaceId: resolved.workspaceId, agentId: resolved.agentId, spawn: resolved.spawn, runtimeKind });
      const prompt = b.prompt?.trim();
      if (prompt) {
        const runtime = deps.compose(conv);
        await runtime.ensure(conv);
        ctx.check();
        const ack = await runtime.prompt(conv, prompt, runtimeKind === "durable" ? randomUUID() : undefined);
        ctx.check();
        setConversationTitle(db, conv.id, prompt);
        conv = getConversation(db, conv.id)!;
        if (ack.accepted) return sendJson(ctx.res, 201, { conversation: conv, accepted: ack.accepted });
      }
      sendJson(ctx.res, 201, { conversation: conv });
    }],
    ["GET", "/api/conversations/:id", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      const runtime = deps.compose(conv);
      sendJson(ctx.res, 200, {
        conversation: conv,
        runtime: runtime.kind,
        live: runtime.isLive(conv),
        streaming: runtime.kind === "classic" ? await pool.isStreaming(conv.id) : runtime.isLive(conv),
      });
    }],
    ["GET", "/api/conversations/:id/events", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      const runtime = deps.compose(conv);
      const spawned = await runtime.ensure(conv);
      // Mode durable : aucun spawn (la runtime vit dans le contrôleur) ; la lecture
      // d'événements ne crée jamais de mission (Plan 0002 §7).
      const send = openSse(ctx.res, runtime.kind === "durable"
        ? { type: "session", runtimeKind: "durable" }
        : { type: "session", sessionFile: spawned.sessionFile ?? conv.session_file });
      const subs = deps.sseSubs.get(conv.id) ?? new Set<SseSend>();
      deps.sseSubs.set(conv.id, subs);
      subs.add(send);
      let detach: (() => void) | undefined;
      let detachMission: (() => void) | undefined;
      if (runtime.kind === "durable") {
        void runtime.attachEvents(conv, send).then((off) => { detach = off; });
        // États de mission (queued / budget_paused / waiting_approval / …) en direct.
        detachMission = deps.durable.onMissionState(conv.id, (state) => send({ type: "mission_state", mission: state }));
      }
      ctx.res.once("close", () => {
        subs.delete(send);
        if (!subs.size) deps.sseSubs.delete(conv.id);
        detach?.();
        detachMission?.();
      });
    }],
    ["GET", "/api/conversations/:id/history", (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      const sessionFile = conv.session_file ?? "";
      sendJson(ctx.res, 200, { messages: readHistory(sessionFile), entries: readEntries(sessionFile) });
    }],
    ["GET", "/api/conversations/:id/files", (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      sendJson(ctx.res, 200, { files: readFileChanges(conv.session_file ?? "") });
    }],
    ["GET", "/api/conversations/:id/file", (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      const path = ctx.query.get("path");
      if (!path) return sendJson(ctx.res, 400, { error: "path requis" });
      sendJson(ctx.res, 200, { path, operations: readFileDetail(conv.session_file ?? "", path) });
    }],
    ["POST", "/api/conversations/:id/messages", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      const b = parseBody(ctx.res, messageSchema, ctx.body);
      if (!b) return;
      const text = (b.text ?? "").trim();
      const runtime = deps.compose(conv);
      if (runtime.kind === "durable" && !b.requestId) {
        return sendJson(ctx.res, 400, { error: "requestId requis pour une conversation durable" });
      }
      await runtime.ensure(conv);
      ctx.check();
      const ack = await runtime.prompt(conv, text, b.requestId, b.images);
      ctx.check();
      if (text) setConversationTitle(db, conv.id, text);
      // Durable : accusé renvoyé après acceptation durable, avec l'identité acceptée.
      sendJson(ctx.res, 200, ack.accepted ? { ok: true, accepted: ack.accepted } : { ok: true });
    }],
    // ---------- Missions durables : statut, approbations, budget (#16) ----------
    ["GET", "/api/conversations/:id/mission", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      if (runtimeKindOf(conv) !== "durable") return sendJson(ctx.res, 409, { error: "pas une mission durable" });
      sendJson(ctx.res, 200, { mission: await deps.durable.missionStatus(conv) });
    }],
    ["GET", "/api/conversations/:id/approvals", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      if (runtimeKindOf(conv) !== "durable") return sendJson(ctx.res, 409, { error: "pas une mission durable" });
      const runtime = await deps.durable.get(conv);
      sendJson(ctx.res, 200, await runtime.approvalsView());
    }],
    // Décision owner sur une action immuable créée côté serveur ; rien d'autre
    // n'est acceptable ici (le client ne fabrique jamais l'action à approuver).
    ["POST", "/api/conversations/:id/approvals", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      if (runtimeKindOf(conv) !== "durable") return sendJson(ctx.res, 409, { error: "pas une mission durable" });
      const b = parseBody(ctx.res, approvalDecisionSchema, ctx.body);
      if (!b) return;
      const runtime = await deps.durable.get(conv);
      const result = await runtime.decideApproval(b.pendingActionId, b.decision, b.denialReason);
      if (result.kind === "error") return sendJson(ctx.res, 409, { error: result.reason });
      sendJson(ctx.res, 200, result.grant ? { ok: true, pendingAction: result.pendingAction, grant: result.grant } : { ok: true, pendingAction: result.pendingAction });
    }],
    ["POST", "/api/conversations/:id/approvals/:grantId/revoke", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      if (runtimeKindOf(conv) !== "durable") return sendJson(ctx.res, 409, { error: "pas une mission durable" });
      const runtime = await deps.durable.get(conv);
      const result = await runtime.revokeGrant(ctx.params.grantId!);
      if (!result.ok) return sendJson(ctx.res, 404, { error: result.reason });
      sendJson(ctx.res, 200, { ok: true });
    }],
    // Changement EXPLICITE de limite (le seul déliement possible d'une limite de mission).
    ["POST", "/api/conversations/:id/budget", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      if (runtimeKindOf(conv) !== "durable") return sendJson(ctx.res, 409, { error: "pas une mission durable" });
      const b = parseBody(ctx.res, budgetUpdateSchema, ctx.body);
      if (!b) return;
      const runtime = await deps.durable.get(conv);
      await runtime.setBudgetPolicy(b);
      sendJson(ctx.res, 200, { ok: true, mission: await runtime.missionStatus() });
    }],
    ["POST", "/api/conversations/:id/stop", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      await deps.compose(conv).abort(conv);
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["POST", "/api/conversations/:id/model", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      if (runtimeKindOf(conv) === "durable") {
        // Modèle figé par mission (O6) : pas de bascule à chaud sur une runtime durable.
        return sendJson(ctx.res, 409, { error: "modèle figé pour une mission durable (créer une nouvelle conversation)" });
      }
      const b = parseBody(ctx.res, modelSwitchSchema, ctx.body);
      if (!b) return;
      try {
        const result = await changeConfiguration({ db, pool, paths: deps.paths, ensure: c => deps.spawner.ensure(c), onPresetChanged: () => deps.events.emit("event", { type: "agents_changed" }) }, conv.id, b);
        sendJson(ctx.res, result.status, result.conversation);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        sendJson(ctx.res, error instanceof ConfigurationError ? error.status : (error as { code?: string }).code === "pool_full" ? 503 : 502,
          { error: error instanceof Error ? error.message : String(error) });
      }
    }],
    ["DELETE", "/api/conversations/:id/model", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      try { sendJson(ctx.res, 200, dismissConfiguration(db, pool, conv.id)); }
      catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        sendJson(ctx.res, error.status, { error: error.message });
      }
    }],
    ["DELETE", "/api/conversations/:id", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      await deps.compose(conv).evict(conv);
      ctx.check();
      deleteConversation(db, conv.id);
      // L'historique survit sur disque : pi .jsonl en classic (I5), stockage
      // Durable propre en durable (ADR-006 amendé).
      sendJson(ctx.res, 200, { ok: true });
    }],
  ];
}

/** Choisit l'agent (preset explicite, hérité du workspace, ou défaut global) ou le provider libre. */
function resolveSpawnTarget(
  deps: Deps,
  b: ConversationCreate,
): { agentId: string | null; spawn: SpawnConfig; workspaceId: string | null } | { error: string; status: number } {
  const { db } = deps;
  const workspace = b.workspace_id ? getWorkspace(db, b.workspace_id) : null;
  if (b.workspace_id && !workspace) return { error: "workspace introuvable", status: 404 };

  // héritage : agent par défaut du workspace quand rien de précisé
  const agentId = b.agent_id ?? (b.provider ? null : workspace?.default_agent_id ?? null);
  if (agentId) {
    const preset = getAgent(db, agentId);
    if (!preset) return { error: "agent introuvable", status: 404 };
    const workspaceId = b.workspace_id ?? preset.default_workspace_id ?? null;
    if (workspaceId && !getWorkspace(db, workspaceId)) return { error: "workspace introuvable", status: 404 };
    return { agentId: preset.id, spawn: spawnConfigFromPreset(preset), workspaceId };
  }
  if (b.provider && b.model) {
    return {
      agentId: null,
      workspaceId: b.workspace_id ?? null,
      spawn: {
        provider: b.provider, model: b.model, thinking: b.thinking ?? null,
        systemPrompt: b.system_prompt, skills: b.skills, tools: b.tools, mcpServers: b.mcp_servers,
      },
    };
  }
  // repli : agent par défaut global (le Majordome si seedé)
  const fallbackId = getDefaultAgentId(db);
  if (!fallbackId) return { error: "aucun agent par défaut — précise agent_id ou provider+model", status: 400 };
  const preset = getAgent(db, fallbackId);
  if (!preset) return { error: "agent introuvable", status: 404 };
  const workspaceId = b.workspace_id ?? preset.default_workspace_id ?? null;
  if (workspaceId && !getWorkspace(db, workspaceId)) return { error: "workspace introuvable", status: 404 };
  return { agentId: preset.id, spawn: spawnConfigFromPreset(preset), workspaceId };
}

/** Groupes de bots (ADR-011) : création/liste + fil partagé (bus, routage hôte/@, SSE unique). */
function groupRoutes(deps: Deps): Route[] {
  const { db, pool } = deps;
  return [
    ["GET", "/api/groups", (ctx) => {
      sendJson(ctx.res, 200, { groups: listGroups(db) });
    }],
    ["POST", "/api/groups", async (ctx) => {
      const b = parseBody(ctx.res, groupCreateSchema, ctx.body);
      if (!b) return;
      const prepared = prepareGroupCreate(deps, b);
      if ("error" in prepared) return sendJson(ctx.res, prepared.status, { error: prepared.error });

      // écritures DB atomiques, puis spawn idle des sessions membres (I3 : tout passe par le pool)
      const members = db.transaction(() => {
        const group = insertGroup(db, prepared);
        return prepared.members.map((preset) => ({
          preset,
          conv: createConversation(db, {
            workspaceId: prepared.defaultWorkspaceId ?? prepared.hostPreset.default_workspace_id ?? null,
            agentId: preset.id,
            groupId: group.id,
            spawn: spawnConfigFromPreset(preset),
          }),
        }));
      })();
      try {
        await Promise.all(members.map(({ conv }) => deps.spawner.ensure(conv)));
      } catch (err) {
        return sendJson(ctx.res, 502, { error: `spawn membre impossible : ${err instanceof Error ? err.message : String(err)}` });
      }
      ctx.check();
      sendJson(ctx.res, 201, { group: getGroupWithMembers(db, members[0]!.conv.group_id!) });
    }],
    ["GET", "/api/groups/:id", (ctx) => {
      const group = getGroupWithMembers(db, ctx.params.id!);
      if (!group) return notFound(ctx.res, "groupe");
      sendJson(ctx.res, 200, { group });
    }],
    // Bus du fil : rejeu pour le montage de l'UI (le streaming passe par le SSE unique ci-dessous)
    ["GET", "/api/groups/:id/messages", (ctx) => {
      if (!getGroupWithMembers(db, ctx.params.id!)) return notFound(ctx.res, "groupe");
      sendJson(ctx.res, 200, { messages: listGroupMessages(db, ctx.params.id!) });
    }],
    // Une ligne utilisateur → bus + injection dans la session du seul membre visé (hôte sans @, ADR-011)
    ["POST", "/api/groups/:id/messages", async (ctx) => {
      const group = getGroupWithMembers(db, ctx.params.id!);
      if (!group) return notFound(ctx.res, "groupe");
      const b = parseBody(ctx.res, messageSchema, ctx.body);
      if (!b) return;
      const text = (b.text ?? "").trim();
      const target = routeGroupMessage(group, text);

      appendGroupMessage(db, { groupId: group.id, role: "user", text });
      const conv = db
        .prepare("SELECT * FROM conversation WHERE group_id = ? AND agent_id = ?")
        .get(group.id, target.agent_id) as ConversationRow | undefined;
      if (!conv) return sendJson(ctx.res, 500, { error: "session membre introuvable" });
      await deps.spawner.ensure(conv);
      ctx.check();
      await pool.prompt(conv.id, text, b.images);
      ctx.check();
      sendJson(ctx.res, 200, { ok: true });
    }],
    // Fil du groupe suivi sur UN flux SSE (pas N flux des sessions membres) — événements pi enveloppés group_activity
    ["GET", "/api/groups/:id/events", (ctx) => {
      if (!getGroupWithMembers(db, ctx.params.id!)) return notFound(ctx.res, "groupe");
      // événement initial : flush des en-têtes immédiat (sinon le client attend le premier heartbeat)
      const send = openSse(ctx.res, { type: "group_ready", groupId: ctx.params.id! });
      const subs = deps.groupSubs.get(ctx.params.id!) ?? new Set<SseSend>();
      deps.groupSubs.set(ctx.params.id!, subs);
      subs.add(send);
      ctx.res.once("close", () => {
        subs.delete(send);
        if (!subs.size) deps.groupSubs.delete(ctx.params.id!);
      });
    }],
    ["DELETE", "/api/groups/:id", (ctx) => {
      if (!getGroupWithMembers(db, ctx.params.id!)) return notFound(ctx.res, "groupe");
      deleteGroup(db, ctx.params.id!); // conversations membres en CASCADE
      sendJson(ctx.res, 200, { ok: true });
    }],
  ];
}

interface PreparedGroupCreate extends CreateGroupInput {
  members: AgentPreset[];
  hostPreset: AgentPreset;
}

/** Valide membres/hôte/workspace ; renvoie l'entrée préparée ou l'erreur HTTP. */
function prepareGroupCreate(deps: Deps, b: GroupCreate): PreparedGroupCreate | { error: string; status: number } {
  const { db } = deps;
  const unique = [...new Set(b.member_agent_ids)];
  if (unique.length < 2 || unique.length > 6) {
    return { error: "un groupe contient 2 à 6 bots distincts", status: 400 };
  }
  const members = unique.map((id) => getAgent(db, id));
  if (members.some((m) => !m)) return { error: "agent membre introuvable", status: 404 };
  const hostId = b.host_agent_id ?? unique[0]!;
  if (!unique.includes(hostId)) return { error: "l'hôte doit être un membre du groupe", status: 400 };
  const hostPreset = members.find((m) => m!.id === hostId)!;
  if (b.default_workspace_id && !getWorkspace(db, b.default_workspace_id)) {
    return { error: "workspace introuvable", status: 404 };
  }
  return {
    name: b.name,
    memberAgentIds: unique,
    hostAgentId: hostId,
    defaultWorkspaceId: b.default_workspace_id ?? null,
    members: members as AgentPreset[],
    hostPreset,
  };
}

/** Persiste sur le bus l'activité d'un membre : outils exécutés + réponse finale en fin de tour (ADR-011).
 *  onReply est appelé avec le texte de la réponse dès qu'elle est persistée (handoff #12). */
function persistGroupActivity(
  db: Db,
  convId: string,
  owner: { group_id: string; agent_id: string | null; session_file: string | null },
  event: unknown,
  onReply?: (text: string) => void,
): void {
  const ev = event as {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    result?: { content?: Array<{ type?: string; text?: string }> };
    isError?: boolean;
  };
  if (ev.type === "tool_execution_end" && ev.toolCallId) {
    const result = ev.result?.content
      ?.filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
    appendGroupMessage(db, {
      groupId: owner.group_id, conversationId: convId, agentId: owner.agent_id,
      role: "tool", text: ev.toolName ?? "outil",
      detail: JSON.stringify({ result }), isError: ev.isError === true,
    });
    return;
  }
  if (ev.type !== "agent_end") return;
  const append = (): boolean => {
    const lastAssistant = [...readEntries(owner.session_file ?? "")]
      .reverse()
      .find((e) => e.type === "assistant" && e.text.trim());
    if (!lastAssistant || lastAssistant.type !== "assistant") return false; // jsonl pas encore flush : une reprise différée
    // garde anti-doublon : même conversation + même texte déjà en tête de bus
    const head = listGroupMessages(db, owner.group_id, 1)[0];
    if (head?.role === "assistant" && head.conversation_id === convId && head.text === lastAssistant.text) return true;
    appendGroupMessage(db, {
      groupId: owner.group_id, conversationId: convId, agentId: owner.agent_id,
      role: "assistant", text: lastAssistant.text,
    });
    onReply?.(lastAssistant.text);
    return true;
  };
  if (!append()) {
    const retry = setTimeout(() => {
      try { append(); } catch { /* bus best-effort : le rejeu suivant complètera */ }
    }, 1500);
    retry.unref();
  }
}

/** Tâches planifiées (cron) + historique de runs. */
function scheduleRoutes(deps: Deps): Route[] {
  const { db, cron } = deps;
  return [
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
      if (!deleteTask(db, ctx.params.id!)) return notFound(ctx.res, "schedule");
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["POST", "/api/schedules/:id/run", (ctx) => {
      if (!cron) return sendJson(ctx.res, 503, { error: "cron indisponible" });
      const task = getTask(db, ctx.params.id!);
      if (!task) return notFound(ctx.res, "schedule");
      // fire-and-forget : le run est tracé et observable via /runs + /events
      requestAuthorization.exit(() => { void cron.fireNow(task.id).catch(() => undefined); });
      sendJson(ctx.res, 202, { ok: true });
    }],
    ["GET", "/api/schedules/:id/runs", (ctx) => {
      const limit = Number(ctx.query.get("limit") ?? DEFAULT_RUNS_LIMIT);
      sendJson(ctx.res, 200, { runs: listRuns(db, ctx.params.id!, Number.isFinite(limit) ? limit : DEFAULT_RUNS_LIMIT) });
    }],
  ];
}

const DEFAULT_RUNS_LIMIT = 50;

function healthRoute(deps: Deps): Route {
  const { dbPath, dbVersion, paths, pool } = deps;
  return ["GET", "/api/health", (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      version: packageVersion(),
      pi_version: piVersion(),
      sessions_active: pool.size,
      mcp_adapter_detected: mcpAdapterDetected(paths),
      db: { path: dbPath, version: dbVersion },
    });
  }];
}

// ---------- App ----------

export interface AppOptions {
  db: Db;
  dbPath: string;
  dbVersion: number;
  paths: Paths;
  pool: PiPool;
  cron?: CronService;
  events?: EventEmitter;
  auth?: AuthState;
  server?: Server;
  /** Gestionnaire durable injecté (tests : modèle faux) ; défaut : production. */
  durable?: DurableRuntimeManager;
}

export function createApp(opts: AppOptions): Server {
  const { db, paths, pool, cron } = opts;
  const events = opts.events ?? new EventEmitter();
  events.setMaxListeners(MAX_SSE_LISTENERS);

  recoverConfigurations(db);
  const spawner = makeSpawner({ db, pool, paths });
  // Runtime Durable : un seul gestionnaire dans le processus contrôleur (bail OS
  // par conversation). Les tests injectent un modèle contrôlé via opts.durable.
  const durable = opts.durable ?? new DurableRuntimeManager({ paths, toolchain: durableToolchainRegistry() });
  const compose = composeRuntime({ pool, spawner, durable });
  // Tours déclenchés par un handoff : leur réponse ne re-handoffe pas (garde anti-boucle A↔B, #12)
  const handoffTargets = new Set<string>();

  // Handoff ADR-011 (#12) : une réponse de membre qui @ un autre membre est injectée dans sa session.
  async function handleHandoff(sourceConvId: string, groupId: string, text: string): Promise<void> {
    if (handoffTargets.delete(sourceConvId)) return; // réponse d'un tour déclenché par handoff : pas de cascade
    const group = getGroupWithMembers(db, groupId);
    if (!group) return;
    const target = matchGroupMention(group, text);
    if (!target || target.conversation_id === sourceConvId) return;
    const conv = db
      .prepare("SELECT * FROM conversation WHERE id = ?")
      .get(target.conversation_id) as ConversationRow | undefined;
    if (!conv) return;
    handoffTargets.add(target.conversation_id);
    try {
      await spawner.ensure(conv);
      await pool.prompt(conv.id, text);
    } catch {
      handoffTargets.delete(target.conversation_id);
    }
  }

  // Fan-out des événements pi vers les abonnés SSE par conversation
  const sseSubs = new Map<string, Set<SseSend>>();
  const groupSubs = new Map<string, Set<SseSend>>();
  const unsubscribePool = pool.onEvent((convId, event) => {
    for (const send of sseSubs.get(convId) ?? []) send(event);
    // ADR-011 : activité d'un membre de groupe → persistance bus + relais sur le SSE unique du fil
    const owner = conversationGroupOwner(db, convId);
    if (!owner) return;
    persistGroupActivity(db, convId, owner, event, (text) => void handleHandoff(convId, owner.group_id, text));
    const envelope = { type: "group_activity", conversationId: convId, agentId: owner.agent_id, name: owner.name, event };
    for (const send of groupSubs.get(owner.group_id) ?? []) send(envelope);
  });

  const deps: Deps = {
    db,
    dbPath: opts.dbPath,
    dbVersion: opts.dbVersion,
    paths,
    pool,
    cron,
    events,
    sseSubs,
    groupSubs,
    spawner,
    compose,
    durable,
  };

  const routes: Route[] = [
    healthRoute(deps),
    ...registryRoutes(deps),
    ...agentRoutes(deps),
    ...workspaceRoutes(deps),
    ...boardRoutes(deps),
    ...groupRoutes(deps),
    ...conversationRoutes(deps),
    ...scheduleRoutes(deps),
    // Events global (SSE) — les runs cron et les statuts de conversation
    ["GET", "/api/events", (ctx) => {
      const send = openSse(ctx.res);
      events.on("event", send);
      ctx.res.once("close", () => events.off("event", send));
    }],
  ];

  const app = opts.server ?? createServer();
  if (opts.auth) { app.requestTimeout = 30_000; app.headersTimeout = 10_000; app.maxHeadersCount = 100; }
  app.once("close", () => {
    unsubscribePool();
    void durable.dispose();
  });
  app.on("request", async (req, res) => {
    res.setHeader("content-security-policy", "frame-ancestors 'none'");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      const privateRequest = privateRequests.has(req);
      const state = opts.auth;
      if (privateRequest && ("origin" in req.headers || Object.keys(req.headers).some(h => h.startsWith("sec-fetch-")))) throw new AuthError("FORBIDDEN", 403);
      if (state) {
        state.assertAvailable();
        if (!privateRequest) validateBoundary(req, state);
      } else localCheck(paths.home);
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      if (req.url === "/api/status" && req.method === "GET") return authJson(res, 200, { service: "cogitator", authentication: state ? "required" : "local" });
      if (url.pathname.startsWith("/api/auth")) {
        if (privateRequest) throw new AuthError("FORBIDDEN", 403);
        if (state) return await authRoute(req, res, state);
        if (req.url === "/api/auth/status" && req.method === "GET") return authJson(res, 200, { mode: "local" });
        throw new AuthError("NOT_FOUND", 404);
      }
      // Only the build login shell and its JS/CSS/font assets are public, never an SPA fallback.
      if (state && !url.pathname.startsWith("/api/") && req.method === "GET" && serveStatic(res, url.pathname, true)) return;
      let check = () => localCheck(paths.home);
      if (state) {
        if (privateRequest) check = () => state.assertAvailable();
        else {
          const session = await ownerSession(state.auth, state.db, state.config, browserHeaders(req));
          requireApproved(session);
          check = () => { state.assertAvailable(); requireApproved(sessionById(state.db, state.config, session.id)); };
        }
      }
      check();
      responseChecks.set(res, check);
      if (state) res.setHeader("cache-control", "no-store");
      if (!url.pathname.startsWith("/api/")) {
        if (serveStatic(res, url.pathname)) return;
        return sendJson(res, 404, { error: "NOT_FOUND" });
      }
      const body = req.method === "POST" || req.method === "PUT" || req.method === "DELETE" ? await readBody(req) : {};
      check();
      const found = matchRoute(routes, req.method ?? "GET", url.pathname);
      if (!found) return sendJson(res, 404, { error: state ? "NOT_FOUND" : `not found: ${url.pathname}` });
      await requestAuthorization.run(check, () => found.handler({ params: found.params, query: url.searchParams, body, req, res, check }));
    } catch (err) {
      if (err instanceof AuthError || opts.auth || protectedRequired(paths.home)) authFailure(res, err);
      else if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });
  return app;
}

// Server-owned identity only: no HTTP header can confer the local OS-owner capability.
const privateRequests = new WeakSet<IncomingMessage>();
export function createPrivateServer(app: Server): Server {
  return createServer((req, res) => { privateRequests.add(req); app.emit("request", req, res); });
}

export { sendJson, API_PROTOCOLS };
