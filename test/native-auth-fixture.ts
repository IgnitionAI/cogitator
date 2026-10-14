import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { initializeOwner, loadAuth, lockHome } from "../src/auth-state.js";
import { openDb } from "../src/db.js";
import { getPaths } from "../src/paths.js";
import { PiPool } from "../src/pool.js";
import { createApp } from "../src/server.js";

// Unix IPC fixtures must not inherit an arbitrarily long harness TMPDIR.
export const AUTH_TEST_TMP = process.platform === "win32" ? tmpdir() : "/tmp";
export const origin = "https://owner.example.invalid";
export const password = "synthetic-only-owner-password-42";
export const email = "owner@example.invalid";
export function httpCall(port: number, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, socketPath?: string) {
  return new Promise<{ status: number; data: Record<string, unknown>; text: string; headers: IncomingHttpHeaders }>((done, reject) => {
    const req = request({ hostname: "127.0.0.1", port, socketPath, path, method, headers: { host: new URL(origin).host, ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body))), origin } : {}), ...headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; }); res.on("error", reject);
      res.on("end", () => { let data: Record<string, unknown> = {}; try { data = JSON.parse(text) as Record<string, unknown>; } catch {} done({ status: res.statusCode!, data, text, headers: res.headers }); });
    });
    req.on("error", reject); req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}
export class Browser {
  cookies = new Map<string,string>();
  constructor(readonly port: number) {}
  cookie() { return [...this.cookies].map(([k,v]) => `${k}=${v}`).join("; "); }
  async call(path: string, body?: unknown) {
    const result = await httpCall(this.port, path, body === undefined ? "GET" : "POST", body, { cookie: this.cookie() });
    for (const cookie of result.headers["set-cookie"] ?? []) { const pair = cookie.split(";")[0]!; const index = pair.indexOf("="); this.cookies.set(pair.slice(0,index), pair.slice(index+1)); }
    return result;
  }
  login() { return this.call("/api/auth/sign-in/email", { email, password }); }
}
export async function fixture() {
  const home = mkdtempSync(join(AUTH_TEST_TMP, "cog-auth-http-"));
  const unlock = lockHome(home);
  const key = await initializeOwner(home, origin, email, password);
  const state = loadAuth(home);
  const paths = getPaths({ COGITATOR_HOME: home, COGITATOR_PI_AGENT_DIR: join(home, "pi"), COGITATOR_AGENTS_DIR: join(home, "agents"), COGITATOR_SKILLS_DIRS: join(home, "skills") });
  const { db, version } = openDb(paths.db);
  let spawns = 0;
  const pool = new PiPool({ factory: () => { spawns++; throw new Error("Unexpected real provider spawn"); } });
  const events = new EventEmitter();
  const app = createApp({ db, dbPath: paths.db, dbVersion: version, paths, pool, events, auth: state });
  await new Promise<void>(done => app.listen(0, "127.0.0.1", done));
  const port = (app.address() as AddressInfo).port;
  const resetRates = () => state.db.exec("DELETE FROM rateLimit; DELETE FROM authThrottle;");
  const browser = () => new Browser(port);
  return { home, state, paths, db, pool, events, app, port, key, browser, resetRates, spawns: () => spawns,
    close: async () => { app.closeAllConnections(); if (app.listening) await closeServer(app); state.db.close(); db.close(); unlock(); rmSync(home, { recursive:true, force:true }); } };
}
export function closeServer(server: Server) { return new Promise<void>((done, reject) => server.close(err => err ? reject(err) : done())); }
export async function enroll(f: Awaited<ReturnType<typeof fixture>>, browser = f.browser()) {
  f.resetRates();
  const login = await browser.login(); if (login.status !== 200) throw new Error(`login ${login.text}`);
  const enabled = await browser.call("/api/auth/two-factor/enable", { password, setupKey: f.key });
  if (enabled.status !== 200 || typeof enabled.data.totpURI !== "string") throw new Error(`enable ${enabled.text}`);
  const secret = new TextDecoder().decode(base32.decode(new URL(enabled.data.totpURI).searchParams.get("secret")!));
  const otp = createOTP(secret);
  const verified = await browser.call("/api/auth/two-factor/verify-totp", { code: await otp.totp() });
  if (verified.status !== 200) throw new Error(`verify ${verified.text}`);
  return { browser, otp, backupCodes: enabled.data.backupCodes as string[] };
}
export async function authenticated(f: Awaited<ReturnType<typeof fixture>>) {
  const enrollment = await enroll(f);
  await enrollment.browser.call("/api/auth/sign-out", {});
  f.resetRates(); await enrollment.browser.login();
  const verified = await enrollment.browser.call("/api/auth/two-factor/verify-totp", { code: await enrollment.otp.totp() });
  if (verified.status !== 200) throw new Error(`challenge ${verified.text}`);
  return enrollment;
}
