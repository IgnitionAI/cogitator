import { authenticationRequired } from "./config.js";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { assertOwner, AuthError, createNativeAuth, issueSetupKey, migrateAuth, type AuthConfig } from "./native-auth.js";

export const authPaths = (home: string) => ({ directory: join(home, "auth"), required: join(home, "auth-required"),
  maintenance: join(home, "auth-maintenance"), config: join(home, "auth", "config.json"), db: join(home, "auth", "auth.sqlite"), socket: join(home, "auth", "owner.sock") });
/** Conservative Unix sun_path limit, including space for its terminating NUL on supported platforms. */
export function validateOwnerSocketPath(home: string): void {
  if (Buffer.byteLength(authPaths(home).socket, "utf8") > 103) throw new Error("Owner socket path exceeds 103 UTF-8 bytes; choose a shorter COGITATOR_HOME.");
}

export function protectedRequired(home: string, explicit?: boolean): boolean {
  try { explicit ??= authenticationRequired(); } catch { throw new AuthError("AUTH_UNAVAILABLE", 503); }
  const p = authPaths(home);
  return explicit || [p.required, p.directory, p.maintenance].some(path => {
    try { lstatSync(path); return true; } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
  });
}
export function checkPrivate(path: string, directory = false): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (s.mode & 0o077) !== 0 ||
    (process.getuid && s.uid !== process.getuid())) throw new AuthError("AUTH_UNAVAILABLE", 503);
}
function checkHome(home: string): void {
  const s = lstatSync(home);
  if (s.isSymbolicLink() || !s.isDirectory() || (s.mode & 0o022) !== 0 || (process.getuid && s.uid !== process.getuid())) throw new AuthError("AUTH_UNAVAILABLE", 503);
}
function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function privateWrite(path: string, data: string, exclusive = false): void {
  const fd = openSync(path, exclusive ? "wx" : "w", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(resolve(path, ".."));
}
export function maintenance(home: string): void {
  const path = authPaths(home).maintenance;
  if (existsSync(path)) { checkPrivate(path); return; }
  privateWrite(path, "Offline administration incomplete. Run auth recover with all servers stopped.\n", true);
}
function finishMaintenance(home: string): void {
  privateWrite(authPaths(home).required, "required\n");
  unlinkSync(authPaths(home).maintenance); syncDirectory(home);
}
export function lockHome(home: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  checkHome(home);
  const path = join(home, "owner-lock.sqlite");
  if (!existsSync(path)) { try { privateWrite(path, "", true); } catch (err) { if (!existsSync(path)) throw err; } }
  checkPrivate(path);
  const db = new Database(path, { timeout: 0 });
  try { db.exec("BEGIN EXCLUSIVE"); } catch { db.close(); throw new Error("Data home is busy; stop all Cogitator instances before offline administration."); }
  return () => { db.exec("ROLLBACK"); db.close(); };
}
export async function reservePort(port: number): Promise<() => Promise<void>> {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  return () => new Promise<void>((done, reject) => server.close(err => err ? reject(err) : done()));
}
const configSchema = z.object({ origin: z.string().url(), secret: z.string().min(32), replayKey: z.string().min(32), ownerId: z.string().min(1) }).strict();
export function validateOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== origin) throw new Error("Origin must be an exact HTTPS origin, without a path.");
  return origin;
}
export function loadAuth(home: string, allowMaintenance = false) {
  validateOwnerSocketPath(home);
  if (process.platform === "win32") throw new AuthError("AUTH_UNAVAILABLE", 503);
  const p = authPaths(home);
  checkHome(home); checkPrivate(p.required); checkPrivate(p.directory, true); checkPrivate(p.config); checkPrivate(p.db);
  if (!allowMaintenance && (readFileSync(p.required, "utf8") !== "required\n" || existsSync(p.maintenance))) throw new AuthError("AUTH_UNAVAILABLE", 503);
  for (const name of readdirSync(p.directory)) {
    if (name === "owner.sock") continue;
    checkPrivate(join(p.directory, name));
  }
  const config = configSchema.parse(JSON.parse(readFileSync(p.config, "utf8")));
  validateOrigin(config.origin);
  const db = new Database(p.db, { fileMustExist: true });
  try { assertOwner(db, config); } catch (err) { if (!allowMaintenance) { db.close(); throw err; } }
  const { auth } = createNativeAuth(db, config);
  const identities = [p.required, p.directory, p.config, p.db].map(path => ({ path, stat: lstatSync(path) }));
  return { db, config, auth, home, assertAvailable: () => {
    checkPrivate(p.required); checkPrivate(p.directory, true); checkPrivate(p.db); checkPrivate(p.config);
    if (readFileSync(p.required, "utf8") !== "required\n" || existsSync(p.maintenance)) throw new AuthError("AUTH_UNAVAILABLE", 503);
    for (const { path, stat } of identities) { const current = lstatSync(path); if (current.ino !== stat.ino || current.dev !== stat.dev) throw new AuthError("AUTH_UNAVAILABLE", 503); }
    assertOwner(db, config);
  } };
}
export type AuthState = ReturnType<typeof loadAuth>;

