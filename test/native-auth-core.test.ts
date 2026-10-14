import { AUTH_TEST_TMP } from "./native-auth-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { createNativeAuth, ownerSession, requireApproved, selectEnrollment } from "../src/native-auth.js";
import { initializeOwner, loadAuth, lockHome, recoverOwner, authPaths } from "../src/auth-state.js";

const password = "synthetic-only-owner-password-42";
const origin = "https://owner.example.invalid";
class Browser {
  cookies = new Map<string, string>();
  constructor(readonly auth: ReturnType<typeof createNativeAuth>["auth"]) {}
  headers() { return new Headers({ origin, "content-type": "application/json", cookie: [...this.cookies].map(([k,v]) => `${k}=${v}`).join("; "), "x-cogitator-peer": "127.0.0.1" }); }
  async post(path: string, body: unknown) {
    const response = await this.auth.handler(new Request(`${origin}/api/auth${path}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }));
    for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(";"); const index = pair!.indexOf("="); this.cookies.set(pair!.slice(0,index), pair!.slice(index+1)); }
    const data = await response.json().catch(() => ({}));
    assert.ok(!JSON.stringify(data).includes("mfaApproved"));
    return { status: response.status, data };
  }
}
test("real pinned library: old sessions, atomic replay/recovery and offline reset", async () => {
  const home = mkdtempSync(join(AUTH_TEST_TMP, "cogitator-native-"));
  const unlock = lockHome(home);
  let state: ReturnType<typeof loadAuth> | undefined;
  try {
    const key = await initializeOwner(home, origin, "owner@example.invalid", password);
    state = loadAuth(home);
    const { db, config, auth } = state;
    const resetRates = () => db.exec('DELETE FROM rateLimit');
    const login = async () => { resetRates(); const b = new Browser(auth); assert.equal((await b.post("/sign-in/email", { email: "owner@example.invalid", password })).status, 200); return b; };
    const selected = await login(); const stale = await login();
    const selectedSession = await ownerSession(auth, db, config, selected.headers());
    assert.throws(() => requireApproved(selectedSession), /MFA_REQUIRED/);
    selectEnrollment(db, config, selectedSession, key);
    assert.throws(() => selectEnrollment(db, config, null, key), /AUTH_REQUIRED/);
    const enabled = await selected.post("/two-factor/enable", { password, method: "totp" });
    assert.equal(enabled.status, 200);
    const secret = base32.decode(new URL(enabled.data.totpURI).searchParams.get("secret")!);
    const otp = createOTP(new TextDecoder().decode(secret));
    assert.equal((await selected.post("/two-factor/verify-totp", { code: await otp.totp() })).status, 200);
    assert.throws(() => requireApproved(null), /AUTH_REQUIRED/);
    assert.throws(() => requireApproved(selectedSession), /MFA_REQUIRED/);
    const staleSession = await ownerSession(auth, db, config, stale.headers());
    assert.equal(staleSession?.enrolled, true); assert.equal(staleSession?.approved, false);
    const a = await login(); const b = await login(); resetRates();
    const code = await otp.totp();
    const results = await Promise.all([a.post("/two-factor/verify-totp", { code }), b.post("/two-factor/verify-totp", { code })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session WHERE mfaApproved=1').get() as {n:number}).n, 1);
    const c = await login(); const d = await login(); resetRates();
    const recovery = await Promise.all([c.post("/two-factor/verify-backup-code", { code: enabled.data.backupCodes[0] }), d.post("/two-factor/verify-backup-code", { code: enabled.data.backupCodes[0] })]);
    assert.equal(recovery.filter(r => r.status === 200).length, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session WHERE mfaApproved=1').get() as {n:number}).n, 2);
    const wrongOwnerAuth = createNativeAuth(db, { ...config, ownerId: "not-the-owner" }).auth;
    resetRates(); const wrongOwner = new Browser(wrongOwnerAuth);
    assert.equal((await wrongOwner.post('/sign-in/email', { email: 'owner@example.invalid', password })).status, 200);
    assert.equal((await wrongOwner.post('/two-factor/verify-backup-code', { code: enabled.data.backupCodes[1] })).status, 200);
    assert.equal((await ownerSession(auth, db, config, wrongOwner.headers()))?.approved, false);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session WHERE mfaApproved=1').get() as {n:number}).n, 2);
    const stored = db.prepare('SELECT secret,backupCodes FROM twoFactor').get() as {secret:string;backupCodes:string};
    assert.ok(!stored.backupCodes.includes(enabled.data.backupCodes[2]));
    assert.notEqual(stored.secret, new TextDecoder().decode(secret));
    const failed = await login(); resetRates();
    const currentCounter = Math.floor(Date.now()/30_000);
    const previousCode = (await Promise.all([otp.hotp(currentCounter), otp.hotp(currentCounter+1), otp.hotp(currentCounter-1)])).find(value => value !== code)!;
    db.exec(`CREATE TRIGGER failSession BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT, 'synthetic insert fault'); END;`);
    assert.equal((await failed.post("/two-factor/verify-totp", { code: previousCode })).status, 500);
    db.exec('DROP TRIGGER failSession');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM authReplay').get() as {n:number}).n, 2);
    db.close(); state = undefined;
    const reopened = new Database(authPaths(home).db);
    assert.equal((reopened.prepare('SELECT COUNT(*) AS n FROM authReplay').get() as {n:number}).n, 2); reopened.close();
    state = loadAuth(home);
    state.db.exec('DELETE FROM rateLimit');
    const retry = new Browser(state.auth);
    assert.equal((await retry.post('/sign-in/email', { email: 'owner@example.invalid', password })).status, 200);
    assert.equal((await retry.post('/two-factor/verify-totp', { code: previousCode })).status, 409);
    state.db.close(); state = undefined;
    await recoverOwner(home, `${password}-new`);
    state = loadAuth(home);
    assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM session').get() as {n:number}).n, 0);
    assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM verification').get() as {n:number}).n, 0);
    assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM authReplay').get() as {n:number}).n, 2);
    assert.equal(await ownerSession(state.auth, state.db, state.config, a.headers()), null);
    const fresh = new Browser(state.auth);
    assert.equal((await fresh.post('/sign-in/email', { email: 'owner@example.invalid', password: `${password}-new` })).status, 200);
    assert.equal((await ownerSession(state.auth, state.db, state.config, fresh.headers()))?.approved, false);
  } finally { state?.db.close(); unlock(); rmSync(home, { recursive: true, force: true }); }
});
