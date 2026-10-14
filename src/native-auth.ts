import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { expireCookie } from "better-auth/cookies";
import { getMigrations } from "better-auth/db/migration";
import { twoFactor } from "better-auth/plugins";

export const ENROLLMENT_MS = 10 * 60_000;
export const REPLAY_MS = 5 * 60_000;
// Carries validated/original and SQL-observed replacement IDs, never credentials or an approval cache.
export const authMutationAuthorization = new AsyncLocalStorage<{ sessionId: string; mode: "approved" | "enrollment" | "activation"; rotatedId?: string }>();
function installFactorMutationGuard(db: Database.Database): void {
  db.function("cogitator_factor_session", () => authMutationAuthorization.getStore()?.sessionId ?? null);
  db.function("cogitator_factor_mode", () => authMutationAuthorization.getStore()?.mode ?? null);
  db.function("cogitator_rotated_session", () => authMutationAuthorization.getStore()?.rotatedId ?? null);
  db.function("cogitator_record_rotation", (id) => {
    const scope = authMutationAuthorization.getStore();
    if (scope && typeof id === "string") scope.rotatedId = id;
    return null;
  });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='twoFactor'").get()) return;
  // The supported library adapter has asynchronous work after its before-hooks. TEMP SQLite
  // constraints re-check authoritative rows within the actual write, after all that async work.
  const check = `SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM session s JOIN user u ON u.id=s.userId JOIN authPolicy p ON p.singleton=1
    WHERE s.id=cogitator_factor_session() AND s.userId=p.ownerId AND NEW.userId=s.userId
      AND julianday(s.expiresAt)>julianday('now') AND (
        (cogitator_factor_mode()='approved' AND s.mfaApproved=1 AND u.twoFactorEnabled=1
          AND EXISTS(SELECT 1 FROM twoFactor f WHERE f.userId=u.id AND f.verified=1))
        OR (cogitator_factor_mode()='enrollment' AND u.twoFactorEnabled=0
          AND p.claimId=s.id AND p.claimExpires>unixepoch('subsec')*1000)
      )
    ) THEN RAISE(ABORT, 'COGITATOR_AUTHORITY_EXPIRED') END;`;
  db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS cogitator_factor_insert BEFORE INSERT ON main.twoFactor
      WHEN cogitator_factor_session() IS NOT NULL BEGIN ${check} END;
    CREATE TEMP TRIGGER IF NOT EXISTS cogitator_factor_codes BEFORE UPDATE OF backupCodes ON main.twoFactor
      WHEN cogitator_factor_session() IS NOT NULL BEGIN ${check} END;`);
  const authority = `SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM session s JOIN authPolicy p ON p.singleton=1 AND p.ownerId=s.userId
    WHERE s.id=cogitator_factor_session() AND s.mfaApproved=0
      AND julianday(s.expiresAt)>julianday('now')
      AND p.claimId=s.id AND p.claimExpires>unixepoch('subsec')*1000
    ) THEN RAISE(ABORT, 'COGITATOR_AUTHORITY_EXPIRED') END;`;
  // 1.7.7 rotates between user activation and factor verification. Keep the old row
  // authoritative through those awaits: defer ONLY this request's deletion, then retire
  // it in the final verified statement. Other requests' logout deletions are not deferred.
  db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS cogitator_activate BEFORE UPDATE OF twoFactorEnabled ON main.user
    WHEN cogitator_factor_mode()='activation' BEGIN
      ${authority}
      SELECT CASE WHEN OLD.twoFactorEnabled<>0 OR NEW.twoFactorEnabled<>1
        OR NEW.id<>(SELECT ownerId FROM authPolicy WHERE singleton=1)
        THEN RAISE(ABORT, 'COGITATOR_AUTHORITY_EXPIRED') END;
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS cogitator_rotate BEFORE INSERT ON main.session
    WHEN cogitator_factor_mode()='activation' BEGIN
      ${authority}
      SELECT CASE WHEN NEW.mfaApproved<>0 OR NEW.userId<>(SELECT ownerId FROM authPolicy WHERE singleton=1)
        OR cogitator_rotated_session() IS NOT NULL
        THEN RAISE(ABORT, 'COGITATOR_AUTHORITY_EXPIRED') END;
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS cogitator_rotation AFTER INSERT ON main.session
    WHEN cogitator_factor_mode()='activation' BEGIN SELECT cogitator_record_rotation(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS cogitator_defer_retirement BEFORE DELETE ON main.session
    WHEN cogitator_factor_mode()='activation' AND OLD.id=cogitator_factor_session()
      AND EXISTS(SELECT 1 FROM twoFactor WHERE userId=OLD.userId AND verified=0)
    BEGIN ${authority} SELECT RAISE(IGNORE); END;
    CREATE TEMP TRIGGER IF NOT EXISTS cogitator_verify BEFORE UPDATE OF verified ON main.twoFactor
    WHEN cogitator_factor_mode()='activation' BEGIN
      ${authority}
      SELECT CASE WHEN NEW.verified<>1 OR OLD.verified<>0 OR NOT EXISTS (
        SELECT 1 FROM session s JOIN user u ON u.id=s.userId
        WHERE s.id=cogitator_rotated_session() AND s.id<>cogitator_factor_session()
          AND s.userId=NEW.userId AND s.mfaApproved=0 AND u.twoFactorEnabled=1
          AND julianday(s.expiresAt)>julianday('now')
      ) THEN RAISE(ABORT, 'COGITATOR_AUTHORITY_EXPIRED') END;
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS cogitator_retire AFTER UPDATE OF verified ON main.twoFactor
    WHEN cogitator_factor_mode()='activation' BEGIN
      DELETE FROM session WHERE id=cogitator_factor_session();
      SELECT CASE WHEN EXISTS(SELECT 1 FROM session WHERE id=cogitator_factor_session())
        THEN RAISE(ABORT, 'COGITATOR_AUTHORITY_EXPIRED') END;
    END;`);
}

