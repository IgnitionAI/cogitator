import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { getPaths } from "../src/paths.js";
import { PiPool } from "../src/pool.js";
import { createMcpToken, listMcpTokens, mcpTokenPath, revokeMcpToken, McpTokenVerifier } from "../src/mcp-tokens.js";
import { mcpCommand } from "../src/mcp-cli.js";

let home: string;
let db: Database.Database;
let server: ReturnType<typeof createApp>;
let base: string;
let full: string;
let readOnly: string;
const clients: Client[] = [];

before(async () => {
  home = mkdtempSync(join(tmpdir(), "cogitator-mcp-http-"));
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  server = createApp({
    db,
    dbPath: join(home, "cogitator.db"),
    dbVersion: opened.version,
    paths: getPaths({ COGITATOR_HOME: home, COGITATOR_PI_AGENT_DIR: join(home, "pi"), COGITATOR_SKILLS_DIRS: join(home, "skills") }),
    pool: new PiPool({ factory: () => { throw new Error("MCP HTTP tests must not spawn pi"); } }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  full = createMcpToken(home, { name: "full-bot", scope: "full" }).token;
  readOnly = createMcpToken(home, { name: "reader", scope: "read" }).token;
});

after(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  server?.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

async function connect(token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

test("jetons : seul le hash est stocké, fichier 0600, vérification", () => {
  const raw = JSON.stringify(listMcpTokens(home));
  assert.ok(!raw.includes(full.slice(4)));
  if (process.platform !== "win32") assert.equal(statSync(mcpTokenPath(home)).mode & 0o777, 0o600);
  const v = new McpTokenVerifier(home);
  assert.equal(v.verify(full)?.scope, "full");
  assert.equal(v.verify(readOnly)?.scope, "read");
  assert.equal(v.verify("cgt_nope"), undefined);
  assert.equal(v.verify(undefined), undefined);
});

test("/mcp sans jeton ou jeton invalide → 401 + WWW-Authenticate", async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
  for (const headers of [{}, { authorization: "Bearer cgt_invalid" }, { authorization: "Basic abc" }]) {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer /);
  }
});

test("/mcp : méthode non supportée → 405 ; requête sans session ni initialize → 400", async () => {
  const put = await fetch(`${base}/mcp`, { method: "PUT", headers: { authorization: `Bearer ${full}` } });
  assert.equal(put.status, 405);
  const list = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${full}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  assert.equal(list.status, 400);
});

test("jeton full : outils de lecture et d'écriture, appels dispatchés vers /api", async () => {
  const { client } = await connect(full);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["cogitator_health", "cogitator_create_workspace", "cogitator_send_message", "cogitator_read_conversation", "cogitator_stop_conversation"]) assert.ok(names.includes(n), n);
  const health = tools.find((t) => t.name === "cogitator_health")!;
  assert.equal(health.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "cogitator_delete_agent")!.annotations?.destructiveHint, true);

  const h = await client.callTool({ name: "cogitator_health", arguments: {} });
  assert.equal(JSON.parse(text(h)).ok, true);

  const dir = join(home, "ws-one");
  mkdirSync(dir);
  const created = await client.callTool({ name: "cogitator_create_workspace", arguments: { dir, name: "ws-one" } });
  assert.notEqual(created.isError, true, text(created));
  const listed = JSON.parse(text(await client.callTool({ name: "cogitator_list_workspaces", arguments: {} })));
  assert.ok(JSON.stringify(listed).includes("ws-one"));

  // Une erreur d'API remonte en isError, jamais en exception de transport.
  const missing = await client.callTool({ name: "cogitator_get_agent", arguments: { id: "nope" } });
  assert.equal(missing.isError, true);
  // Un id ne peut pas viser une autre route.
  const injected = await client.callTool({ name: "cogitator_get_agent", arguments: { id: "../health" } });
  assert.equal(injected.isError, true);
});

test("jeton read : aucun outil d'écriture exposé", async () => {
  const { client } = await connect(readOnly);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("cogitator_list_agents"));
  assert.ok(names.includes("cogitator_read_conversation"));
  for (const n of ["cogitator_create_agent", "cogitator_delete_workspace", "cogitator_send_message", "team_send", "cogitator_board_move"]) assert.ok(!names.includes(n), n);
  const call = await client.callTool({ name: "cogitator_create_agent", arguments: { name: "x", provider: "p", model: "m" } });
  assert.equal(call.isError, true);
});

