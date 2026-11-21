import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { fixture, httpCall, origin } from "./native-auth-fixture.js";
import { listOAuthGrants, revokeOAuthGrant } from "../src/mcp-oauth.js";

type F = Awaited<ReturnType<typeof fixture>>;
let f: F;
let cookie = "";
const redirect = "https://client.example/callback";
const accept = { accept: "application/json, text/event-stream" };

before(async () => {
  f = await fixture("password");
  const browser = f.browser();
  const login = await browser.login();
  assert.equal(login.status, 200, login.text);
  cookie = browser.cookie();
});
after(async () => { await f.close(); });

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
function post(path: string, body: string, headers: Record<string, string> = {}) {
  return httpCall(f.port, path, "POST", body, { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)), ...headers });
}
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
async function register(extra: Record<string, unknown> = {}) {
  const r = await httpCall(f.port, "/oauth/register", "POST", { redirect_uris: [redirect], client_name: "Test Connector", ...extra });
  assert.equal(r.status, 201, r.text);
  return r.data as { client_id: string; client_secret?: string };
}
function authorizeUrl(clientId: string, challenge: string, scope = "full") {
  return `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope, resource: `${origin}/mcp` })}`;
}
async function approve(clientId: string, challenge: string, scope: "read" | "full") {
  const page = await httpCall(f.port, authorizeUrl(clientId, challenge), "GET", undefined, { cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" });
  assert.equal(page.status, 200, page.text);
  const requestId = /name="request_id" value="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(requestId, "consent page carries a request id");
  const decision = await post("/oauth/authorize", form({ request_id: requestId!, decision: "approve", scope }), { cookie, origin });
  assert.equal(decision.status, 302, decision.text);
  const location = new URL(String(decision.headers.location));
  assert.equal(location.origin + location.pathname, redirect);
  assert.equal(location.searchParams.get("state"), "xyz");
  assert.equal(location.searchParams.get("iss"), origin);
  return location.searchParams.get("code")!;
}
async function exchange(clientId: string, code: string, verifier: string) {
  return post("/oauth/token", form({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }));
}
async function mcpInit(token: string) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
  return httpCall(f.port, "/mcp", "POST", body, { ...accept, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), authorization: `Bearer ${token}` });
}
async function toolNames(token: string) {
  const init = await mcpInit(token);
  assert.equal(init.status, 200, init.text);
  const sess = { ...accept, "content-type": "application/json", authorization: `Bearer ${token}`, "mcp-session-id": String(init.headers["mcp-session-id"]), "mcp-protocol-version": "2025-06-18" };
  const n = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  await httpCall(f.port, "/mcp", "POST", n, { ...sess, "content-length": String(Buffer.byteLength(n)) });
  const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const r = await httpCall(f.port, "/mcp", "POST", list, { ...sess, "content-length": String(Buffer.byteLength(list)) });
  return [...r.text.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]!);
}

