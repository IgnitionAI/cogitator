/**
 * OAuth 2.1 pour le serveur MCP HTTP — permet aux connecteurs web (ChatGPT, Claude.ai…)
 * d'obtenir un accès à `/mcp` après consentement explicite du propriétaire.
 *
 * Disponible uniquement en mode protégé (origine HTTPS publique + login propriétaire).
 * Conforme au profil d'autorisation MCP :
 *  - métadonnées RFC 9728 (`/.well-known/oauth-protected-resource`) et RFC 8414
 *    (`/.well-known/oauth-authorization-server`) ;
 *  - enregistrement dynamique RFC 7591 (`/oauth/register`), plafonné ;
 *  - code d'autorisation + PKCE S256 obligatoire, redirect_uri exact, `resource` vérifié ;
 *  - jetons d'accès courts (1 h) et refresh tokens tournants (réutilisation → révocation du grant).
 *
 * Seuls des hash SHA-256 sont persistés (`<home>/mcp-oauth.json`, 0600). Codes et demandes
 * de consentement restent en mémoire (durée de vie de quelques minutes).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { AuthState } from "./auth-state.js";
import { browserHeaders } from "./auth-http.js";
import { atomicWriteJson, readJson } from "./json-files.js";
import { MCP_SCOPES, type McpScope } from "./mcp-tools.js";
import type { McpTokenInfo } from "./mcp-tokens.js";
import { AuthError, ownerSession, requireApproved } from "./native-auth.js";

export const OAUTH_ACCESS_PREFIX = "cgo_";
const OAUTH_REFRESH_PREFIX = "cgr_";
const FILE = "mcp-oauth.json";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const CODE_TTL_MS = 60_000;
const CONSENT_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 100;
const UNUSED_CLIENT_TTL_MS = 24 * 3600_000;
const MAX_REGISTRATIONS_PER_HOUR = 30;
const MAX_FORM_BYTES = 16 * 1024;
const MAX_PENDING = 200;

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  secret_hash?: string;
  created_at: string;
}

export interface OAuthGrant {
  id: string;
  client_id: string;
  scope: McpScope;
  access_hash: string;
  access_expires: number;
  refresh_hash: string;
  prev_refresh_hash?: string;
  refresh_expires: number;
  created_at: string;
}

interface OAuthFile { version: 1; clients: OAuthClient[]; grants: OAuthGrant[] }

interface PendingConsent {
  id: string; sessionId: string; client: OAuthClient; redirectUri: string; state?: string;
  challenge: string; scope: McpScope; expires: number;
}
interface IssuedCode { clientId: string; redirectUri: string; challenge: string; scope: McpScope; expires: number }

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const secret = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"); const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function mcpOAuthPath(home: string): string { return join(home, FILE); }

/** Stockage persistant (clients + grants), relu sur changement de mtime (révocation CLI). */
export class OAuthStore {
  private cache: { key: string; data: OAuthFile } | undefined;
  constructor(private readonly home: string) {}

  read(): OAuthFile {
    const path = mcpOAuthPath(this.home);
    if (!existsSync(path)) return { version: 1, clients: [], grants: [] };
    const s = statSync(path);
    const key = `${s.mtimeMs}:${s.size}:${s.ino}`;
    if (this.cache?.key !== key) {
      const raw = readJson<Partial<OAuthFile>>(path, {});
      this.cache = { key, data: {
        version: 1,
        clients: Array.isArray(raw.clients) ? raw.clients.filter((c) => c && typeof c.client_id === "string" && Array.isArray(c.redirect_uris)) : [],
        grants: Array.isArray(raw.grants) ? raw.grants.filter((g) => g && typeof g.id === "string" && MCP_SCOPES.includes(g.scope)) : [],
      } };
    }
    return structuredClone(this.cache.data);
  }

  write(data: OAuthFile): void {
    mkdirSync(this.home, { recursive: true });
    const path = mcpOAuthPath(this.home);
    atomicWriteJson(path, data, 0o600);
    chmodSync(path, 0o600);
    this.cache = undefined;
  }

  update<T>(fn: (data: OAuthFile) => T): T {
    const data = this.read();
    const result = fn(data);
    this.write(data);
    return result;
  }
}

export interface OAuthGrantInfo { id: string; client_id: string; client_name: string; scope: McpScope; created_at: string; refresh_expires: string }

