import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadPty, MAX_TERMINALS, shellLaunch, TerminalManager, type PtyProcess, type PtySpawn } from "../src/terminal.js";
import { buildPrompt, cleanCommand, parseExplain, piComplete, runAssist, type CompleteFn } from "../src/terminal-assist.js";
import { getPaths } from "../src/paths.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { PiPool } from "../src/pool.js";
import { fixture, httpCall, origin } from "./native-auth-fixture.js";

// ---------- Pseudo-terminal factice ----------

function fakePty() {
  const spawned: Array<{ file: string; args: string[]; cwd: string; cols: number; rows: number; written: string[]; sizes: Array<[number, number]>; killed: boolean; emit: (d: string) => void; exit: (code: number) => void }> = [];
  const spawn: PtySpawn = (file, args, opts) => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const record = { file, args, cwd: opts.cwd, cols: opts.cols, rows: opts.rows, written: [] as string[], sizes: [] as Array<[number, number]>, killed: false,
      emit: (d: string) => onData(d), exit: (code: number) => onExit({ exitCode: code }) };
    spawned.push(record);
    const pty: PtyProcess = {
      pid: 1000 + spawned.length,
      onData: (cb) => { onData = cb; },
      onExit: (cb) => { onExit = cb; },
      write: (d) => { record.written.push(d); },
      resize: (c, r) => { record.sizes.push([c, r]); },
      kill: () => { record.killed = true; },
    };
    return pty;
  };
  return { spawn, spawned };
}

const launch = (cwd = tmpdir()) => ({ title: "t", kind: "shell" as const, file: "/bin/sh", args: [], cwd, env: {}, shellIntegration: false });

test("gestionnaire : relecture du tampon, entrée, redimensionnement borné, sortie, limite, fermeture", () => {
  const { spawn, spawned } = fakePty();
  const m = new TerminalManager(spawn);
  const info = m.create(launch(), { cols: 9999, rows: 1 });
  assert.deepEqual([spawned[0]!.cols, spawned[0]!.rows], [500, 4]);
  spawned[0]!.emit("hello ");
  const frames: string[] = [];
  const detach = m.attach(info.id, { send: (f) => frames.push(f), close: () => frames.push("closed") });
  assert.deepEqual(JSON.parse(frames[0]!), { t: "o", d: "hello " }, "relecture à l'attache");
  spawned[0]!.emit("world");
  assert.deepEqual(JSON.parse(frames[1]!), { t: "o", d: "world" });
  m.input(info.id, "ls\r");
  m.resize(info.id, 120, 40);
  assert.deepEqual(spawned[0]!.written, ["ls\r"]);
  assert.deepEqual(spawned[0]!.sizes, [[120, 40]]);
  spawned[0]!.exit(3);
  assert.deepEqual(JSON.parse(frames.at(-1)!), { t: "x", code: 3 });
  assert.equal(m.get(info.id)?.exitCode, 3);
  m.input(info.id, "ignored");
  assert.equal(spawned[0]!.written.length, 1, "pas d'écriture après sortie");
  detach();

  for (let i = 1; i < MAX_TERMINALS; i++) m.create(launch(), { cols: 80, rows: 24 });
  assert.throws(() => m.create(launch(), { cols: 80, rows: 24 }), /TERMINAL_LIMIT/);
  assert.throws(() => new TerminalManager(spawn).create(launch("/does/not/exist"), { cols: 80, rows: 24 }), /TERMINAL_CWD_INVALID/);
  const second = m.list()[1]!;
  assert.equal(m.close(second.id), true);
  assert.equal(spawned[1]!.killed, true);
  m.dispose();
  assert.equal(m.list().length, 0);
  assert.throws(() => new TerminalManager(null).create(launch(), { cols: 80, rows: 24 }), /TERMINAL_UNAVAILABLE/);
});

test("vrai bash : sortie interactive et code de sortie émis (OSC 133;D)", { skip: !loadPty() || process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-term-"));
  try {
    const m = new TerminalManager(loadPty());
    const l = shellLaunch(home, home);
    const info = m.create({ ...l, env: { ...l.env, HOME: home } }, { cols: 100, rows: 30 });
    let out = "";
    m.attach(info.id, { send: (f) => { const fr = JSON.parse(f); if (fr.t === "o") out += fr.d; }, close: () => {} });
    const waitFor = async (re: RegExp) => { for (let i = 0; i < 100 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 50)); assert.match(out, re); };
    if (l.shellIntegration) await waitFor(/\u001b\]133;D;0\u0007/);
    m.input(info.id, "echo cogito-$((40+2))\r");
    await waitFor(/cogito-42/);
    if (l.shellIntegration) {
      m.input(info.id, "false\r");
      await waitFor(/\u001b\]133;D;1\u0007/);
    }
    m.dispose();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------- Assistant ----------

