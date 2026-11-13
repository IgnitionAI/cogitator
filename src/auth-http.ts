import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { z } from "zod";
import { protectedRequired, type AuthState } from "./auth-state.js";
import { AuthError, authMutationAuthorization, ownerSession, policy, requireApproved, requireEnrollment, requiresMfa, selectEnrollment, sessionById, verifyEnrollment } from "./native-auth.js";

const password = z.string().min(1).max(128);
const schemas = {
  "/api/auth/sign-in/email": z.object({ email: z.email().max(254), password }).strict(),
  "/api/auth/sign-out": z.object({}).strict(),
  "/api/auth/two-factor/enable": z.object({ password, setupKey: z.string().max(128).optional() }).strict(),
  "/api/auth/two-factor/verify-totp": z.object({ code: z.string().regex(/^\d{6}$/) }).strict(),
  "/api/auth/two-factor/verify-backup-code": z.object({ code: z.string().min(1).max(128) }).strict(),
  "/api/auth/two-factor/generate-backup-codes": z.object({ password }).strict(),
};
export function authJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
export function authFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const failure = error instanceof AuthError ? error : new AuthError("AUTH_UNAVAILABLE", 503);
  authJson(res, failure.status, { error: failure.code, ...(failure.retryAt ? { retryAt: failure.retryAt } : {}) });
}
function canonicalIp(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4) return trimmed.slice(7);
  return trimmed;
}
function configuredClientHeader(name: string | undefined): string | undefined {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) return undefined;
  const header = name.toLowerCase();
  if (header === "cookie" || header === "authorization" || header === "host" || header === "origin" || header === "content-type") return undefined;
  return header;
}
/**
 * Socket peer, or a single IP from a configured header only when that peer is the trusted proxy.
 * Forwarding headers are never copied into the request bucket; this read is explicit and opt-in.
 */
export function authClientAddress(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string {
  const peer = canonicalIp(req.socket.remoteAddress ?? "unknown");
  const trusted = env.COGITATOR_AUTH_TRUSTED_PROXY;
  const header = configuredClientHeader(env.COGITATOR_AUTH_CLIENT_HEADER);
  if (!trusted || !header || isIP(canonicalIp(trusted)) === 0 || canonicalIp(trusted) !== peer) return peer;
  const forwarded = req.headers[header];
  if (typeof forwarded !== "string") return peer;
  const client = canonicalIp(forwarded);
  return isIP(client) === 0 ? peer : client;
}
export function browserHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of ["cookie", "origin", "content-type", "user-agent"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  // Never copy forwarding headers. Client identity is applied only to the dedicated peer field.
  headers.set("x-cogitator-peer", authClientAddress(req));
  const cookie = headers.get("cookie");
  if (cookie) headers.set("cookie", cookie.split(";").filter(c => !c.split("=")[0]?.includes("trust_device")).join(";"));
  return headers;
}
export function validateBoundary(req: IncomingMessage, state: AuthState): void {
  const raw = req.url ?? "";
  const pathname = raw.split("?")[0] ?? "";
  if (!raw.startsWith("/") || pathname.includes("%") || pathname.includes("#") || pathname.includes("\\") || pathname.includes("//") || /\/(?:\.|\.\.)(?:\/|$)/.test(pathname) || (pathname.length > 1 && pathname.endsWith("/"))) throw new AuthError("INVALID_INPUT", 400);
  const localLiveness = req.method === "GET" && raw === "/api/status" && req.headers.host === `127.0.0.1:${req.socket.localPort}`;
  if (req.headers.host !== new URL(state.config.origin).host && !localLiveness) throw new AuthError("FORBIDDEN", 403);
  const origin = req.headers.origin;
  // A browser may enter the public login shell from a bookmark or an external link.
  // Only a top-level GET of the exact shell is exempt; API reads and every mutation
  // retain the cross-site boundary, and an explicit foreign Origin is always rejected.
  const publicNavigation = req.method === "GET" && (raw === "/" || raw === "/index.html")
    && !origin && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
  if ((origin && origin !== state.config.origin) || (req.headers["sec-fetch-site"] === "cross-site" && !publicNavigation)) throw new AuthError("FORBIDDEN", 403);
  if (!["GET", "HEAD"].includes(req.method ?? "") && origin !== state.config.origin) throw new AuthError("FORBIDDEN", 403);
  if (!["GET", "HEAD"].includes(req.method ?? "") && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers["content-type"] ?? ""))) throw new AuthError("INVALID_INPUT", 400);
}
async function authBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 8192) throw new AuthError("INVALID_INPUT", 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AuthError("INVALID_INPUT", 400); }
}
function libraryError(status: number, data: Record<string, unknown>, path: string): string {
  if (data.code === "CODE_ALREADY_USED") return "CODE_ALREADY_USED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "AUTH_UNAVAILABLE";
  if (status === 409) return "CONFLICT";
  if (path.endsWith("sign-in/email") || data.code === "INVALID_PASSWORD") return "INVALID_CREDENTIALS";
  if (data.code === "INVALID_TWO_FACTOR_COOKIE") return "REAUTH_REQUIRED";
  if (path.includes("verify-")) return "INVALID_CODE";
  if (status === 401) return "AUTH_REQUIRED";
  return "INVALID_INPUT";
}


