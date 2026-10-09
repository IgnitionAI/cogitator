import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import type { ZodType } from "zod";
import { HOST } from "./config.js";
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
  setConversationModel, setConversationTitle, type ConversationRow,
} from "./conversations.js";
import { PiPool } from "./pool.js";
import { makeSpawner, type Spawner } from "./spawner.js";
import { readHistory, readEntries } from "./history.js";
import { readFileChanges, readFileEvents, readFileDetail, type FileChange } from "./file-changes.js";
import { workspaceTree, readWorkspaceFile } from "./workspace-files.js";
import {
  listCards, createCardGh, updateCardGh, moveCardGh, addCommentGh, closeCardGh,
  type BoardCard, type CardWrite,
} from "./board.js";
import { importSkills } from "./skills-import.js";
import {
  agentInputSchema, conversationCreateSchema, messageSchema, modelSwitchSchema,
  providerUpsertSchema, scheduleCreateSchema, scheduleUpdateSchema, skillImportSchema,
  workspaceCreateSchema, workspaceUpdateSchema, boardCardSchema, boardCommentSchema,
  type BoardCardInput, type ConversationCreate,
} from "./schemas.js";
import { spawnConfigFromPreset, type SpawnConfig } from "./spawn.js";
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
function serveStatic(res: ServerResponse, pathname: string): boolean {
  const root = findWebDist();
  if (!root) return false;
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

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body trop volumineux"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("JSON invalide"));
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
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/** Ouvre un flux SSE et renvoie l'émetteur (`initial` = premier événement, ex. session_file). */
function openSse(res: ServerResponse, initial?: unknown): SseSend {
  res.writeHead(200, SSE_HEADERS);
  const send: SseSend = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
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
  const { db, paths } = deps;
  return [
    ["GET", "/api/agents", (ctx) => {
      sendJson(ctx.res, 200, { agents: listAgents(db) });
    }],
    ["POST", "/api/agents", (ctx) => {
      const input = parseBody(ctx.res, agentInputSchema, ctx.body);
      if (!input) return;
      const preset = createAgent(db, input);
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
      const preset = updateAgent(db, ctx.params.id!, input);
      if (!preset) return notFound(ctx.res, "agent");
      sendJson(ctx.res, 200, { agent: preset, apply: applyAgent(paths, preset) });
    }],
    ["DELETE", "/api/agents/:id", (ctx) => {
      const existing = requireAgent(deps, ctx);
      if (!existing) return;
      deleteAgent(db, existing.id);
      sendJson(ctx.res, 200, { ok: true, unapplied: unapplyAgent(paths, existing.slug) });
    }],
    ["POST", "/api/agents/:id/validate", async (ctx) => {
      const preset = requireAgent(deps, ctx);
      if (!preset) return;
      sendJson(ctx.res, 200, await validateAgent(paths, preset, checkAuthReadyFor));
    }],
    ["POST", "/api/agents/:id/default", (ctx) => {
      if (!setDefaultAgent(db, ctx.params.id!)) return notFound(ctx.res, "agent");
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
      const { workspace, error } = createWorkspace(db, b);
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
      const started = await startCardWork(deps, ws, cardNumber(ctx), ((ctx.body ?? {}) as { extra?: string }).extra);
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
): Promise<{ conversation: ConversationRow; card: BoardCard } | { error: string; status: number }> {
  const found = await findCard(ws.dir, number);
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
  await deps.pool.prompt(titled.id, ticketPrompt(card, extra));

  const moved = await moveCardGh(ws.dir, card.number, "in_progress");
  if ("error" in moved) return { conversation: titled, card };
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
      const workspaceId = ctx.query.get("workspace_id");
      sendJson(ctx.res, 200, { conversations: listConversations(db, workspaceId ?? undefined) });
    }],
    ["POST", "/api/conversations", async (ctx) => {
      const b = parseBody(ctx.res, conversationCreateSchema, ctx.body);
      if (!b) return;
      const resolved = resolveSpawnTarget(deps, b);
      if ("error" in resolved) return sendJson(ctx.res, resolved.status, { error: resolved.error });

      let conv = createConversation(db, { workspaceId: b.workspace_id ?? null, agentId: resolved.agentId, spawn: resolved.spawn });
      const prompt = b.prompt?.trim();
      if (prompt) {
        await deps.spawner.ensure(conv);
        await pool.prompt(conv.id, prompt);
        setConversationTitle(db, conv.id, prompt);
        conv = getConversation(db, conv.id)!;
      }
      sendJson(ctx.res, 201, { conversation: conv });
    }],
    ["GET", "/api/conversations/:id", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      sendJson(ctx.res, 200, { conversation: conv, live: pool.isLive(conv.id), streaming: await pool.isStreaming(conv.id) });
    }],
    ["GET", "/api/conversations/:id/events", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      const spawned = await deps.spawner.ensure(conv);
      const send = openSse(ctx.res, { type: "session", sessionFile: spawned.sessionFile ?? conv.session_file });
      const subs = deps.sseSubs.get(conv.id) ?? new Set<SseSend>();
      deps.sseSubs.set(conv.id, subs);
      subs.add(send);
      ctx.req.on("close", () => {
        subs.delete(send);
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
      await deps.spawner.ensure(conv);
      await pool.prompt(conv.id, text, b.images);
      if (text) setConversationTitle(db, conv.id, text);
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["POST", "/api/conversations/:id/stop", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      await pool.abort(conv.id);
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["POST", "/api/conversations/:id/model", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      const b = parseBody(ctx.res, modelSwitchSchema, ctx.body);
      if (!b) return;
      await pool.setModel(conv.id, b.provider, b.id);
      const spawn = { ...(JSON.parse(conv.spawn_args || "{}") as SpawnConfig), provider: b.provider, model: b.id };
      setConversationModel(db, conv.id, b.provider, b.id, spawn);
      sendJson(ctx.res, 200, { ok: true });
    }],
    ["DELETE", "/api/conversations/:id", async (ctx) => {
      const conv = requireConversation(deps, ctx);
      if (!conv) return;
      await pool.evict(conv.id);
      deleteConversation(db, conv.id);
      sendJson(ctx.res, 200, { ok: true }); // le .jsonl pi survit sur disque (I5)
    }],
  ];
}

/** Choisit l'agent (preset explicite, hérité du workspace, ou défaut global) ou le provider libre. */
function resolveSpawnTarget(
  deps: Deps,
  b: ConversationCreate,
): { agentId: string | null; spawn: SpawnConfig } | { error: string; status: number } {
  const { db } = deps;
  const workspace = b.workspace_id ? getWorkspace(db, b.workspace_id) : null;
  if (b.workspace_id && !workspace) return { error: "workspace introuvable", status: 404 };

  // héritage : agent par défaut du workspace quand rien de précisé
  const agentId = b.agent_id ?? (b.provider ? null : workspace?.default_agent_id ?? null);
  if (agentId) {
    const preset = getAgent(db, agentId);
    if (!preset) return { error: "agent introuvable", status: 404 };
    return { agentId: preset.id, spawn: spawnConfigFromPreset(preset) };
  }
  if (b.provider && b.model) {
    return {
      agentId: null,
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
  return { agentId: preset.id, spawn: spawnConfigFromPreset(preset) };
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
      void cron.fireNow(task.id).catch(() => undefined);
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
}

export function createApp(opts: AppOptions): Server {
  const { db, paths, pool, cron } = opts;
  const events = opts.events ?? new EventEmitter();
  events.setMaxListeners(MAX_SSE_LISTENERS);

  // Fan-out des événements pi vers les abonnés SSE par conversation
  const sseSubs = new Map<string, Set<SseSend>>();
  pool.onEvent((convId, event) => {
    for (const send of sseSubs.get(convId) ?? []) send(event);
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
    spawner: makeSpawner({ db, pool, paths }),
  };

  const routes: Route[] = [
    healthRoute(deps),
    ...registryRoutes(deps),
    ...agentRoutes(deps),
    ...workspaceRoutes(deps),
    ...boardRoutes(deps),
    ...conversationRoutes(deps),
    ...scheduleRoutes(deps),
    // Events global (SSE) — les runs cron et les statuts de conversation
    ["GET", "/api/events", (ctx) => {
      const send = openSse(ctx.res);
      events.on("event", send);
      ctx.req.on("close", () => events.off("event", send));
    }],
  ];

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (!url.pathname.startsWith("/api/")) {
      if (serveStatic(res, url.pathname)) return;
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
