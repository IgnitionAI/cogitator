// Run: node --import tsx --test test/native-auth-ui.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, parseAuthStatus, authStatus, enableFactor, signIn } from "../web/src/auth-api.js";
import { api } from "../web/src/api.js";
import { authMessages } from "../web/src/locales/auth.js";

test("native UI status fails closed for malformed protected state and missing expiry", () => {
  for (const input of [null, {}, { mode: "unknown" }, { mode: "protected", state: ["authenticated"] }, { mode: "protected", state: "authenticated" }, { mode: "protected", state: "authenticated", expiresAt: "2099" }, { mode: "protected", state: "enrollment", expiresAt: new Date().toISOString() }]) {
    assert.throws(() => parseAuthStatus(input), (error: unknown) => error instanceof AuthError && error.code === "AUTH_UNAVAILABLE");
  }
  assert.deepEqual(parseAuthStatus({ mode: "local" }), { mode: "local" });
  assert.deepEqual(parseAuthStatus({ mode: "protected", state: "anonymous" }), { mode: "protected", state: "anonymous" });
});

test("all stable auth codes have English/French copy without raw backend errors", () => {
  for (const code of ["INVALID_INPUT", "INVALID_CREDENTIALS", "INVALID_CODE", "REAUTH_REQUIRED", "AUTH_REQUIRED", "MFA_REQUIRED", "AUTH_UNAVAILABLE", "SETUP_KEY_INVALID", "SETUP_KEY_EXPIRED", "ENROLLMENT_BUSY", "RATE_LIMITED", "CODE_ALREADY_USED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNKNOWN", "OFFLINE"]) {
    const key = `auth.error.${code}` as keyof typeof authMessages;
    assert(authMessages[key]?.en && authMessages[key]?.fr, code);
  }
});

test("thin auth client rejects malformed responses, remote enrollment URIs and network failures", async () => {
  const original = globalThis.fetch;
  let payload: unknown = {};
  globalThis.fetch = async (url, options) => {
    assert(String(url).startsWith("/api/auth/"));
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.cache, "no-store");
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  try {
    await assert.rejects(authStatus(), { code: "AUTH_UNAVAILABLE" });
    await assert.rejects(signIn("fixture@test.invalid", "fixture-password"), { code: "AUTH_UNAVAILABLE" });
    payload = { totpURI: "https://remote.invalid/?secret=JBSWY3DP", backupCodes: ["fixture"] };
    await assert.rejects(enableFactor("fixture-password"), { code: "AUTH_UNAVAILABLE" });
    payload = { totpURI: "otpauth://totp/Fixture?secret=JBSWY3DP", backupCodes: ["fixture"] };
    assert.deepEqual(await enableFactor("fixture-password"), { secret: "JBSWY3DP", backupCodes: ["fixture"] });
    globalThis.fetch = async () => { throw new TypeError("private failure details"); };
    await assert.rejects(authStatus(), { code: "OFFLINE", message: "OFFLINE" });
  } finally { globalThis.fetch = original; }
});


test("bodyless application mutations send JSON Content-Type while reads stay bodyless", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (url, options) => {
    const method = options?.method ?? "GET";
    calls.push({ url: String(url), method });
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.body, undefined);
    const contentType = new Headers(options?.headers).get("content-type");
    if (method === "GET" || method === "HEAD") assert.equal(contentType, null);
    else assert.equal(contentType, "application/json", `${method} must pass the protected mutation boundary`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    assert.deepEqual(await api.stopConversation("fixture"), { ok: true });
    assert.deepEqual(await api.deleteAgent("fixture"), { ok: true });
    await api.health();
    assert.deepEqual(calls, [
      { url: "/api/conversations/fixture/stop", method: "POST" },
      { url: "/api/agents/fixture", method: "DELETE" },
      { url: "/api/health", method: "GET" },
    ]);
  } finally { globalThis.fetch = original; }
});
