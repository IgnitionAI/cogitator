import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPaths } from "../src/paths.js";
import { ProviderLogins, type LoginEvent } from "../src/provider-login.js";
import { listProviders, upsertProvider, deleteProvider } from "../src/registry.js";

const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "cog-provider-setup-"));
  return { home, paths: getPaths({ HOME: home, COGITATOR_HOME: home }) };
};

test("first provider can be saved without a pre-existing pi directory, with immediate isolated status", async () => {
  const one = fixture(); const two = fixture();
  try {
    const logins = new ProviderLogins(one.paths);
    const { id } = logins.start("deepseek", "api_key");
    const events: LoginEvent[] = [];
    const listener = (event: LoginEvent) => events.push(event);
    events.push(...logins.subscribe(id, listener)!);
    await tick();
    assert.equal(events.at(-1)?.type, "prompt");
    assert.equal(logins.reply(id, ""), false, "empty secrets must stay pending");
    assert.equal(logins.reply(id, "sk-fixture-not-a-real-key"), true);
    await tick();
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(events.filter(e => e.type === "prompt_clear").length, 1);
    assert.equal(statSync(one.paths.piAuthJson).mode & 0o777, 0o600);
    const ready = await listProviders(one.paths);
    assert.equal(ready.find(p => p.id === "deepseek")?.auth.ready, true);
    assert.equal((await listProviders(two.paths)).find(p => p.id === "deepseek")?.auth.configured, false);
    assert.ok(!JSON.stringify(ready).includes("sk-fixture"));
    deleteProvider(one.paths, "deepseek");
    assert.equal((await listProviders(one.paths)).find(p => p.id === "deepseek")?.auth.configured, false);
    logins.cancel(id);
  } finally { rmSync(one.home, { recursive: true }); rmSync(two.home, { recursive: true }); }
});

test("custom local endpoint has models and key availability without a network or pi CLI check", async () => {
  const { home, paths } = fixture();
  try {
    assert.deepEqual(upsertProvider(paths, "local-fixture", {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "local-only", models: [{ id: "fixture" }],
    }), {});
    const provider = (await listProviders(paths)).find(p => p.id === "local-fixture")!;
    assert.equal(provider.auth.ready, true, "local availability deliberately does not claim endpoint acceptance");
    assert.deepEqual(provider.models, [{ id: "fixture" }]);
    upsertProvider(paths, "local-fixture", { apiKey: "replacement" });
    assert.equal(statSync(`${paths.piAuthJson}.bak`).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(paths.piAuthJson, "utf8"))["local-fixture"].key, "replacement");
  } finally { rmSync(home, { recursive: true }); }
});

test("OAuth out-of-band callback clears its manual prompt and finishes the same login", async () => {
  const { home, paths } = fixture();
  const promptAbort = new AbortController();
  let callback!: () => void;
  const logins = new ProviderLogins(paths, {
    async login(_id, _type, interaction) {
      interaction.notify({ type: "auth_url", url: "https://example.com/authorize" });
      const callbackDone = new Promise<void>(resolve => { callback = resolve; });
      const manual = interaction.prompt({ type: "manual_code", message: "Paste redirect", signal: promptAbort.signal });
      await Promise.race([manual, callbackDone]);
      promptAbort.abort();
      await manual.catch(() => undefined);
      return { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 60_000 };
    },
  });
  try {
    const { id } = logins.start("fixture", "oauth");
    const events = logins.subscribe(id, () => {})!;
    await tick(); assert.equal(events.at(-1)?.type, "prompt");
    callback(); await tick();
    assert.equal(events.at(-1)?.type, "done");
    assert.ok(events.some(e => e.type === "prompt_clear"));
    assert.equal(logins.reply(id, "stale code"), false);
    assert.equal(logins.cancel(id), true);
  } finally { rmSync(home, { recursive: true }); }
});

test("canceling a pending OAuth prompt aborts the provider and removes its login session", async () => {
  const { home, paths } = fixture();
  let signal: AbortSignal | undefined;
  const logins = new ProviderLogins(paths, {
    async login(_id, _type, interaction) {
      signal = interaction.signal;
      await interaction.prompt({ type: "text", message: "Continue" });
      return { type: "api_key", key: "fixture" };
    },
  });
  try {
    const { id } = logins.start("fixture", "oauth");
    await tick(); assert.equal(logins.cancel(id), true); await tick();
    assert.equal(signal?.aborted, true); assert.equal(logins.has(id), false); assert.equal(logins.reply(id, "later"), false);
  } finally { rmSync(home, { recursive: true }); }
});


test("ChatGPT OAuth receives a stable per-installation device ID across controller restarts", async () => {
  const one = fixture(); const two = fixture();
  const seen: string[] = [];
  const models = {
    async login(_id: string, _type: unknown, _interaction: unknown, options?: { getDeviceId?: () => string }) {
      assert.ok(options?.getDeviceId);
      seen.push(options.getDeviceId());
      assert.equal(options.getDeviceId(), seen.at(-1));
      return { type: "api_key" as const, key: "fixture" };
    },
  };
  try {
    for (const paths of [one.paths, one.paths, two.paths]) {
      const logins = new ProviderLogins(paths, models);
      const { id } = logins.start("openai", "oauth"); await tick(); logins.cancel(id);
    }
    assert.match(seen[0]!, /^[0-9a-f-]{36}$/);
    assert.equal(seen[0], seen[1]); assert.notEqual(seen[0], seen[2]);
    assert.equal(statSync(join(one.home, "provider-device.json")).mode & 0o777, 0o600);
  } finally { rmSync(one.home, { recursive: true }); rmSync(two.home, { recursive: true }); }
});


test("controller disposal cancels every pending OAuth flow and releases login resources", async () => {
  const { home, paths } = fixture();
  const signals: AbortSignal[] = [];
  const logins = new ProviderLogins(paths, {
    async login(_id, _type, interaction) {
      signals.push(interaction.signal!);
      await interaction.prompt({ type: "manual_code", message: "Paste callback" });
      return { type: "api_key", key: "fixture" };
    },
  });
  try {
    const first = logins.start("one", "oauth"); const second = logins.start("two", "oauth");
    await tick(); logins.dispose(); await tick();
    assert.equal(logins.has(first.id), false); assert.equal(logins.has(second.id), false);
    assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted));
    logins.dispose();
  } finally { rmSync(home, { recursive: true }); }
});
