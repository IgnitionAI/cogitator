/**
 * Surface HTTP/WebSocket du terminal web (voir terminal.ts pour le modèle de sécurité).
 *
 *  GET    /api/terminal                → disponibilité + sessions
 *  POST   /api/terminal/sessions       → shell ou agent pi interactif
 *  DELETE /api/terminal/sessions/:id   → ferme la session
 *  POST   /api/terminal/assist         → commande / complétion / explication (jamais exécutée)
 *  WS     /api/terminal/ws/:id         → flux du pseudo-terminal
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { AuthState } from "./auth-state.js";
import { browserHeaders } from "./auth-http.js";
import { AuthError, ownerSession, requireApproved, sessionById } from "./native-auth.js";
import { runAssist, type CompleteFn, type ModelTarget } from "./terminal-assist.js";
import { TerminalError, type TerminalLaunch, type TerminalManager } from "./terminal.js";

type Ctx = { params: Record<string, string>; body: unknown; req: IncomingMessage; res: ServerResponse; check: () => void };
type Route = [string, string, (ctx: Ctx) => Promise<void> | void];

export interface TerminalHttpDeps {
  manager: TerminalManager;
  /** Mode protégé actif (login propriétaire) : condition de disponibilité. */
  protectedMode: boolean;
  /** Requête sans identité navigateur (socket propriétaire, dispatch MCP interne) : refusée. */
  nonBrowser: (req: IncomingMessage) => boolean;
  send: (res: ServerResponse, status: number, data: unknown) => void;
  shell: (cwd?: string) => TerminalLaunch;
  agent: (agentId: string, cwd?: string) => TerminalLaunch;
  /** Dossier d'un workspace, ou erreur. */
  workspaceDir: (workspaceId: string) => string;
  /** Modèle de l'agent demandé, ou de l'agent par défaut. */
  assistTarget: (agentId?: string) => ModelTarget;
  complete: CompleteFn;
  agents: () => Array<{ id: string; name: string; provider: string; model: string }>;
}

export function terminalDisabledReason(protectedMode: boolean, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.COGITATOR_TERMINAL === "0") return "TERMINAL_DISABLED";
  if (!protectedMode) return "TERMINAL_PROTECTED_MODE_REQUIRED";
  return null;
}

const createSchema = z.object({
  agent_id: z.string().min(1).max(64).optional(),
  workspace_id: z.string().min(1).max(64).optional(),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
}).strict();

const assistSchema = z.object({
  mode: z.enum(["command", "complete", "explain"]),
  input: z.string().min(1).max(4000),
  output: z.string().max(20_000).optional(),
  cwd: z.string().max(1024).optional(),
  exit_code: z.number().int().optional(),
  agent_id: z.string().min(1).max(64).optional(),
}).strict();