const factorMutations = new WeakSet<AuthState>();
/**
 * Per-client quotas stay as strict as the previous shared path bucket (10/60s sign-in, 3/10s MFA).
 * A higher global ceiling still bounds aggregate guesses. Untrusted forwarding headers cannot
 * split either counter; without a configured trusted proxy the socket peer remains the client id,
 * which is the previous shared-loopback behaviour.
 */
function throttle(state: AuthState, path: string, req: IncomingMessage): void {
  const now = Date.now();
  const window = path.includes("two-factor") ? 10_000 : 60_000;
  const clientMax = path.includes("two-factor") ? 3 : path.endsWith("sign-in/email") ? 10 : 60;
  const globalMax = clientMax * 10;
  const client = authClientAddress(req);
  const bump = (key: string) => state.db.prepare(`INSERT INTO authThrottle(path,count,until) VALUES (?,1,?)
    ON CONFLICT(path) DO UPDATE SET count=CASE WHEN until<=? THEN 1 ELSE count+1 END,
    until=CASE WHEN until<=? THEN excluded.until ELSE until END RETURNING count,until`).get(key, now+window, now, now) as { count: number; until: number };
  const rows = state.db.transaction(() => ({ client: bump(`c\0${path}\0${client}`), global: bump(`g\0${path}`) }))();
  if (rows.client.count > clientMax || rows.global.count > globalMax) {
    const until = Math.max(rows.client.count > clientMax ? rows.client.until : 0, rows.global.count > globalMax ? rows.global.until : 0);
    throw new AuthError("RATE_LIMITED", 429, new Date(until).toISOString());
  }
}

