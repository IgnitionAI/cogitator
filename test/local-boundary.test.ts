import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js";
import { getPaths } from "../src/paths.js";
import { PiPool } from "../src/pool.js";
import { createApp } from "../src/server.js";
import { listenOwnerSocket, ownerRequest } from "../src/owner-transport.js";
import { authPaths } from "../src/auth-state.js";
import { fixture, httpCall } from "./native-auth-fixture.js";

let home: string;
let db: ReturnType<typeof openDb>["db"];
let server: ReturnType<typeof createApp>;
let port: number;

function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; text: string; data: Record<string, unknown> }>((done, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path,
      method: opts.method ?? "GET",
      headers: opts.headers,
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON (static UI) */ }
        done({ status: res.statusCode!, text, data });
      });
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "cog-local-boundary-"));
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  server = createApp({
    db,
    dbPath: join(home, "cogitator.db"),
    dbVersion: opened.version,
    paths: getPaths({ COGITATOR_HOME: home }),
    pool: new PiPool({ factory: () => { throw new Error("local boundary tests must not spawn pi"); } }),
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("local mode rejects a foreign Host with 403", async () => {
  const res = await call("/api/health", { headers: { host: "evil.invalid" } });
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "FORBIDDEN");
});

test("local mode rejects POST with a foreign Origin or Sec-Fetch-Site cross-site with 403", async () => {
  const json = { "content-type": "application/json" };
  const origin = await call("/api/health", {
    method: "POST",
    headers: { ...json, origin: "https://evil.invalid" },
    body: "{}",
  });
  assert.equal(origin.status, 403);
  assert.equal(origin.data.error, "FORBIDDEN");
  const crossSite = await call("/api/health", {
    method: "POST",
    headers: { ...json, "sec-fetch-site": "cross-site" },
    body: "{}",
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.data.error, "FORBIDDEN");
});

test("local mode rejects POST with text/plain", async () => {
  const res = await call("/api/health", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "INVALID_INPUT");
});

test("local UI and MCP-style loopback calls still succeed", async () => {
  const status = await call("/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.data.authentication, "local");
  const authStatus = await call("/api/auth/status");
  assert.equal(authStatus.status, 200);
  assert.equal(authStatus.data.mode, "local");
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  const localhostHost = await call("/api/health", { headers: { host: `localhost:${port}` } });
  assert.equal(localhostHost.status, 200);
  const mcpGet = await ownerRequest<{ ok: boolean }>("GET", "/api/health", undefined, {
    COGITATOR_HOME: home,
    COGITATOR_URL: `http://127.0.0.1:${port}`,
  });
  assert.equal(mcpGet.ok, true);
  const mcpPost = await call("/api/nope", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(mcpPost.status, 404);
  assert.notEqual(mcpPost.data.error, "FORBIDDEN");
});

test("local mode 500 responses use an opaque code instead of err.message", async () => {
  // `new URL` rejects a backslash path; the handler must not echo that TypeError.
  const res = await call("/\\");
  assert.equal(res.status, 500);
  assert.equal(res.data.error, "INTERNAL");
  assert.doesNotMatch(res.text, /Invalid URL|ERR_INVALID_URL/i);
});

test("owner socket still serves without browser credentials", async () => {
  const f = await fixture();
  try {
    const ipc = await listenOwnerSocket(f.app, f.home);
    const { socket } = authPaths(f.home);
    const viaSocket = await httpCall(0, "/api/health", "GET", undefined, {}, socket);
    assert.equal(viaSocket.status, 200);
    assert.equal(viaSocket.data.ok, true);
    ipc.closeAllConnections();
    await new Promise<void>(done => ipc.close(() => done()));
  } finally {
    await f.close();
  }
});
