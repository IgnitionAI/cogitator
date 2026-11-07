import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, password, email, httpCall } from "./native-auth-fixture.js";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AUTH_TEST_TMP, origin } from "./native-auth-fixture.js";
import { authPaths, initializeOwner, loadAuth, lockHome, setAuthenticationMode } from "../src/auth-state.js";
import { ownerSession, requireApproved, requiresMfa, selectEnrollment } from "../src/native-auth.js";

test("password login needs no setup key or MFA and preserves owner-only revocation", async () => {
  const f = await fixture("password");
  try {
    const browser = f.browser();
    assert.equal((await browser.call("/api/health")).status, 401);
    assert.equal((await browser.call("/api/auth/sign-in/email", { email, password: "wrong-password" })).status, 401);
    const login = await browser.login();
    assert.equal(login.status, 200);
    assert.equal(login.data.twoFactorRequired, false);
    const status = await browser.call("/api/auth/status");
    assert.equal(status.data.state, "authenticated");
    assert.equal(status.data.mfaRequired, false);
    assert.equal(status.data.enrollment, undefined);
    assert.ok(Date.parse(String(status.data.expiresAt)) - Date.now() > 23 * 60 * 60_000);
    assert.equal((await browser.call("/api/health")).status, 200);
    assert.equal(f.spawns(), 0);
    assert.equal((f.state.db.prepare("SELECT mfaApproved FROM session").get() as { mfaApproved: number }).mfaApproved, 0, "password authentication must never claim MFA");
    assert.equal((await browser.call("/api/auth/two-factor/enable", { password, setupKey: "unused" })).status, 404);
    assert.equal((await browser.call("/api/auth/sign-up/email", { email: "other@example.invalid", password })).status, 404);
    assert.equal((await httpCall(f.port, "/api/agents/missing/default", "POST", {}, { cookie: browser.cookie(), origin: "https://evil.invalid" })).status, 403);
    const oldCookie = browser.cookie();
    assert.equal((await browser.call("/api/auth/sign-out", {})).status, 200);
    assert.equal((await httpCall(f.port, "/api/health", "GET", undefined, { cookie: oldCookie })).status, 401);
  } finally { await f.close(); }
});

test("password session expiry and anonymous forged cookies still fail closed", async () => {
  const f = await fixture("password");
  try {
    assert.equal((await httpCall(f.port, "/api/health", "GET", undefined, { cookie: "session_token=forged", "x-mfa-approved": "true" })).status, 401);
    const browser = f.browser();
    await browser.login();
    f.state.db.prepare("UPDATE session SET expiresAt = '2000-01-01 00:00:00'").run();
    assert.equal((await browser.call("/api/health")).status, 401);
    assert.equal((await browser.call("/api/auth/status")).data.state, "anonymous");
  } finally { await f.close(); }
});

test("new owner defaults to password; missing legacy policy remains MFA and unknown policies fail closed", async () => {
  const home = mkdtempSync(join(AUTH_TEST_TMP, "cog-password-default-"));
  const unlock = lockHome(home);
  try {
    assert.equal(await initializeOwner(home, origin, email, password), "");
    let state = loadAuth(home);
    assert.equal(state.config.authentication, "password");
    assert.equal((state.db.prepare("SELECT setupDigest FROM authPolicy").get() as { setupDigest: unknown }).setupDigest, null);
    state.db.close();
    const path = authPaths(home).config;
    const config = JSON.parse(readFileSync(path, "utf8"));
    delete config.authentication;
    writeFileSync(path, JSON.stringify(config));
    state = loadAuth(home);
    assert.equal(requiresMfa(state.config), true);
    state.db.close();
    config.authentication = "anything-else";
    writeFileSync(path, JSON.stringify(config));
    assert.throws(() => loadAuth(home));
  } finally { unlock(); rmSync(home, { recursive: true, force: true }); }
});

test("offline switch clears abandoned enrollment and sessions without changing owner/password; faults retain maintenance", async () => {
  const home = mkdtempSync(join(AUTH_TEST_TMP, "cog-password-switch-"));
  const unlock = lockHome(home);
  try {
    const key = await initializeOwner(home, origin, email, password, "password-mfa");
    let state = loadAuth(home);
    const credentials = state.db.prepare("SELECT password FROM account WHERE providerId='credential'").get();
    const ownerId = state.config.ownerId;
    const login = await state.auth.handler(new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    }));
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const headers = new Headers({ origin, cookie, "content-type": "application/json" });
    const session = await ownerSession(state.auth, state.db, state.config, headers);
    selectEnrollment(state.db, state.config, session, key);
    const enabled = await state.auth.handler(new Request(`${origin}/api/auth/two-factor/enable`, { method: "POST", headers, body: JSON.stringify({ password, method: "totp" }) }));
    assert.equal(enabled.status, 200);
    assert.ok(state.db.prepare("SELECT 1 FROM twoFactor").get());
    state.db.exec("CREATE TRIGGER failSwitch BEFORE DELETE ON twoFactor BEGIN SELECT RAISE(ABORT,'synthetic switch fault'); END");
    state.db.close();
    assert.throws(() => setAuthenticationMode(home, "password"));
    assert.ok(existsSync(authPaths(home).maintenance));
    assert.throws(() => loadAuth(home));
    const db = new Database(authPaths(home).db);
    assert.ok(db.prepare("SELECT 1 FROM twoFactor").get(), "cleanup rolls back atomically");
    db.exec("DROP TRIGGER failSwitch"); db.close();
    assert.equal(setAuthenticationMode(home, "password"), "");
    state = loadAuth(home);
    assert.equal(state.config.ownerId, ownerId);
    assert.deepEqual(state.db.prepare("SELECT password FROM account WHERE providerId='credential'").get(), credentials);
    for (const table of ["session", "verification", "twoFactor"]) assert.equal((state.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    assert.equal((state.db.prepare("SELECT claimId FROM authPolicy").get() as { claimId: unknown }).claimId, null);
    assert.equal(await ownerSession(state.auth, state.db, state.config, headers), null, "old browser is revoked, not silently promoted");
    assert.throws(() => requireApproved(session), /MFA_REQUIRED/);
    state.db.close();
  } finally { unlock(); rmSync(home, { recursive: true, force: true }); }
});