/** Caller holds the data-home lock and configured port reservation. No application catalog is opened. */
export async function initializeOwner(home: string, origin: string, email: string, password: string): Promise<string> {
  validateOwnerSocketPath(home);
  validateOrigin(origin);
  z.email().parse(email);
  if (password.length < 12 || password.length > 128) throw new Error("Password must have 12–128 characters.");
  if (process.platform === "win32") throw new AuthError("AUTH_UNAVAILABLE", 503);
  const p = authPaths(home);
  const resuming = protectedRequired(home, false);
  if (resuming && !existsSync(p.maintenance) && (!existsSync(p.required) || readFileSync(p.required, "utf8") !== "initializing\n")) throw new Error("Protected state already exists; use offline recovery, never reinitialize it.");
  if (!existsSync(p.required)) privateWrite(p.required, "initializing\n", true);
  else checkPrivate(p.required);
  maintenance(home);
  if (!existsSync(p.directory)) { mkdirSync(p.directory, { mode: 0o700 }); syncDirectory(home); }
  else checkPrivate(p.directory, true);
  let config: AuthConfig;
  if (existsSync(p.config)) {
    checkPrivate(p.config);
    config = configSchema.parse(JSON.parse(readFileSync(p.config, "utf8")));
    if (config.ownerId !== "pending") throw new Error("Protected state already exists; use offline recovery.");
    if (config.origin !== origin) throw new Error("Resume initialization with the original HTTPS origin.");
  } else {
    if (existsSync(p.db)) throw new Error("Missing auth secret; restore the private auth backup, never replace credentials in place.");
    config = { origin, secret: randomBytes(48).toString("base64url"), replayKey: randomBytes(48).toString("base64url"), ownerId: "pending" };
    privateWrite(p.config, JSON.stringify(config), true);
  }
  if (!existsSync(p.db)) privateWrite(p.db, "", true);
  else checkPrivate(p.db);
  const db = new Database(p.db);
  try {
    let resetToken: string | undefined;
    const { auth, options } = createNativeAuth(db, config, true, token => { resetToken = token; });
    await migrateAuth(db, options);
    const owners = db.prepare("SELECT id,email FROM user").all() as { id: string; email: string }[];
    if (owners.length > 1 || (owners[0] && owners[0].email !== email.toLowerCase())) throw new AuthError("AUTH_UNAVAILABLE", 503);
    if (owners[0]) {
      config.ownerId = owners[0].id;
      await auth.api.requestPasswordReset({ body: { email: owners[0].email } });
      if (!resetToken) throw new AuthError("AUTH_UNAVAILABLE", 503);
      await auth.api.resetPassword({ body: { token: resetToken, newPassword: password } });
      resetToken = undefined;
    } else config.ownerId = (await auth.api.signUpEmail({ body: { name: "Owner", email, password } })).user.id;
    db.transaction(() => {
      db.prepare("INSERT INTO authPolicy(singleton,ownerId) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET ownerId=excluded.ownerId").run(config.ownerId);
      db.exec("DELETE FROM session; DELETE FROM verification;");
    })();
    if (existsSync(`${p.config}.tmp`)) { checkPrivate(`${p.config}.tmp`); unlinkSync(`${p.config}.tmp`); }
    privateWrite(`${p.config}.tmp`, JSON.stringify(config), true);
    renameSync(`${p.config}.tmp`, p.config); syncDirectory(p.directory);
    const key = issueSetupKey(db, config);
    assertOwner(db, config);
    finishMaintenance(home);
    return key;
  } finally { db.close(); }
}

/** Maintenance stays durable on every exception, including a consumed reset token or partial password write. */
export async function recoverOwner(home: string, password: string): Promise<string> {
  validateOwnerSocketPath(home);
  maintenance(home);
  const state = loadAuth(home, true);
  const { db, config } = state;
  let token: string | undefined;
  try {
    const owners = db.prepare("SELECT id,email FROM user").all() as { id: string; email: string }[];
    if (owners.length !== 1 || owners[0]?.id !== config.ownerId) throw new AuthError("AUTH_UNAVAILABLE", 503);
    const { auth } = createNativeAuth(db, config, true, value => { token = value; });
    await auth.api.requestPasswordReset({ body: { email: owners[0].email } });
    if (!token) throw new AuthError("AUTH_UNAVAILABLE", 503);
    await auth.api.resetPassword({ body: { token, newPassword: password } });
    token = undefined;
    db.transaction(() => {
      db.prepare("UPDATE user SET twoFactorEnabled=0 WHERE id=?").run(config.ownerId);
      db.exec("DELETE FROM twoFactor; DELETE FROM session; DELETE FROM verification;");
      db.prepare("UPDATE authPolicy SET claimId=NULL, claimExpires=0, setupDigest=NULL, setupExpires=0 WHERE singleton=1").run();
    }).immediate();
    const key = issueSetupKey(db, config);
    assertOwner(db, config);
    finishMaintenance(home);
    return key;
  } finally { token = undefined; db.close(); }
}
export function replaceSetupKey(home: string): string {
  const state = loadAuth(home);
  try {
    if ((state.db.prepare("SELECT twoFactorEnabled FROM user WHERE id=?").get(state.config.ownerId) as { twoFactorEnabled: number }).twoFactorEnabled) throw new Error("Already enrolled; use offline recovery.");
    maintenance(home);
    state.db.exec("DELETE FROM session; DELETE FROM verification; DELETE FROM twoFactor;");
    const key = issueSetupKey(state.db, state.config);
    finishMaintenance(home);
    return key;
  } finally { state.db.close(); }
}