export function terminalRoutes(d: TerminalHttpDeps): Route[] {
  const guard = (ctx: Ctx) => {
    if (d.nonBrowser(ctx.req)) throw new AuthError("FORBIDDEN", 403);
    const reason = terminalDisabledReason(d.protectedMode);
    if (reason) { d.send(ctx.res, 403, { error: reason }); return false; }
    ctx.check();
    return true;
  };
  const fail = (ctx: Ctx, error: unknown) => {
    if (error instanceof AuthError) throw error;
    if (error instanceof TerminalError) return d.send(ctx.res, error.status, { error: error.code });
    if (error instanceof z.ZodError) return d.send(ctx.res, 400, { error: "TERMINAL_INVALID_INPUT" });
    d.send(ctx.res, 400, { error: error instanceof Error ? error.message : "TERMINAL_FAILED" });
  };
  return [
    ["GET", "/api/terminal", (ctx) => {
      if (d.nonBrowser(ctx.req)) throw new AuthError("FORBIDDEN", 403);
      const reason = terminalDisabledReason(d.protectedMode) ?? (d.manager.available ? null : "TERMINAL_UNAVAILABLE");
      d.send(ctx.res, 200, { enabled: reason === null, reason, sessions: reason ? [] : d.manager.list(), agents: reason ? [] : d.agents() });
    }],
    ["POST", "/api/terminal/sessions", (ctx) => {
      if (!guard(ctx)) return;
      try {
        const b = createSchema.parse(ctx.body);
        const cwd = b.workspace_id ? d.workspaceDir(b.workspace_id) : undefined;
        const launch = b.agent_id ? d.agent(b.agent_id, cwd) : d.shell(cwd);
        ctx.check();
        const info = d.manager.create(launch, { cols: b.cols ?? 80, rows: b.rows ?? 24 });
        d.send(ctx.res, 201, { session: info, shellIntegration: launch.shellIntegration });
      } catch (error) { fail(ctx, error); }
    }],
    ["DELETE", "/api/terminal/sessions/:id", (ctx) => {
      if (!guard(ctx)) return;
      if (!d.manager.close(ctx.params.id!)) return d.send(ctx.res, 404, { error: "TERMINAL_NOT_FOUND" });
      d.send(ctx.res, 200, { ok: true });
    }],
    ["POST", "/api/terminal/assist", async (ctx) => {
      if (!guard(ctx)) return;
      try {
        const b = assistSchema.parse(ctx.body);
        const target = d.assistTarget(b.agent_id);
        const abort = new AbortController();
        ctx.res.once("close", () => { if (!ctx.res.writableEnded) abort.abort(); });
        const result = await runAssist(d.complete, target, { mode: b.mode, input: b.input, output: b.output, cwd: b.cwd, exitCode: b.exit_code }, abort.signal);
        ctx.check();
        d.send(ctx.res, 200, { ...result, model: `${target.provider}/${target.model}` });
      } catch (error) { fail(ctx, error); }
    }],
  ];
}

const frameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("i"), d: z.string().max(65_536) }),
  z.object({ t: z.literal("r"), c: z.number().int(), r: z.number().int() }),
]);

export const TERMINAL_WS_PREFIX = "/api/terminal/ws/";

/** WebSocket du terminal : session propriétaire exigée et revérifiée chaque seconde. */
export function attachTerminalSocket(app: Server, manager: TerminalManager, state: AuthState | undefined): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  app.once("close", () => { for (const peer of wss.clients) peer.terminate(); wss.close(); manager.dispose(); });
  app.on("upgrade", async (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith(TERMINAL_WS_PREFIX)) return;
    try {
      const match = /^\/api\/terminal\/ws\/([a-f0-9-]{36})$/.exec(url);
      if (!match || !state || terminalDisabledReason(true)) throw new Error("route");
      state.assertAvailable();
      if (req.headers.host !== new URL(state.config.origin).host || req.headers.origin !== state.config.origin) throw new Error("origin");
      const session = await ownerSession(state.auth, state.db, state.config, browserHeaders(req));
      requireApproved(session, state.config);
      const check = () => { state.assertAvailable(); requireApproved(sessionById(state.db, state.config, session.id), state.config); };
      const id = match[1]!;
      if (!manager.get(id)) throw new Error("session");
      wss.handleUpgrade(req, socket, head, (peer) => {
        let detach = () => {};
        const close = () => { detach(); if (peer.readyState === peer.OPEN) peer.close(1008); };
        try {
          detach = manager.attach(id, {
            send: (frame) => { if (peer.readyState === peer.OPEN && peer.bufferedAmount < 4 * 1024 * 1024) peer.send(frame); },
            close: () => peer.close(1000),
          });
        } catch { peer.close(1011); return; }
        const timer = setInterval(() => { try { check(); } catch { close(); } }, 1000);
        peer.on("message", (data) => {
          try {
            check();
            const frame = frameSchema.parse(JSON.parse(data.toString()));
            if (frame.t === "i") manager.input(id, frame.d);
            else manager.resize(id, frame.c, frame.r);
          } catch (error) {
            if (error instanceof AuthError) close();
          }
        });
        peer.on("error", () => peer.terminate());
        peer.once("close", () => { clearInterval(timer); detach(); });
      });
    } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
  });
}