/** No transaction spans library awaits. Failed partial activation remains offline-recovery-only. */
export async function verifyEnrollment(db: Database.Database, sessionId: string, invoke: () => Promise<Response>): Promise<Response> {
  const scope: NonNullable<ReturnType<typeof authMutationAuthorization.getStore>> = { sessionId, mode: "activation" };
  let complete = false;
  try {
    const response = await authMutationAuthorization.run(scope, invoke);
    if (!response.ok) return response;
    const rotated = db.prepare(`SELECT 1 FROM session s JOIN twoFactor f ON f.userId=s.userId
      JOIN authPolicy p ON p.ownerId=s.userId WHERE s.id=? AND s.mfaApproved=0 AND f.verified=1
      AND julianday(s.expiresAt)>julianday('now') AND p.claimId=? AND p.claimExpires>?`).get(scope.rotatedId ?? "", sessionId, Date.now());
    if (db.inTransaction || !rotated || db.prepare("SELECT 1 FROM session WHERE id=?").get(sessionId)) throw new AuthError("AUTH_UNAVAILABLE", 503);
    complete = true;
    return response;
  } finally {
    if (!complete && scope.rotatedId) {
      db.prepare("DELETE FROM session WHERE id=?").run(scope.rotatedId);
      if (db.inTransaction || db.prepare("SELECT 1 FROM session WHERE id=?").get(scope.rotatedId)) throw new AuthError("AUTH_UNAVAILABLE", 503);
    }
  }
}
export class AuthError extends Error {
  constructor(public readonly code: string, public readonly status = 403, public readonly retryAt?: string) { super(code); }
}
export interface AuthConfig { origin: string; secret: string; replayKey: string; ownerId: string }
export interface OwnerSession { id: string; email: string; expiresAt: number; approved: boolean; enrolled: boolean }
interface Policy { ownerId: string; setupDigest: string | null; setupExpires: number; claimId: string | null; claimExpires: number }

