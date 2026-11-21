/**
 * Serveur MCP Cogitator en Streamable HTTP (`/mcp`) — pour les agents externes
 * (Claude, GPT, bots…) qui pilotent Cogitator à distance.
 *
 * - Authentification : `Authorization: Bearer cgt_…` (voir mcp-tokens.ts), exigée en
 *   mode local comme en mode protégé, revérifiée à chaque requête HTTP et à chaque appel d'outil.
 * - Sessions MCP avec état (en-tête `Mcp-Session-Id`), liées au jeton qui les a ouvertes.
 * - Les outils (mcp-tools.ts) passent par le dispatch interne des routes `/api/*` :
 *   mêmes validations, mêmes contrôles de disponibilité que l'UI, sans boucle réseau.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerCogitatorTools, type CogitatorCall } from "./mcp-tools.js";
import { bearerToken, McpTokenVerifier, type McpTokenInfo } from "./mcp-tokens.js";
import type { McpScope } from "./mcp-tools.js";

/** Source de jetons supplémentaire (OAuth en mode protégé). */
export interface McpAccessVerifier {
  verify(token: string | undefined): McpTokenInfo | undefined;
  stillValid(id: string, scope: McpScope): boolean;
  readonly resourceMetadataUrl: string;
}

export const MCP_HTTP_PATH = "/mcp";
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 64;
const SESSION_IDLE_MS = 30 * 60_000;
const SWEEP_MS = 60_000;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  token: McpTokenInfo;
  lastSeen: number;
}

export interface McpHttpOptions {
  home: string;
  version: string;
  /** Appel interne d'une route `/api/*` (autorisation propriétaire du processus serveur). */
  dispatch: CogitatorCall;
  /** OAuth (mode protégé) : jetons `cgo_…` et découverte via WWW-Authenticate. */
  oauth?: McpAccessVerifier;
}

class McpHttpError extends Error {
  constructor(readonly status: number, readonly code: number, message: string) { super(message); }
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_MCP_BODY_BYTES) { reject(new McpHttpError(413, -32600, "Requête trop volumineuse")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new McpHttpError(400, -32700, "Parse error")); }
    });
    req.on("error", reject);
  });
}

export class McpHttpEndpoint {
  private readonly sessions = new Map<string, Session>();
  private readonly verifier: McpTokenVerifier;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly opts: McpHttpOptions) {
    this.verifier = new McpTokenVerifier(opts.home);
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  get sessionCount(): number { return this.sessions.size; }

  private verify(token: string | undefined): McpTokenInfo | undefined {
    return this.verifier.verify(token) ?? this.opts.oauth?.verify(token);
  }

  private stillValid(token: McpTokenInfo): boolean {
    return this.verifier.stillValid(token.id, token.scope) || (this.opts.oauth?.stillValid(token.id, token.scope) ?? false);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    try {
      const method = req.method ?? "GET";
      if (!["POST", "GET", "DELETE"].includes(method)) {
        return jsonRpcError(res, 405, -32000, "Method not allowed", { allow: "POST, GET, DELETE" });
      }
      const token = this.verify(bearerToken(req.headers.authorization));
      if (!token) {
        const metadata = this.opts.oauth ? `, resource_metadata="${this.opts.oauth.resourceMetadataUrl}"` : "";
        return jsonRpcError(res, 401, -32001, "Jeton MCP manquant ou invalide (Authorization: Bearer cgt_…)",
          { "www-authenticate": `Bearer realm="cogitator", error="invalid_token"${metadata}` });
      }
      const header = req.headers["mcp-session-id"];
      const sessionId = typeof header === "string" ? header : undefined;
      const body = method === "POST" ? await readJsonBody(req) : undefined;

      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return jsonRpcError(res, 404, -32001, "Session MCP inconnue ou expirée");
        if (session.token.id !== token.id) return jsonRpcError(res, 403, -32001, "Session ouverte par un autre jeton");
        session.lastSeen = Date.now();
        return await session.transport.handleRequest(req, res, body);
      }
      if (method !== "POST" || !isInitializeRequest(body)) {
        return jsonRpcError(res, 400, -32000, "Mcp-Session-Id requis (ou requête initialize)");
      }
      if (this.sessions.size >= MAX_SESSIONS) this.evictOldest();
      const transport = this.open(token);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (err instanceof McpHttpError) return jsonRpcError(res, err.status, err.code, err.message);
      jsonRpcError(res, 500, -32603, "Internal error");
    }
  }

  private open(token: McpTokenInfo): StreamableHTTPServerTransport {
    const server = new McpServer({ name: "cogitator", version: this.opts.version });
    const call: CogitatorCall = (method, path, body) => {
      if (!this.stillValid(token)) return Promise.reject(new Error("Jeton MCP révoqué"));
      return this.opts.dispatch(method, path, body);
    };
    registerCogitatorTools(server, { call, scope: token.scope, author: `MCP: ${token.name}` });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { this.sessions.set(id, { transport, server, token, lastSeen: Date.now() }); },
      onsessionclosed: (id) => { this.drop(id); },
    });
    transport.onclose = () => { if (transport.sessionId) this.sessions.delete(transport.sessionId); };
    void server.connect(transport);
    return transport;
  }

  private drop(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    void session.server.close().catch(() => undefined);
  }

  private evictOldest(): void {
    let oldest: [string, Session] | undefined;
    for (const entry of this.sessions) if (!oldest || entry[1].lastSeen < oldest[1].lastSeen) oldest = entry;
    if (oldest) this.drop(oldest[0]);
  }

  /** Ferme les sessions inactives et celles dont le jeton a été révoqué. */
  sweep(now = Date.now()): void {
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > SESSION_IDLE_MS || !this.stillValid(s.token)) this.drop(id);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) this.drop(id);
  }
}