test("assistant : nettoyage de commande, explication + FIX, complétion sans répétition, prompt borné", async () => {
  assert.equal(cleanCommand("```bash\n$ ls -la\n```"), "ls -la");
  assert.equal(cleanCommand("`df -h`"), "df -h");
  assert.deepEqual(parseExplain("Le dossier n'existe pas.\nFIX: mkdir -p /tmp/x && cd /tmp/x"), { text: "Le dossier n'existe pas.", fix: "mkdir -p /tmp/x && cd /tmp/x" });
  assert.deepEqual(parseExplain("Rien à corriger."), { text: "Rien à corriger." });
  const echo: CompleteFn = async (_t, _s, user) => user.includes("Partial") ? "git status --short" : "x";
  assert.equal((await runAssist(echo, { provider: "p", model: "m" }, { mode: "complete", input: "git sta" })).text, "tus --short");
  const prompt = buildPrompt({ mode: "explain", input: "make", output: "y".repeat(10_000), exitCode: 2, cwd: "/srv" });
  assert.ok(prompt.length < 4500 && prompt.includes("Exit code: 2") && prompt.includes("/srv"));
});

test("assistant : appel réel via pi-ai vers un fournisseur compatible OpenAI (models.json)", async () => {
  let seen: { auth?: string; body?: { messages?: Array<{ role: string; content: unknown }>; max_tokens?: number; max_completion_tokens?: number } } = {};
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(b) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      chunk({ id: "1", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: { role: "assistant", content: "```bash\ndu -ah /var | sort -rh | head -n 20\n```" }, finish_reason: null }] });
      chunk({ id: "1", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const dir = mkdtempSync(join(tmpdir(), "cog-assist-"));
  try {
    const port = (srv.address() as AddressInfo).port;
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { fakeoa: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "sk-test-123",
      models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    writeFileSync(join(dir, "auth.json"), "{}");
    const paths = getPaths({ COGITATOR_HOME: dir, COGITATOR_PI_AGENT_DIR: dir });
    const r = await runAssist(piComplete(paths), { provider: "fakeoa", model: "m1" }, { mode: "command", input: "trouve les gros fichiers dans /var" });
    assert.equal(r.text, "du -ah /var | sort -rh | head -n 20");
    assert.equal(seen.auth, "Bearer sk-test-123");
    assert.equal(seen.body?.messages?.[0]?.role, "system");
    await assert.rejects(runAssist(piComplete(paths), { provider: "fakeoa", model: "nope" }, { mode: "command", input: "x" }), /introuvable/);
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---------- HTTP / WebSocket ----------

test("mode local : terminal indisponible (mode protégé requis)", async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-term-local-"));
  const { db, version } = openDb(join(home, "c.db"));
  const app = createApp({ db, dbPath: join(home, "c.db"), dbVersion: version, paths: getPaths({ COGITATOR_HOME: home }),
    pool: new PiPool({ factory: () => { throw new Error("no pi"); } }), terminalPty: fakePty().spawn });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const status = await (await fetch(`${base}/api/terminal`)).json();
    assert.equal(status.enabled, false);
    assert.equal(status.reason, "TERMINAL_PROTECTED_MODE_REQUIRED");
    const create = await fetch(`${base}/api/terminal/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(create.status, 403);
  } finally { app.close(); db.close(); rmSync(home, { recursive: true, force: true }); }
});

function wsOpen(port: number, id: string, headers: Record<string, string>) {
  return new Promise<{ ws: WebSocket; frames: Array<{ t: string; d?: string; code?: number }>; closed: Promise<number> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws/${id}`, { headers: { host: new URL(origin).host, ...headers } });
    const frames: Array<{ t: string; d?: string; code?: number }> = [];
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    ws.once("open", () => resolve({ ws, frames, closed }));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

test("mode protégé : session propriétaire, WebSocket avec Origin exacte, coupure à la déconnexion, assistant", async () => {
  const pty = fakePty();
  const calls: string[] = [];
  const complete: CompleteFn = async (target, system, user) => { calls.push(`${target.provider}/${target.model}`); return system.includes("autocomplete") ? "" : system.includes("Explain") ? "Permission refusée.\nFIX: sudo cat /etc/shadow" : "ls -lah"; };
  const f = await fixture("password", { terminalPty: pty.spawn, terminalComplete: complete });
  try {
    const json = { "content-type": "application/json" };
    assert.equal((await httpCall(f.port, "/api/terminal/sessions", "POST", {})).status, 401, "anonyme refusé");

    const browser = f.browser();
    assert.equal((await browser.login()).status, 200);
    const cookie = browser.cookie();
    const status = await httpCall(f.port, "/api/terminal", "GET", undefined, { cookie });
    assert.equal(status.data.enabled, true, status.text);
    assert.ok(Array.isArray(status.data.agents));
    const agent = await httpCall(f.port, "/api/agents", "POST", { name: "Ops", provider: "openai", model: "gpt-test" }, { cookie, ...json });
    assert.equal(agent.status, 201, agent.text);
    const agentId = (agent.data as { id?: string; agent?: { id: string } }).id ?? (agent.data as { agent: { id: string } }).agent.id;
    assert.equal((await httpCall(f.port, "/api/terminal/assist", "POST", { mode: "command", input: "x", agent_id: "missing" }, { cookie, ...json })).status, 404);

    const created = await httpCall(f.port, "/api/terminal/sessions", "POST", { cols: 100, rows: 30 }, { cookie, ...json });
    assert.equal(created.status, 201, created.text);
    const id = (created.data.session as { id: string }).id;
    assert.equal(pty.spawned[0]!.cols, 100);
    pty.spawned[0]!.emit("prompt$ ");

    await assert.rejects(wsOpen(f.port, id, { cookie, origin: "https://evil.example" }), /403/);
    await assert.rejects(wsOpen(f.port, id, { origin }), /403/, "sans cookie");

    const { ws, frames, closed } = await wsOpen(f.port, id, { cookie, origin });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(frames[0], { t: "o", d: "prompt$ " });
    ws.send(JSON.stringify({ t: "i", d: "whoami\r" }));
    ws.send(JSON.stringify({ t: "r", c: 132, r: 43 }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(pty.spawned[0]!.written, ["whoami\r"]);
    assert.deepEqual(pty.spawned[0]!.sizes, [[132, 43]]);

    const cmd = await httpCall(f.port, "/api/terminal/assist", "POST", { mode: "command", input: "liste les fichiers", agent_id: agentId }, { cookie, ...json });
    assert.equal(cmd.data.text, "ls -lah", cmd.text);
    const exp = await httpCall(f.port, "/api/terminal/assist", "POST", { mode: "explain", input: "cat /etc/shadow", exit_code: 1, agent_id: agentId }, { cookie, ...json });
    assert.equal(exp.data.fix, "sudo cat /etc/shadow");
    assert.deepEqual(calls, ["openai/gpt-test", "openai/gpt-test"]);

    // Déconnexion : le flux est coupé à la vérification suivante.
    await httpCall(f.port, "/api/auth/sign-out", "POST", {}, { cookie, ...json });
    const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
    assert.notEqual(code, -1, "WebSocket fermé après déconnexion");

    // Nouvelle session : fermeture.
    const again = f.browser(); await again.login();
    const del = await httpCall(f.port, `/api/terminal/sessions/${id}`, "DELETE", {}, { cookie: again.cookie(), ...json });
    assert.equal(del.status, 200, del.text);
    assert.equal(pty.spawned[0]!.killed, true);
  } finally { await f.close(); }
});

test("désactivation explicite : COGITATOR_TERMINAL=0", async () => {
  const previous = process.env.COGITATOR_TERMINAL;
  process.env.COGITATOR_TERMINAL = "0";
  const f = await fixture("password", { terminalPty: fakePty().spawn });
  try {
    const browser = f.browser(); await browser.login();
    const status = await httpCall(f.port, "/api/terminal", "GET", undefined, { cookie: browser.cookie() });
    assert.equal(status.data.reason, "TERMINAL_DISABLED");
    assert.equal((await httpCall(f.port, "/api/terminal/sessions", "POST", {}, { cookie: browser.cookie() })).status, 403);
  } finally {
    if (previous === undefined) delete process.env.COGITATOR_TERMINAL; else process.env.COGITATOR_TERMINAL = previous;
    await f.close();
  }
});
