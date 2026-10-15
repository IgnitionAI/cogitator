import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authPaths } from "../src/auth-state.js";
import { createAgent } from "../src/agents.js";
import { listenOwnerSocket } from "../src/owner-transport.js";
import { Browser, enroll, fixture, httpCall, origin, password } from "./native-auth-fixture.js";

// External boundary matrix: every call below crosses a real TCP socket through a real
// forwarding gateway or straight at the backend port. No in-process request injection.

const originHost = new URL(origin).host;

/** Gateway that forwards untouched — like the TLS terminator in scripts/ui-native-auth-live.mjs. */
async function startGateway(upstreamPort: number): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const upstream = request({ hostname: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode!, incoming.headers);
      incoming.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Raw SSE client: resolves on response headers, streams chunks through an emitter. */
function openSse(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; chunks: EventEmitter; abort: () => void }>((done, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET", headers: { host: originHost, ...headers } }, res => {
      const chunks = new EventEmitter();
      res.setEncoding("utf8");
      res.on("data", c => chunks.emit("data", c));
      res.on("end", () => chunks.emit("end"));
      done({ status: res.statusCode!, chunks, abort: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}
const nextChunk = (chunks: EventEmitter, timeoutMs: number) =>
  new Promise<string>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE chunk deadline exceeded")), timeoutMs);
    chunks.once("data", c => { clearTimeout(timer); done(c); });
    chunks.once("end", () => { clearTimeout(timer); reject(new Error("SSE stream ended unexpectedly")); });
  });
const streamEnded = (chunks: EventEmitter, timeoutMs: number) =>
  new Promise<boolean>(done => {
    const timer = setTimeout(() => { chunks.removeAllListeners("end"); done(false); }, timeoutMs);
    chunks.once("end", () => { clearTimeout(timer); done(true); });
  });

function allRoutes(): { method: string; path: string }[] {
  const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  return [...source.matchAll(/\["(GET|POST|PUT|DELETE)", "(\/api\/[^"\n]+)"/g)]
    .map(([, method, path]) => ({ method: method!, path: path!.replace(/:[A-Za-z]+/g, "missing") }));
}

test("external gateway denies anonymous and password-only requests across every REST, SSE and file route", async () => {
  const f = await fixture();
  const gw = await startGateway(f.port);
  try {
    const routes = allRoutes();
    assert.ok(routes.length > 40);
    for (const { method, path } of routes) {
      const body = method === "GET" ? undefined : {};
      assert.equal((await httpCall(gw.port, path, method, body)).status, 401, `${method} ${path} anonymous through gateway`);
    }
    // Explicit surface checks beyond the registered-route scan.
    for (const path of ["/secret.json", "/unknown-spa", "/icon.png", "/api/nope"]) {
      assert.equal((await httpCall(gw.port, path)).status, 401, `${path} anonymous through gateway`);
    }
    assert.equal((await httpCall(gw.port, "/")).status, 200, "public login shell through gateway");
    assert.equal((await httpCall(gw.port, "/api/auth/status")).text, '{"mode":"protected","state":"anonymous"}');
    // Forged identity/forwarding headers confer nothing, from any side of the gateway.
    for (const headers of [
      { "x-user": "owner@example.invalid" }, { "x-forwarded-user": "owner@example.invalid" },
      { "x-remote-user": "owner@example.invalid" }, { "x-cogitator-peer": "127.0.0.1" },
      { authorization: "Bearer owner-admin-token" }, { cookie: "session_token=forged-value" },
      { "x-mfa-approved": "true", "x-owner-email": "owner@example.invalid" },
    ]) assert.equal((await httpCall(gw.port, "/api/health", "GET", undefined, headers)).status, 401, JSON.stringify(headers));
    assert.equal(f.spawns(), 0);
    // Enroll, then re-prove: anonymous still 401; a fresh password-only login earns only an MFA
    // challenge (no application session cookie), so every route still denies it.
    await enroll(f);
    for (const { method, path } of routes) {
      const body = method === "GET" ? undefined : {};
      assert.equal((await httpCall(gw.port, path, method, body)).status, 401, `${method} ${path} anonymous after enrollment`);
    }
    const passwordOnly = f.browser();
    assert.equal((await passwordOnly.login()).status, 200);
    for (const { method, path } of routes) {
      const body = method === "GET" ? undefined : {};
      assert.equal((await httpCall(gw.port, path, method, body, { cookie: passwordOnly.cookie() })).status, 401, `${method} ${path} password-only after enrollment`);
    }
  } finally {
    gw.server.closeAllConnections(); await new Promise<void>(d => gw.server.close(() => d()));
    await f.close();
  }
});

test("forged Host, Origin, cross-site fetch and non-JSON writes are denied; a valid cookie cannot cross-origin write", async () => {
  const f = await fixture();
  const gw = await startGateway(f.port);
  try {
    for (const headers of [{ host: "evil.invalid" }, { host: `127.0.0.1:${gw.port}` }]) {
      assert.equal((await httpCall(gw.port, "/api/health", "GET", undefined, headers)).status, 403, `forged host ${JSON.stringify(headers)}`);
      assert.equal((await httpCall(gw.port, "/", "GET", undefined, headers)).status, 403, "forged host on static");
      assert.equal((await httpCall(gw.port, "/api/auth/status", "GET", undefined, headers)).status, 403, "forged host on auth status");
    }
    for (const headers of [{ origin: "https://evil.invalid" }, { origin: origin.replace("https://", "http://") }, { "sec-fetch-site": "cross-site" }]) {
      assert.equal((await httpCall(gw.port, "/api/health", "GET", undefined, headers)).status, 403, JSON.stringify(headers));
    }
    // Mutations require the exact origin and JSON Content-Type, even for bodyless POSTs.
    assert.equal((await httpCall(gw.port, "/api/auth/sign-in/email", "POST", {}, { origin: "" })).status, 403, "missing origin mutation");
    assert.equal((await httpCall(gw.port, "/api/auth/sign-in/email", "POST", { email: "owner@example.invalid", password }, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await httpCall(gw.port, "/api/auth/sign-in/email", "POST", "{}", { "content-type": "text/plain" })).status, 400);
    // Valid approved owner cookie through the gateway: same-origin write allowed, foreign-origin write denied.
    const { browser, otp } = await enroll(f);
    assert.equal((await browser.call("/api/auth/sign-out", {})).status, 200);
    f.resetRates();
    assert.equal((await browser.login()).status, 200);
    assert.equal((await browser.call("/api/auth/two-factor/verify-totp", { code: await otp.totp() })).status, 200);
    const agent = createAgent(f.db, { name: "Boundary agent", provider: "never-spawn", model: "synthetic" });
    const sameOrigin = await browser.call(`/api/agents/${agent.id}/default`, {});
    assert.equal(sameOrigin.status, 200, "same-origin owner write through gateway");
    const crossOrigin = await httpCall(gw.port, `/api/agents/${agent.id}/default`, "POST", {}, { cookie: browser.cookie(), origin: "https://evil.invalid" });
    assert.equal(crossOrigin.status, 403, "valid cookie cannot write cross-origin");
  } finally {
    gw.server.closeAllConnections(); await new Promise<void>(d => gw.server.close(() => d()));
    await f.close();
  }
});

test("direct backend port access fails closed; loopback binding, liveness exception and Unix IPC are preserved", async () => {
  const f = await fixture();
  try {
    const direct = f.port;
    assert.equal((f.app.address() as AddressInfo).address, "127.0.0.1", "backend binds loopback only");
    // Direct port access with its own Host is rejected everywhere except the loopback liveness probe.
    const localHost = { host: `127.0.0.1:${direct}` };
    assert.equal((await httpCall(direct, "/api/health", "GET", undefined, localHost)).status, 403);
    assert.equal((await httpCall(direct, "/", "GET", undefined, localHost)).status, 403);
    assert.equal((await httpCall(direct, "/api/conversations", "POST", {}, localHost)).status, 403);
    assert.equal((await httpCall(direct, "/api/auth/status", "GET", undefined, localHost)).status, 403);
    assert.equal((await httpCall(direct, "/api/status", "GET", undefined, localHost)).status, 200, "minimal loopback liveness");
    assert.equal((await httpCall(direct, "/api/status")).status, 200, "public liveness answers any canonical host");
    // Direct access with a forged gateway Host grants no bypass: the application, not the proxy, enforces auth.
    assert.equal((await httpCall(direct, "/api/health")).status, 401, "forged gateway host, no session");
    assert.equal((await httpCall(direct, "/api/health", "GET", undefined, { authorization: "Bearer owner" })).status, 401);
    assert.equal((await httpCall(direct, "/api/health", "GET", undefined, { "x-forwarded-user": "owner@example.invalid" })).status, 401);
    // Reviewed local IPC exception: the owner-only Unix socket serves the OS owner without browser credentials,
    // and still refuses any request presenting browser identity headers.
    const ipc = await listenOwnerSocket(f.app, f.home);
    const { socket } = authPaths(f.home);
    assert.match(socket, /owner\.sock$/, "private IPC path");
    assert.equal((await httpCall(0, "/api/health", "GET", undefined, {}, socket)).status, 200, "Unix IPC owner request");
    assert.equal((await httpCall(0, "/api/status", "GET", undefined, {}, socket)).status, 200);
    assert.equal((await httpCall(0, "/api/health", "GET", undefined, { origin: "https://evil.invalid" }, socket)).status, 403, "IPC rejects browser identity headers");
    ipc.closeAllConnections();
    await new Promise<void>(d => ipc.close(() => d()));
    assert.equal(f.spawns(), 0);
  } finally { await f.close(); }
});

test("valid owner completes login + MFA through the gateway; logout revokes REST and closes SSE within the heartbeat bound", { timeout: 60_000 }, async () => {
  const f = await fixture();
  const gw = await startGateway(f.port);
  try {
    // Full journey from a clean client through the gateway: enroll, sign out, password + fresh MFA.
    const { browser, otp } = await enroll(f, new Browser(gw.port));
    assert.equal((await browser.call("/api/auth/sign-out", {})).status, 200);
    f.resetRates();
    assert.equal((await browser.login()).status, 200);
    assert.equal((await browser.call("/api/auth/two-factor/verify-totp", { code: await otp.totp() })).status, 200);
    assert.equal((await browser.call("/api/health")).status, 200, "approved owner reads through gateway");
    // Revocation bound: with an approved SSE stream open, logout kills the cookie everywhere.
    const stream = await openSse(gw.port, "/api/events", { cookie: browser.cookie() });
    assert.equal(stream.status, 200, "approved owner SSE through gateway");
    await nextChunk(stream.chunks, 20_000);
    assert.equal((await browser.call("/api/auth/sign-out", {})).status, 200);
    assert.equal((await browser.call("/api/health")).status, 401, "revoked cookie rejected on REST");
    assert.equal((await httpCall(gw.port, "/api/conversations", "POST", {}, { cookie: browser.cookie(), origin })).status, 401, "revoked cookie rejected on writes");
    assert.equal(await streamEnded(stream.chunks, 20_000), true, "revoked SSE closes within the 60-second bound (15s heartbeat)");
    assert.equal(f.events.listenerCount("event"), 0, "no SSE listener survives revocation");
    assert.equal(f.spawns(), 0);
  } finally {
    gw.server.closeAllConnections(); await new Promise<void>(d => gw.server.close(() => d()));
    await f.close();
  }
});