/** Handles the exact public auth surface. No raw library JSON or headers escape. */
export async function authRoute(req: IncomingMessage, res: ServerResponse, state: AuthState): Promise<void> {
  const path = req.url ?? "";
  if (path === "/api/auth/status" && req.method === "GET") {
    state.assertAvailable();
    const session = await ownerSession(state.auth, state.db, state.config, browserHeaders(req));
    state.assertAvailable();
    if (!session) return authJson(res, 200, { mode: "protected", state: "anonymous", ...(!requiresMfa(state.config) ? { mfaRequired: false } : {}) });
    const fresh = sessionById(state.db, state.config, session.id);
    if (!fresh) throw new AuthError("AUTH_REQUIRED", 401);
    if (!requiresMfa(state.config)) return authJson(res, 200, { mode: "protected", state: "authenticated", mfaRequired: false,
      email: fresh.email, expiresAt: new Date(fresh.expiresAt).toISOString() });
    const p = policy(state.db);
    const liveClaim = p.claimId && p.claimExpires > Date.now() && sessionById(state.db, state.config, p.claimId);
    const selected = liveClaim && p.claimId === fresh.id;
    authJson(res, 200, { mode: "protected", state: fresh.enrolled ? (fresh.approved ? "authenticated" : "reauthenticate") : "enrollment",
      email: fresh.email, expiresAt: new Date(fresh.expiresAt).toISOString(), ...(!fresh.enrolled ? { enrollment: {
        requiresSetupKey: !selected, pending: Boolean(selected && state.db.prepare("SELECT 1 FROM twoFactor WHERE userId=?").get(state.config.ownerId)),
        ...(liveClaim && !selected ? { busyUntil: new Date(p.claimExpires).toISOString() } : {}),
      } } : {}) });
    return;
  }
  if (req.method !== "POST" || !Object.hasOwn(schemas, path)) throw new AuthError("NOT_FOUND", 404);
  if (!requiresMfa(state.config) && path.includes("/two-factor/")) throw new AuthError("NOT_FOUND", 404);
  const parsed = schemas[path as keyof typeof schemas].safeParse(await authBody(req));
  if (!parsed.success) throw new AuthError("INVALID_INPUT", 400);
  state.assertAvailable();
  throttle(state, path, req);
  const headers = browserHeaders(req);
  const session = await ownerSession(state.auth, state.db, state.config, headers);
  state.assertAvailable();
  const fresh = session ? sessionById(state.db, state.config, session.id) : null;
  const mutateFactor = Boolean(fresh && path.includes("/two-factor/"));
  if (mutateFactor && factorMutations.has(state)) throw new AuthError("ENROLLMENT_BUSY", 409, new Date(Date.now()+1000).toISOString());
  if (mutateFactor) factorMutations.add(state);
  try {
  const body: Record<string, unknown> = { ...parsed.data };
  if (path.endsWith("/enable")) {
    selectEnrollment(state.db, state.config, fresh, typeof body.setupKey === "string" ? body.setupKey : undefined);
    delete body.setupKey;
    body.method = "totp";
  } else if (path.endsWith("/verify-totp") && fresh) requireEnrollment(state.db, fresh);
  else if (path.endsWith("/verify-backup-code") && fresh) throw new AuthError("REAUTH_REQUIRED", 403);
  else if (path.endsWith("/generate-backup-codes")) requireApproved(fresh);

  const invoke = () => state.auth.handler(new Request(`${state.config.origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  const activation = fresh && path.endsWith("/verify-totp");
  const response = activation ? await verifyEnrollment(state.db, fresh.id, invoke) : fresh && (path.endsWith("/enable") || path.endsWith("/generate-backup-codes"))
    ? await authMutationAuthorization.run({ sessionId: fresh.id, mode: path.endsWith("/enable") ? "enrollment" : "approved" }, invoke)
    : await invoke();
  // 1.7.7 sign-out catches deletion errors and still clears cookies. Do not forward that false
  // success: retain the browser cookie for retry until its validated session is durably absent.
  if (path.endsWith("/sign-out") && session && (state.db.inTransaction || state.db.prepare("SELECT 1 FROM session WHERE id=?").get(session.id))) throw new AuthError("AUTH_UNAVAILABLE", 503);
  const raw: unknown = await response.json().catch(() => ({}));
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  // Set-Cookie is multi-valued, never split on commas (Expires contains a comma).
  const cookies = response.headers.getSetCookie();
  if (cookies.length && (!activation || response.ok)) res.setHeader("set-cookie", cookies);
  if (!response.ok) {
    const retry = Number(response.headers.get("retry-after"));
    return authJson(res, response.status, { error: libraryError(response.status, data, path), ...(retry > 0 ? { retryAfter: retry } : {}) });
  }
  state.assertAvailable();
  if (path.endsWith("/sign-out") && fresh) state.db.prepare("UPDATE authPolicy SET claimId=NULL, claimExpires=0 WHERE claimId=?").run(fresh.id);
  if (path.endsWith("/verify-totp")) {
    const enrolled = state.db.prepare("SELECT twoFactorEnabled FROM user WHERE id=?").get(state.config.ownerId) as { twoFactorEnabled: number };
    if (enrolled.twoFactorEnabled) state.db.prepare("UPDATE authPolicy SET setupDigest=NULL, setupExpires=0, claimId=NULL, claimExpires=0").run();
  }
  if (path.endsWith("/enable") || path.endsWith("/generate-backup-codes")) {
    if (path.endsWith("/enable")) requireEnrollment(state.db, fresh ? sessionById(state.db, state.config, fresh.id) : null);
    else requireApproved(fresh ? sessionById(state.db, state.config, fresh.id) : null);
    if (!Array.isArray(data.backupCodes) || !data.backupCodes.every(c => typeof c === "string")) throw new AuthError("AUTH_UNAVAILABLE", 503);
    if (path.endsWith("/enable") && typeof data.totpURI !== "string") throw new AuthError("AUTH_UNAVAILABLE", 503);
    return authJson(res, 200, { ...(path.endsWith("/enable") ? { totpURI: data.totpURI } : {}), backupCodes: data.backupCodes });
  }
  authJson(res, 200, path.endsWith("/sign-in/email") ? { twoFactorRequired: data.twoFactorRedirect === true } : { ok: true });
  } finally { if (mutateFactor) factorMutations.delete(state); }
}

export const responseChecks = new WeakMap<ServerResponse, () => void>();
export function checkResponse(res: ServerResponse): void { responseChecks.get(res)?.(); }
export function localCheck(home: string): void {
  if (protectedRequired(home)) throw new AuthError("AUTH_UNAVAILABLE", 503);
}