export function createNativeAuth(db: Database.Database, config: AuthConfig, offline = false, captureReset?: (token: string) => void) {
  installFactorMutationGuard(db);
  const options = {
    appName: "Cogitator", baseURL: config.origin, basePath: "/api/auth", secret: config.secret,
    database: db, trustedOrigins: [config.origin],
    hooks: { before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-out") return;
      const cookie = ctx.context.createAuthCookie("two_factor");
      const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
      if (identifier) {
        // Use the library's signed-cookie and atomic single-use capability primitives.
        try {
          await ctx.context.internalAdapter.consumeVerificationValue(identifier);
          await ctx.context.internalAdapter.consumeVerificationValue(`2fa-attempts-${identifier}`);
          if (db.inTransaction || await ctx.context.internalAdapter.findVerificationValue(identifier)) throw new Error("Challenge revocation incomplete");
        } catch { throw new APIError("SERVICE_UNAVAILABLE", { code: "AUTH_UNAVAILABLE", message: "AUTH_UNAVAILABLE" }); }
      }
      expireCookie(ctx, cookie);
    }) },
    logger: { disabled: true }, telemetry: { enabled: false },
    onAPIError: { onError: (error) => {
      if (error instanceof Error && error.message === "COGITATOR_AUTHORITY_EXPIRED") throw new APIError("UNAUTHORIZED", { code: "AUTH_REQUIRED", message: "AUTH_REQUIRED" });
      if (!isAPIError(error)) throw new APIError("INTERNAL_SERVER_ERROR", { code: "AUTH_UNAVAILABLE", message: "AUTH_UNAVAILABLE" }); } },
    emailAndPassword: {
      enabled: true, disableSignUp: !offline, minPasswordLength: 12, maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      ...(captureReset ? { sendResetPassword: async ({ token }: { token: string }) => { captureReset(token); } } : {}),
    },
    advanced: { useSecureCookies: true, trustedProxyHeaders: false, ipAddress: { ipAddressHeaders: ["x-cogitator-peer"] } },
    session: {
      expiresIn: 24 * 60 * 60, disableSessionRefresh: true, cookieCache: { enabled: false },
      additionalFields: { mfaApproved: { type: "boolean", required: true, defaultValue: false, input: false, returned: false } },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60,
      customRules: { "/sign-in/email": { window: 60, max: 10 }, "/two-factor/*": { window: 10, max: 3 } } },
    plugins: [twoFactor({ issuer: "Cogitator", allowPasswordless: false, skipVerificationOnEnable: false })],
    databaseHooks: { session: { create: { before: async (session, ctx) => {
      const eligible = session.userId === config.ownerId && !ctx?.context.session &&
        (ctx?.path === "/two-factor/verify-totp" || ctx?.path === "/two-factor/verify-backup-code");
      if (eligible) {
        const factor = db.prepare('SELECT verified FROM twoFactor WHERE userId = ?').get(config.ownerId) as { verified: number } | undefined;
        if (factor?.verified !== 1) throw new APIError("FORBIDDEN", { code: "MFA_REQUIRED", message: "MFA_REQUIRED" });
        if (ctx?.path === "/two-factor/verify-totp") {
          if (typeof ctx.body?.code !== "string" || db.inTransaction) throw new APIError("SERVICE_UNAVAILABLE", { code: "AUTH_UNAVAILABLE", message: "AUTH_UNAVAILABLE" });
          const digest = createHmac("sha256", config.replayKey).update(JSON.stringify([config.ownerId, ctx.body.code])).digest("hex");
          const now = Date.now();
          const claimed = db.prepare(`INSERT INTO authReplay(digest, expires) VALUES (?, ?)
            ON CONFLICT(digest) DO UPDATE SET expires=excluded.expires WHERE authReplay.expires <= ?`).run(digest, now + REPLAY_MS, now);
          if (!claimed.changes) throw new APIError("CONFLICT", { code: "CODE_ALREADY_USED", message: "CODE_ALREADY_USED" });
          db.prepare("DELETE FROM authReplay WHERE expires < ?").run(now);
        }
      }
      return { data: { ...session, mfaApproved: eligible,
        ...(!eligible ? { expiresAt: new Date(Math.min(new Date(session.expiresAt).getTime(), Date.now() + ENROLLMENT_MS)) } : {}) } };
    } } } },
  } satisfies BetterAuthOptions;
  const auth = betterAuth(options);
  return { auth, options };
}
export type NativeLibrary = ReturnType<typeof createNativeAuth>["auth"];

export async function migrateAuth(db: Database.Database, options: BetterAuthOptions): Promise<void> {
  const plan = await getMigrations(options);
  if (plan.schemaProblems.length || plan.unsafeChanges.length) throw new AuthError("AUTH_UNAVAILABLE", 503);
  await plan.runMigrations();
  db.exec(`CREATE TABLE IF NOT EXISTS authPolicy (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), ownerId TEXT NOT NULL,
    setupDigest TEXT, setupExpires INTEGER NOT NULL DEFAULT 0, claimId TEXT, claimExpires INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS authReplay(digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS authThrottle(path TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS authOneFactor ON twoFactor(userId);
    CREATE TRIGGER IF NOT EXISTS authOneOwner BEFORE INSERT ON user
      WHEN EXISTS(SELECT 1 FROM user) BEGIN SELECT RAISE(ABORT, 'single owner'); END;
    CREATE TRIGGER IF NOT EXISTS authOwnerImmutable BEFORE UPDATE OF id ON user
      BEGIN SELECT RAISE(ABORT, 'immutable owner'); END;`);
  installFactorMutationGuard(db);
}