export function listOAuthGrants(home: string): OAuthGrantInfo[] {
  const data = new OAuthStore(home).read();
  return data.grants.map((g) => ({
    id: g.id, client_id: g.client_id, scope: g.scope, created_at: g.created_at,
    client_name: data.clients.find((c) => c.client_id === g.client_id)?.client_name ?? "?",
    refresh_expires: new Date(g.refresh_expires).toISOString(),
  }));
}

/** Révoque un grant (par id) ou tous les grants d'un client (par client_id ou nom). */
export function revokeOAuthGrant(home: string, idOrClient: string): boolean {
  return new OAuthStore(home).update((data) => {
    const clientIds = new Set(data.clients.filter((c) => c.client_id === idOrClient || c.client_name === idOrClient).map((c) => c.client_id));
    const before = data.grants.length;
    data.grants = data.grants.filter((g) => g.id !== idOrClient && !clientIds.has(g.client_id));
    return data.grants.length !== before;
  });
}

class OAuthError extends Error {
  constructor(readonly status: number, readonly error: string, readonly description: string) { super(description); }
}

function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  // Clients natifs / outils locaux (RFC 8252) : boucle locale uniquement.
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > MAX_FORM_BYTES) throw new OAuthError(413, "invalid_request", "Request too large");
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const type = String(req.headers["content-type"] ?? "");
  if (/^application\/json/i.test(type)) {
    let parsed: unknown;
    try { parsed = JSON.parse(text || "{}"); } catch { throw new OAuthError(400, "invalid_request", "Invalid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OAuthError(400, "invalid_request", "Invalid body");
    return parsed as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...extra });
  res.end(JSON.stringify(body));
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };

export class McpOAuth {
  readonly store: OAuthStore;
  private readonly pending = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, IssuedCode>();
  private registrations: number[] = [];

  constructor(home: string, private readonly state: AuthState) {
    this.store = new OAuthStore(home);
  }

  get origin(): string { return this.state.config.origin; }
  get resource(): string { return `${this.origin}/mcp`; }
  get resourceMetadataUrl(): string { return `${this.origin}/.well-known/oauth-protected-resource`; }

  /** Chemins publics gérés ici (avant la frontière navigateur). */
  static handles(pathname: string): boolean {
    return pathname.startsWith("/.well-known/oauth-") || pathname === "/oauth/register" || pathname === "/oauth/authorize" || pathname === "/oauth/token";
  }

  // ---------- Vérification des jetons d'accès (utilisée par /mcp) ----------

  verify(token: string | undefined): McpTokenInfo | undefined {
    if (!token || !token.startsWith(OAUTH_ACCESS_PREFIX) || token.length > 128) return undefined;
    const hash = sha(token);
    const data = this.store.read();
    const grant = data.grants.find((g) => sameHash(g.access_hash, hash));
    if (!grant || grant.access_expires <= Date.now()) return undefined;
    const client = data.clients.find((c) => c.client_id === grant.client_id);
    return { id: `oauth:${grant.id}`, name: client?.client_name ?? "OAuth client", scope: grant.scope, created_at: grant.created_at };
  }

  stillValid(id: string, scope: McpScope): boolean {
    if (!id.startsWith("oauth:")) return false;
    const grantId = id.slice("oauth:".length);
    return this.store.read().grants.some((g) => g.id === grantId && g.scope === scope && g.refresh_expires > Date.now());
  }

