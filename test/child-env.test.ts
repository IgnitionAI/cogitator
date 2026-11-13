import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPaths } from "../src/paths.js";
import { PiPool } from "../src/pool.js";
import { piCliPath, piCodingAgent } from "../src/host-pi.js";
import { upsertProvider } from "../src/registry.js";
import { buildChildEnv } from "../src/spawn.js";
import { createGuardedRpcClient, disposeSetprivShims } from "../src/pi-child.js";

const FIXTURE_OPENAI = "sk-test-openai-fixture";
const FIXTURE_ANTHROPIC = "sk-test-anthropic-fixture";
const FIXTURE_SERVER_SECRET = "cog-server-secret-fixture";

function dumpScript(file: string, out: string): void {
  writeFileSync(file, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\nsetInterval(() => {}, 1000);\n`);
}

async function childEnvViaRpc(provider: string, source: NodeJS.ProcessEnv, extra: Record<string, string>): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), "cog-child-env-"));
  const cli = join(dir, "dump.mjs");
  const out = join(dir, "env.json");
  dumpScript(cli, out);
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(source)) {
    previous[key] = process.env[key];
    process.env[key] = source[key]!;
  }
  const previousNoSetpriv = process.env.COGITATOR_PI_NO_SETPRIV;
  process.env.COGITATOR_PI_NO_SETPRIV = "1";
  try {
    const client = createGuardedRpcClient(piCodingAgent.RpcClient, cli, {
      cwd: dir,
      args: ["--model", `${provider}/fixture-model`],
      env: extra,
    });
    await client.start();
    const deadline = Date.now() + 3_000;
    let dumped: Record<string, string> | undefined;
    while (Date.now() < deadline) {
      try {
        dumped = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await client.stop?.().catch(() => undefined);
    if (!dumped) throw new Error("l'enfant n'a pas publié son environnement");
    return dumped;
  } finally {
    if (previousNoSetpriv === undefined) delete process.env.COGITATOR_PI_NO_SETPRIV;
    else process.env.COGITATOR_PI_NO_SETPRIV = previousNoSetpriv;
    for (const key of Object.keys(source)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    disposeSetprivShims();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("une variable secrète du serveur n'apparaît pas dans l'environnement d'un enfant", async () => {
  const env = buildChildEnv({
    provider: "openai",
    source: {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      COGITATOR_AUTH_SECRET: FIXTURE_SERVER_SECRET,
      BETTER_AUTH_SECRET: "better-auth-fixture",
      OPENAI_API_KEY: FIXTURE_OPENAI,
    },
    extra: { COGITATOR_HOME: "/tmp/cog" },
  });
  assert.equal(env.COGITATOR_AUTH_SECRET, undefined);
  assert.equal(env.BETTER_AUTH_SECRET, undefined);
  const child = await childEnvViaRpc("openai", {
    PATH: process.env.PATH ?? "/usr/bin",
    HOME: process.env.HOME ?? "/tmp",
    COGITATOR_AUTH_SECRET: FIXTURE_SERVER_SECRET,
    OPENAI_API_KEY: FIXTURE_OPENAI,
  }, { COGITATOR_HOME: "/tmp/cog-home" });
  assert.equal(child.COGITATOR_AUTH_SECRET, undefined, "le secret serveur ne doit pas fuir via la fusion SDK process.env");
});

test("les variables de la liste d'autorisation sont transmises", async () => {
  const env = buildChildEnv({
    provider: "openai",
    source: {
      PATH: "/opt/bin",
      HOME: "/home/cog",
      LANG: "C.UTF-8",
      SECRET_NOISE: "nope",
      PI_CODING_AGENT_DIR: "/should-not-copy-from-source-unless-extra",
    },
    extra: { COGITATOR_HOME: "/var/lib/cogitator", PI_CODING_AGENT_DIR: "/var/lib/pi", COGITATOR_CONVERSATION_ID: "c1" },
  });
  assert.equal(env.PATH, "/opt/bin");
  assert.equal(env.HOME, "/home/cog");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.COGITATOR_HOME, "/var/lib/cogitator");
  assert.equal(env.PI_CODING_AGENT_DIR, "/var/lib/pi");
  assert.equal(env.COGITATOR_CONVERSATION_ID, "c1");
  assert.equal(env.SECRET_NOISE, undefined);
  const child = await childEnvViaRpc("openai", {
    PATH: `/opt/allow-path:${process.env.PATH ?? "/usr/bin"}`,
    HOME: "/tmp/allow-home",
    LANG: "fr_FR.UTF-8",
    OPENAI_API_KEY: FIXTURE_OPENAI,
    NOISE: "drop-me",
  }, { COGITATOR_HOME: "/tmp/allow-cog" });
  assert.match(child.PATH ?? "", /^\/opt\/allow-path:/);
  assert.equal(child.HOME, "/tmp/allow-home");
  assert.equal(child.LANG, "fr_FR.UTF-8");
  assert.equal(child.COGITATOR_HOME, "/tmp/allow-cog");
  assert.equal(child.NOISE, undefined);
});

test("la clé du fournisseur choisi est transmise, pas celles des autres fournisseurs", async () => {
  const env = buildChildEnv({
    provider: "openai",
    source: {
      PATH: "/usr/bin",
      HOME: "/tmp",
      OPENAI_API_KEY: FIXTURE_OPENAI,
      ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC,
      GEMINI_API_KEY: "sk-test-gemini-fixture",
    },
  });
  assert.equal(env.OPENAI_API_KEY, FIXTURE_OPENAI);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  const anthropic = buildChildEnv({
    provider: "anthropic",
    source: {
      PATH: "/usr/bin",
      HOME: "/tmp",
      OPENAI_API_KEY: FIXTURE_OPENAI,
      ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC,
    },
  });
  assert.equal(anthropic.ANTHROPIC_API_KEY, FIXTURE_ANTHROPIC);
  assert.equal(anthropic.OPENAI_API_KEY, undefined);
  const child = await childEnvViaRpc("openai", {
    PATH: process.env.PATH ?? "/usr/bin",
    HOME: process.env.HOME ?? "/tmp",
    OPENAI_API_KEY: FIXTURE_OPENAI,
    ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC,
  }, { COGITATOR_HOME: "/tmp/cog-provider" });
  assert.equal(child.OPENAI_API_KEY, FIXTURE_OPENAI);
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
});

test("un agent démarre et répond avec l'environnement réduit", { timeout: 40_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cog-child-env-rpc-"));
  const paths = getPaths({ HOME: home, COGITATOR_HOME: home });
  const previousSecret = process.env.COGITATOR_AUTH_SECRET;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.COGITATOR_AUTH_SECRET = FIXTURE_SERVER_SECRET;
  process.env.ANTHROPIC_API_KEY = FIXTURE_ANTHROPIC;
  let requests = 0;
  const modelServer = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(JSON.parse(body).model, "fixture-model");
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) => ({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "LOCAL_RPC_OK" }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => modelServer.listen(0, "127.0.0.1", resolve));
  const pool = new PiPool({ factory: options => createGuardedRpcClient(piCodingAgent.RpcClient, piCliPath, {
    ...options,
    cwd: home,
    args: [...options.args, "--offline", "--no-extensions", "--no-skills", "--no-tools", "--no-prompt-templates"],
    env: { ...options.env, HOME: home, PI_CODING_AGENT_DIR: paths.piAgentDir, COGITATOR_HOME: home },
  }) });
  const seen: unknown[] = [];
  pool.onEvent((_id, event) => { seen.push(event); });
  try {
    assert.deepEqual(upsertProvider(paths, "fixture", {
      baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "local-fixture-only", models: [{ id: "fixture-model" }],
    }), {});
    await pool.ensure("c1", {
      cwd: home,
      args: ["--model", "fixture/fixture-model"],
      env: { HOME: home, PI_CODING_AGENT_DIR: paths.piAgentDir, COGITATOR_HOME: home },
    });
    assert.equal(pool.isLive("c1"), true);
    const pid = (pool.client("c1") as { process?: { pid?: number } | null }).process?.pid;
    if (process.platform === "linux" && pid) {
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      assert.equal(environ.includes(`COGITATOR_AUTH_SECRET=${FIXTURE_SERVER_SECRET}`), false);
      assert.equal(environ.includes(`ANTHROPIC_API_KEY=${FIXTURE_ANTHROPIC}`), false);
    }
    const settled = pool.waitForSettled("c1", 20_000);
    await pool.prompt("c1", "Reply with the fixture response");
    await settled;
    assert.match(JSON.stringify(seen), /LOCAL_RPC_OK/);
    assert.equal(requests, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.COGITATOR_AUTH_SECRET;
    else process.env.COGITATOR_AUTH_SECRET = previousSecret;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    await pool.dispose();
    disposeSetprivShims();
    modelServer.closeAllConnections();
    await new Promise<void>(resolve => modelServer.close(() => resolve()));
    rmSync(home, { recursive: true });
  }
});