export function policy(db: Database.Database): Policy {
  const row = db.prepare("SELECT * FROM authPolicy WHERE singleton=1").get() as Policy | undefined;
  if (!row) throw new AuthError("AUTH_UNAVAILABLE", 503);
  return row;
}
export function assertOwner(db: Database.Database, config: AuthConfig): void {
  const owners = db.prepare('SELECT id, twoFactorEnabled FROM user').all() as { id: string; twoFactorEnabled: number }[];
  if (owners.length !== 1 || owners[0]?.id !== config.ownerId || policy(db).ownerId !== config.ownerId) throw new AuthError("AUTH_UNAVAILABLE", 503);
  const factors = db.prepare('SELECT userId, verified FROM twoFactor').all() as { userId: string; verified: number }[];
  if (factors.length > 1 || factors.some(f => f.userId !== config.ownerId) ||
    Boolean(owners[0].twoFactorEnabled) !== Boolean(factors[0]?.verified)) throw new AuthError("AUTH_UNAVAILABLE", 503);
}
export function sessionById(db: Database.Database, config: AuthConfig, id: string): OwnerSession | null {
  assertOwner(db, config);
  const row = db.prepare(`SELECT s.id, s.expiresAt, s.mfaApproved, u.email, u.twoFactorEnabled FROM session s
    JOIN user u ON u.id=s.userId WHERE s.id=? AND s.userId=?`).get(id, config.ownerId) as
    { id: string; expiresAt: string | number; mfaApproved: number; email: string; twoFactorEnabled: number } | undefined;
  if (!row) return null;
  const expiresAt = new Date(row.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { id: row.id, email: row.email, expiresAt, approved: row.mfaApproved === 1, enrolled: row.twoFactorEnabled === 1 };
}
export async function ownerSession(auth: NativeLibrary, db: Database.Database, config: AuthConfig, headers: Headers): Promise<OwnerSession | null> {
  const result = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  return result ? sessionById(db, config, result.session.id) : null;
}
export function requireApproved(session: OwnerSession | null): asserts session is OwnerSession {
  if (!session) throw new AuthError("AUTH_REQUIRED", 401);
  if (!session.approved || !session.enrolled) throw new AuthError("MFA_REQUIRED", 403);
}
export function issueSetupKey(db: Database.Database, config: AuthConfig): string {
  const key = randomBytes(32).toString("base64url");
  db.prepare("UPDATE authPolicy SET setupDigest=?, setupExpires=?, claimId=NULL, claimExpires=0 WHERE singleton=1")
    .run(createHmac("sha256", config.replayKey).update(key).digest("hex"), Date.now() + 30 * 60_000);
  return key;
}
export function selectEnrollment(db: Database.Database, config: AuthConfig, session: OwnerSession | null, key?: string): void {
  if (!session) throw new AuthError("AUTH_REQUIRED", 401);
  if (session.enrolled || session.approved) throw new AuthError("REAUTH_REQUIRED", 403);
  db.transaction(() => {
    const p = policy(db);
    const now = Date.now();
    const live = p.claimId && p.claimExpires > now && sessionById(db, config, p.claimId);
    if (live && p.claimId === session.id) return;
    if (live) throw new AuthError("ENROLLMENT_BUSY", 409, new Date(p.claimExpires).toISOString());
    if (!p.setupDigest || p.setupExpires <= now) throw new AuthError("SETUP_KEY_EXPIRED", 403);
    const digest = createHmac("sha256", config.replayKey).update(key ?? "").digest("hex");
    if (!timingSafeEqual(Buffer.from(digest), Buffer.from(p.setupDigest))) throw new AuthError("SETUP_KEY_INVALID", 403);
    db.prepare("UPDATE authPolicy SET claimId=?, claimExpires=? WHERE singleton=1").run(session.id, Math.min(session.expiresAt, now + ENROLLMENT_MS));
  }).immediate();
}
export function requireEnrollment(db: Database.Database, session: OwnerSession | null): void {
  if (!session) throw new AuthError("AUTH_REQUIRED", 401);
  const p = policy(db);
  if (session.enrolled || p.claimId !== session.id || p.claimExpires <= Date.now()) throw new AuthError("REAUTH_REQUIRED", 403);
}