  // ---------- Routage ----------

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    try {
      if (req.method === "OPTIONS" && path !== "/oauth/authorize") { res.writeHead(204, { ...CORS, "access-control-max-age": "600" }); res.end(); return; }
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        if (req.method !== "GET") throw new OAuthError(405, "invalid_request", "Method not allowed");
        return sendJson(res, 200, {
          resource: this.resource,
          authorization_servers: [this.origin],
          scopes_supported: [...MCP_SCOPES],
          bearer_methods_supported: ["header"],
          resource_name: "Cogitator",
        }, CORS);
      }
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp" || path === "/.well-known/openid-configuration") {
        if (req.method !== "GET") throw new OAuthError(405, "invalid_request", "Method not allowed");
        return sendJson(res, 200, {
          issuer: this.origin,
          authorization_endpoint: `${this.origin}/oauth/authorize`,
          token_endpoint: `${this.origin}/oauth/token`,
          registration_endpoint: `${this.origin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
          scopes_supported: [...MCP_SCOPES],
          authorization_response_iss_parameter_supported: true,
        }, CORS);
      }
      if (path === "/oauth/register") {
        if (req.method !== "POST") throw new OAuthError(405, "invalid_request", "Method not allowed");
        return sendJson(res, 201, this.register(await readForm(req)), CORS);
      }
      if (path === "/oauth/token") {
        if (req.method !== "POST") throw new OAuthError(405, "invalid_request", "Method not allowed");
        return sendJson(res, 200, this.token(await readForm(req), req.headers.authorization), CORS);
      }
      if (path === "/oauth/authorize") {
        if (req.method === "GET") return await this.authorizePage(req, res, url);
        if (req.method === "POST") return await this.authorizeDecision(req, res);
        throw new OAuthError(405, "invalid_request", "Method not allowed");
      }
      throw new OAuthError(404, "invalid_request", "Not found");
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof OAuthError) {
        if (path === "/oauth/authorize") return this.htmlError(res, err.status, err.description);
        return sendJson(res, err.status, { error: err.error, error_description: err.description }, CORS);
      }
      if (err instanceof AuthError) throw err;
      sendJson(res, 500, { error: "server_error" }, CORS);
    }
  }

  // ---------- Enregistrement dynamique (RFC 7591) ----------

  private register(body: Record<string, unknown>): Record<string, unknown> {
    const now = Date.now();
    this.registrations = this.registrations.filter((t) => now - t < 3600_000);
    if (this.registrations.length >= MAX_REGISTRATIONS_PER_HOUR) throw new OAuthError(429, "invalid_request", "Too many registrations, retry later");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
      throw new OAuthError(400, "invalid_redirect_uri", "redirect_uris must be 1-10 https (or loopback http) URLs");
    }
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
      throw new OAuthError(400, "invalid_client_metadata", "Unsupported token_endpoint_auth_method");
    }
    const grantTypes = body.grant_types;
    if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code"))) {
      throw new OAuthError(400, "invalid_client_metadata", "grant_types must include authorization_code");
    }
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "MCP client";
    const clientSecret = method === "none" ? undefined : secret("cgs_");
    const client: OAuthClient = {
      client_id: randomUUID(), client_name: name, redirect_uris: uris as string[], token_endpoint_auth_method: method,
      ...(clientSecret ? { secret_hash: sha(clientSecret) } : {}), created_at: new Date().toISOString(),
    };
    this.store.update((data) => {
      // Purge : clients jamais autorisés après 24 h, puis plafond global.
      const used = new Set(data.grants.map((g) => g.client_id));
      data.clients = data.clients.filter((c) => used.has(c.client_id) || now - Date.parse(c.created_at) < UNUSED_CLIENT_TTL_MS);
      if (data.clients.length >= MAX_CLIENTS) throw new OAuthError(429, "invalid_request", "Client registry full; revoke unused clients");
      data.clients.push(client);
    });
    this.registrations.push(now);
    return {
      client_id: client.client_id, client_name: client.client_name, redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      client_id_issued_at: Math.floor(now / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    };
  }

  // ---------- Autorisation : page de consentement du propriétaire ----------

  private async session(req: IncomingMessage) {
    const session = await ownerSession(this.state.auth, this.state.db, this.state.config, browserHeaders(req));
    try { requireApproved(session, this.state.config); return session; }
    catch { return null; }
  }

  private async authorizePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const q = url.searchParams;
    const client = this.store.read().clients.find((c) => c.client_id === q.get("client_id"));
    if (!client) throw new OAuthError(400, "invalid_client", "Unknown client_id. The application must register again.");
    const redirectUri = q.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : "");
    if (!client.redirect_uris.includes(redirectUri)) throw new OAuthError(400, "invalid_request", "redirect_uri does not match the registered client.");
    // À partir d'ici, les erreurs reviennent au client par redirection (RFC 6749 §4.1.2.1).
    const state = q.get("state") ?? undefined;
    const fail = (error: string, description: string) => this.redirect(res, redirectUri, { error, error_description: description, state });
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail("invalid_request", "PKCE S256 required");
    const resource = q.get("resource");
    if (resource && resource !== this.resource && resource !== this.origin) return fail("invalid_target", "Unknown resource");
    const requested = (q.get("scope") ?? "").split(/\s+/).filter(Boolean);
    if (requested.some((s) => !MCP_SCOPES.includes(s as McpScope))) return fail("invalid_scope", "Supported scopes: read, full");
    // Pré-sélection prudente : lecture seule sauf demande explicite ; le propriétaire décide.
    const scope: McpScope = requested.includes("full") ? "full" : "read";

    const session = await this.session(req);
    if (!session) return this.loginPage(res, url);
    this.sweepPending();
    const pending: PendingConsent = { id: randomBytes(24).toString("base64url"), sessionId: session.id, client, redirectUri, state, challenge, scope, expires: Date.now() + CONSENT_TTL_MS };
    this.pending.set(pending.id, pending);
    this.consentPage(res, pending);
  }

  private async authorizeDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Formulaire de même origine uniquement (anti-CSRF, en plus de l'identifiant lié à la session).
    if (req.headers.origin !== this.origin) throw new OAuthError(403, "access_denied", "Cross-origin form refused.");
    const form = await readForm(req);
    const pending = this.pending.get(String(form.request_id ?? ""));
    if (!pending || pending.expires <= Date.now()) throw new OAuthError(400, "invalid_request", "This authorization request expired. Restart the connection from the application.");
    const session = await this.session(req);
    if (!session || session.id !== pending.sessionId) throw new OAuthError(403, "access_denied", "Owner session changed. Restart the connection from the application.");
    this.pending.delete(pending.id);
    if (form.decision !== "approve") return this.redirect(res, pending.redirectUri, { error: "access_denied", state: pending.state });
    const scope: McpScope = form.scope === "read" ? "read" : form.scope === "full" ? "full" : pending.scope;
    const code = randomBytes(32).toString("base64url");
    this.codes.set(sha(code), { clientId: pending.client.client_id, redirectUri: pending.redirectUri, challenge: pending.challenge, scope, expires: Date.now() + CODE_TTL_MS });
    this.redirect(res, pending.redirectUri, { code, state: pending.state });
  }

  private redirect(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>): void {
    const target = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) target.searchParams.set(k, v);
    target.searchParams.set("iss", this.origin);
    res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
    res.end();
  }

  private sweepPending(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expires <= now) this.pending.delete(id);
    for (const [h, c] of this.codes) if (c.expires <= now) this.codes.delete(h);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }

  // ---------- Jeton (code → accès, refresh tournant) ----------

  private authenticateClient(form: Record<string, string>, authorization: string | undefined): OAuthClient {
    let clientId = form.client_id;
    let clientSecret = form.client_secret;
    const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? "");
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i > 0) { clientId = decodeURIComponent(decoded.slice(0, i)); clientSecret = decodeURIComponent(decoded.slice(i + 1)); }
    }
    const client = this.store.read().clients.find((c) => c.client_id === clientId);
    if (!client) throw new OAuthError(401, "invalid_client", "Unknown client");
    if (client.token_endpoint_auth_method !== "none") {
      if (!clientSecret || !client.secret_hash || !sameHash(sha(clientSecret), client.secret_hash)) throw new OAuthError(401, "invalid_client", "Invalid client credentials");
    }
    return client;
  }

  private token(form: Record<string, string>, authorization: string | undefined): Record<string, unknown> {
    const client = this.authenticateClient(form, authorization);
    if (form.resource && form.resource !== this.resource && form.resource !== this.origin) throw new OAuthError(400, "invalid_target", "Unknown resource");
    if (form.grant_type === "authorization_code") {
      const key = sha(String(form.code ?? ""));
      const code = this.codes.get(key);
      this.codes.delete(key); // usage unique, même en cas d'échec
      if (!code || code.expires <= Date.now() || code.clientId !== client.client_id) throw new OAuthError(400, "invalid_grant", "Invalid or expired code");
      if (form.redirect_uri !== undefined && form.redirect_uri !== code.redirectUri) throw new OAuthError(400, "invalid_grant", "redirect_uri mismatch");
      const verifier = String(form.code_verifier ?? "");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError(400, "invalid_grant", "Invalid code_verifier");
      const computed = createHash("sha256").update(verifier).digest("base64url");
      if (computed.length !== code.challenge.length || !timingSafeEqual(Buffer.from(computed), Buffer.from(code.challenge))) throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
      const access = secret(OAUTH_ACCESS_PREFIX);
      const refresh = secret(OAUTH_REFRESH_PREFIX);
      const now = Date.now();
      this.store.update((data) => {
        data.grants.push({ id: randomUUID().slice(0, 8), client_id: client.client_id, scope: code.scope, access_hash: sha(access), access_expires: now + ACCESS_TTL_S * 1000,
          refresh_hash: sha(refresh), refresh_expires: now + REFRESH_TTL_MS, created_at: new Date(now).toISOString() });
      });
      return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: code.scope };
    }
    if (form.grant_type === "refresh_token") {
      const presented = sha(String(form.refresh_token ?? ""));
      const access = secret(OAUTH_ACCESS_PREFIX);
      const refresh = secret(OAUTH_REFRESH_PREFIX);
      const now = Date.now();
      const scope = this.store.update((data) => {
        const replayed = data.grants.find((g) => g.client_id === client.client_id && g.prev_refresh_hash && sameHash(g.prev_refresh_hash, presented));
        if (replayed) {
          // Refresh token déjà tourné présenté à nouveau : fuite probable, le grant est révoqué.
          data.grants = data.grants.filter((g) => g.id !== replayed.id);
          return undefined;
        }
        const grant = data.grants.find((g) => g.client_id === client.client_id && sameHash(g.refresh_hash, presented));
        if (!grant || grant.refresh_expires <= now) return null;
        grant.prev_refresh_hash = grant.refresh_hash;
        grant.refresh_hash = sha(refresh);
        grant.refresh_expires = now + REFRESH_TTL_MS;
        grant.access_hash = sha(access);
        grant.access_expires = now + ACCESS_TTL_S * 1000;
        return grant.scope;
      });
      if (!scope) throw new OAuthError(400, "invalid_grant", "Invalid refresh token");
      return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
    }
    throw new OAuthError(400, "unsupported_grant_type", "Supported: authorization_code, refresh_token");
  }

  // ---------- Pages HTML (sans JavaScript) ----------

  private page(res: ServerResponse, status: number, body: string, formTarget?: string): void {
    const formAction = formTarget ? ` ${new URL(formTarget).origin}` : "";
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cogitator · Authorize</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f9;--card:#fff;--fg:#16161d;--muted:#6b6b78;--accent:#5e6ad2;--line:#e3e3ea}
@media (prefers-color-scheme:dark){:root{--bg:#111116;--card:#1b1b22;--fg:#ececf1;--muted:#9a9aa8;--line:#2c2c36}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:440px;width:100%}
h1{font-size:18px;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:13px}code{font-size:13px;overflow-wrap:anywhere}
label{display:flex;gap:8px;align-items:flex-start;margin:8px 0;padding:10px;border:1px solid var(--line);border-radius:8px;cursor:pointer}
.row{display:flex;gap:8px;margin-top:16px}button,a.btn{flex:1;padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;cursor:pointer;text-align:center;text-decoration:none}
button.primary,a.primary{background:var(--accent);border-color:var(--accent);color:#fff}</style></head><body><main>${body}</main></body></html>`);
  }