test("une session est liée au jeton qui l'a ouverte", async () => {
  const { transport } = await connect(full);
  const res = await fetch(`${base}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${readOnly}`, "mcp-session-id": transport.sessionId!, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
  assert.equal(res.status, 403);
  const unknown = await fetch(`${base}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${full}`, "mcp-session-id": "does-not-exist", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
  assert.equal(unknown.status, 404);
});

test("révocation : la session ouverte perd l'accès immédiatement", async () => {
  const temp = createMcpToken(home, { name: "temp", scope: "full" });
  const { client } = await connect(temp.token);
  assert.notEqual((await client.callTool({ name: "cogitator_health", arguments: {} })).isError, true);
  assert.equal(revokeMcpToken(home, temp.info.id), true);
  await assert.rejects(client.callTool({ name: "cogitator_health", arguments: {} }));
});

test("CLI : create / list / revoke", () => {
  const lines: string[] = [];
  mcpCommand(home, 5320, ["token", "create", "cli-bot", "--scope", "read"], (l) => lines.push(l));
  const token = lines.find((l) => l.trim().startsWith("cgt_"))!.trim();
  assert.equal(new McpTokenVerifier(home).verify(token)?.name, "cli-bot");
  lines.length = 0;
  mcpCommand(home, 5320, ["token", "list"], (l) => lines.push(l));
  assert.ok(lines.some((l) => l.includes("cli-bot") && l.includes("read")));
  mcpCommand(home, 5320, ["token", "revoke", "cli-bot"], () => undefined);
  assert.equal(new McpTokenVerifier(home).verify(token), undefined);
  assert.throws(() => mcpCommand(home, 5320, ["token", "create", "x", "--scope", "admin"], () => undefined));
  assert.throws(() => mcpCommand(home, 5320, ["nope"], () => undefined), /Usage/);
});

// ---------- Mode protégé (VPS) : jeton Bearer, hôte et Origin contrôlés ----------

test("mode protégé : /mcp exige le jeton, contrôle l'hôte et l'Origin, pas de cookie", async () => {
  const { fixture, httpCall, origin } = await import("./native-auth-fixture.js");
  const f = await fixture("password");
  try {
    const token = createMcpToken(f.home, { name: "vps-bot", scope: "full" }).token;
    const accept = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const body = JSON.stringify(init);
    const len = { "content-length": String(Buffer.byteLength(body)) };

    assert.equal((await httpCall(f.port, "/mcp", "POST", body, { ...accept })).status, 401);
    assert.equal((await httpCall(f.port, "/mcp", "POST", body, { ...accept, ...len, authorization: `Bearer ${token}`, host: "evil.example" })).status, 403);
    assert.equal((await httpCall(f.port, "/mcp", "POST", body, { ...accept, ...len, authorization: `Bearer ${token}`, origin: "https://evil.example" })).status, 403);

    const ok = await httpCall(f.port, "/mcp", "POST", body, { ...accept, ...len, authorization: `Bearer ${token}`, origin });
    assert.equal(ok.status, 200, ok.text);
    const session = ok.headers["mcp-session-id"] as string;
    assert.ok(session);
    const sess = { ...accept, authorization: `Bearer ${token}`, "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" };
    const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    await httpCall(f.port, "/mcp", "POST", notif, { ...sess, "content-length": String(Buffer.byteLength(notif)) });
    const callBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cogitator_list_agents", arguments: {} } });
    const called = await httpCall(f.port, "/mcp", "POST", callBody, { ...sess, "content-length": String(Buffer.byteLength(callBody)) });
    assert.equal(called.status, 200, called.text);
    assert.match(called.text, /"agents/);
    assert.doesNotMatch(called.text, /"isError":true/);
  } finally { await f.close(); }
});

test("mode local : pas d'OAuth, découverte en 404 JSON (jamais le fallback SPA)", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth/authorize"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("content-type") ?? "", /json/, path);
  }
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.doesNotMatch(res.headers.get("www-authenticate") ?? "", /resource_metadata/);
});