test("découverte : métadonnées RFC 9728 / 8414 et WWW-Authenticate resource_metadata", async () => {
  const pr = await httpCall(f.port, "/.well-known/oauth-protected-resource");
  assert.equal(pr.status, 200);
  assert.equal(pr.data.resource, `${origin}/mcp`);
  assert.deepEqual(pr.data.authorization_servers, [origin]);
  const as = await httpCall(f.port, "/.well-known/oauth-authorization-server");
  assert.equal(as.data.issuer, origin);
  assert.deepEqual(as.data.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.data.registration_endpoint, `${origin}/oauth/register`);
  const unauth = await mcpInit("cgo_nope");
  assert.equal(unauth.status, 401);
  assert.match(String(unauth.headers["www-authenticate"]), /resource_metadata="https:\/\/owner\.example\.invalid\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await httpCall(f.port, "/.well-known/oauth-protected-resource", "GET", undefined, { host: "evil.example" })).status, 403);
});

test("flux complet : register → login → consentement → code + PKCE → jeton → /mcp (scope choisi)", async () => {
  const client = await register();
  const { verifier, challenge } = pkce();

  const anonymous = await httpCall(f.port, authorizeUrl(client.client_id, challenge), "GET", undefined, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" });
  assert.equal(anonymous.status, 200);
  assert.match(anonymous.text, /Sign in to Cogitator/);
  assert.doesNotMatch(anonymous.text, /request_id/);

  const code = await approve(client.client_id, challenge, "read");
  const token = await exchange(client.client_id, code, verifier);
  assert.equal(token.status, 200, token.text);
  assert.match(String(token.data.access_token), /^cgo_/);
  assert.equal(token.data.scope, "read");
  assert.equal(token.data.token_type, "Bearer");

  // Code à usage unique.
  assert.equal((await exchange(client.client_id, code, verifier)).data.error, "invalid_grant");

  const names = await toolNames(String(token.data.access_token));
  assert.ok(names.includes("cogitator_list_agents"));
  assert.ok(!names.includes("cogitator_create_agent"), "scope read choisi par le propriétaire");
  assert.ok(listOAuthGrants(f.home).some((g) => g.client_name === "Test Connector"));
});

test("refresh tournant ; rejeu d'un ancien refresh → grant révoqué", async () => {
  const client = await register();
  const { verifier, challenge } = pkce();
  const first = await exchange(client.client_id, await approve(client.client_id, challenge, "full"), verifier);
  const r1 = String(first.data.refresh_token);
  const second = await post("/oauth/token", form({ grant_type: "refresh_token", refresh_token: r1, client_id: client.client_id }));
  assert.equal(second.status, 200, second.text);
  assert.notEqual(second.data.refresh_token, r1);
  assert.equal((await mcpInit(String(first.data.access_token))).status, 401, "ancien jeton d'accès invalidé");
  assert.equal((await mcpInit(String(second.data.access_token))).status, 200);
  const replay = await post("/oauth/token", form({ grant_type: "refresh_token", refresh_token: r1, client_id: client.client_id }));
  assert.equal(replay.data.error, "invalid_grant");
  assert.equal((await mcpInit(String(second.data.access_token))).status, 401, "grant révoqué après rejeu");
});

test("refus : PKCE faux, redirect_uri inconnue, formulaire intersite, refus du propriétaire, client confidentiel", async () => {
  const client = await register();
  const { challenge } = pkce();
  const bad = await exchange(client.client_id, await approve(client.client_id, challenge, "full"), pkce().verifier);
  assert.equal(bad.data.error, "invalid_grant");

  const wrongRedirect = await httpCall(f.port, authorizeUrl(client.client_id, challenge).replace(encodeURIComponent(redirect), encodeURIComponent("https://evil.example/cb")), "GET", undefined, { cookie });
  assert.equal(wrongRedirect.status, 400);
  assert.equal(wrongRedirect.headers.location, undefined);

  const noPkce = await httpCall(f.port, `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: "s" })}`, "GET", undefined, { cookie });
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(String(noPkce.headers.location)).searchParams.get("error"), "invalid_request");

  const page = await httpCall(f.port, authorizeUrl(client.client_id, challenge), "GET", undefined, { cookie });
  const requestId = /name="request_id" value="([^"]+)"/.exec(page.text)![1]!;
  const csrf = await post("/oauth/authorize", form({ request_id: requestId, decision: "approve" }), { cookie, origin: "https://evil.example" });
  assert.equal(csrf.status, 403);
  const noCookie = await post("/oauth/authorize", form({ request_id: requestId, decision: "approve" }), { origin });
  assert.equal(noCookie.status, 403);
  const denied = await post("/oauth/authorize", form({ request_id: requestId, decision: "deny" }), { cookie, origin });
  assert.equal(new URL(String(denied.headers.location)).searchParams.get("error"), "access_denied");

  assert.equal((await httpCall(f.port, "/oauth/register", "POST", { redirect_uris: ["http://evil.example/cb"] })).status, 400);

  const confidential = await register({ token_endpoint_auth_method: "client_secret_post" });
  assert.match(String(confidential.client_secret), /^cgs_/);
  const p = pkce();
  const code = await approve(confidential.client_id, p.challenge, "full");
  const noSecret = await exchange(confidential.client_id, code, p.verifier);
  assert.equal(noSecret.data.error, "invalid_client");
});

test("révocation CLI d'un client OAuth : accès coupé", async () => {
  const client = await register({ client_name: "Revoke Me" });
  const { verifier, challenge } = pkce();
  const t = await exchange(client.client_id, await approve(client.client_id, challenge, "full"), verifier);
  assert.equal((await mcpInit(String(t.data.access_token))).status, 200);
  assert.equal(revokeOAuthGrant(f.home, "Revoke Me"), true);
  assert.equal((await mcpInit(String(t.data.access_token))).status, 401);
});