  private consentPage(res: ServerResponse, p: PendingConsent): void {
    const host = new URL(p.redirectUri).host;
    const checked = (s: McpScope) => (p.scope === s ? " checked" : "");
    this.page(res, 200, `<h1>Allow “${escapeHtml(p.client.client_name)}” to access Cogitator?</h1>
<p class="muted">The application will be redirected to <code>${escapeHtml(host)}</code>. Only approve if you started this connection yourself.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(p.id)}">
<label><input type="radio" name="scope" value="read"${checked("read")}><span><b>Read only</b><br><span class="muted">List agents, workspaces, conversations, schedules and the board.</span></span></label>
<label><input type="radio" name="scope" value="full"${checked("full")}><span><b>Full control</b><br><span class="muted">Also create and delete resources, send messages to agents and start work. Agents can run commands on this server.</span></span></label>
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve">Allow</button></div>
</form><p class="muted">You can revoke access later with <code>cogitator mcp token revoke</code>.</p>`, p.redirectUri);
  }

  private loginPage(res: ServerResponse, url: URL): void {
    const back = `${url.pathname}${url.search}`;
    this.page(res, 200, `<h1>Sign in to Cogitator</h1>
<p>An application asks to connect to your Cogitator. Sign in as the owner in this browser, then continue.</p>
<div class="row"><a class="btn" href="/" target="_blank" rel="noopener">Open Cogitator to sign in</a><a class="btn primary" href="${escapeHtml(back)}">Continue</a></div>`);
  }

  private htmlError(res: ServerResponse, status: number, message: string): void {
    this.page(res, status, `<h1>Authorization failed</h1><p>${escapeHtml(message)}</p>`);
  }
}
