import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "../src/json-files.js";
import { fileCredentialStore } from "../src/provider-login.js";
import { getPaths } from "../src/paths.js";
import { deleteProvider, upsertProvider } from "../src/registry.js";

const home = mkdtempSync(join(tmpdir(), "cog-json-integrity-"));
test.after(() => rmSync(home, { recursive: true, force: true }));

const truncatedAuth = '{"keep":{"type":"api_key","key":"secret"';

test("readJson : fichier absent → fallback", () => {
  const path = join(home, "missing.json");
  assert.deepEqual(readJson(path, { ok: true }), { ok: true });
});

test("readJson : JSON tronqué → erreur, fichier intact", () => {
  const path = join(home, "truncated.json");
  writeFileSync(path, truncatedAuth);
  assert.throws(() => readJson(path, {}), SyntaxError);
  assert.equal(readFileSync(path, "utf8"), truncatedAuth);
});

test("readJson : EACCES → erreur, fichier intact", () => {
  const path = join(home, "denied.json");
  writeFileSync(path, '{"keep":true}\n', { mode: 0o600 });
  chmodSync(path, 0o000);
  try {
    assert.throws(() => readJson(path, {}), (err: NodeJS.ErrnoException) => err.code === "EACCES");
    chmodSync(path, 0o600);
    assert.equal(readFileSync(path, "utf8"), '{"keep":true}\n');
  } finally {
    try { chmodSync(path, 0o600); } catch { /* restore for cleanup */ }
  }
});

test("fileCredentialStore.modify : JSON tronqué n'est pas écrasé par {}", async () => {
  const path = join(home, "creds-truncated.json");
  writeFileSync(path, truncatedAuth);
  const store = fileCredentialStore(path);
  await assert.rejects(() => store.modify("other", async () => ({ type: "api_key", key: "x" })));
  assert.equal(readFileSync(path, "utf8"), truncatedAuth);
});

test("fileCredentialStore.delete : EACCES n'est pas écrasé par {}", async () => {
  const dir = join(home, "creds-denied-dir");
  mkdirSync(dir);
  const path = join(dir, "creds-denied.json");
  const original = '{"keep":{"type":"api_key","key":"secret"}}\n';
  writeFileSync(path, original, { mode: 0o600 });
  const before = readdirSync(dir).sort();
  chmodSync(path, 0o000);
  try {
    const store = fileCredentialStore(path);
    await assert.rejects(() => store.delete("keep"), (err: NodeJS.ErrnoException) => err.code === "EACCES");
    assert.deepEqual(readdirSync(dir).sort(), before);
    chmodSync(path, 0o600);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    try { chmodSync(path, 0o600); } catch { /* restore for cleanup */ }
  }
});

test("upsertProvider / deleteProvider : JSON tronqué n'est pas écrasé par {}", () => {
  const root = join(home, "provider-home");
  mkdirSync(root, { recursive: true });
  const paths = getPaths({ HOME: root, COGITATOR_HOME: root });
  mkdirSync(paths.piAgentDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.piModelsJson, '{"providers":{"keep":{"api":"openai-completions"}');
  writeFileSync(paths.piAuthJson, truncatedAuth, { mode: 0o600 });

  assert.throws(() => upsertProvider(paths, "local-fixture", {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "x", models: [{ id: "fixture" }],
  }), SyntaxError);
  assert.equal(readFileSync(paths.piModelsJson, "utf8"), '{"providers":{"keep":{"api":"openai-completions"}');
  assert.equal(readFileSync(paths.piAuthJson, "utf8"), truncatedAuth);

  assert.throws(() => deleteProvider(paths, "keep"), SyntaxError);
  assert.equal(readFileSync(paths.piModelsJson, "utf8"), '{"providers":{"keep":{"api":"openai-completions"}');
  assert.equal(readFileSync(paths.piAuthJson, "utf8"), truncatedAuth);
});

test("atomicWriteJson : écriture atomique, .bak, nom temporaire non prévisible", () => {
  const dir = join(home, "atomic");
  mkdirSync(dir);
  const path = join(dir, "state.json");
  const previous = { version: 2, extras: { old: true } };
  writeFileSync(path, JSON.stringify(previous, null, 2) + "\n");
  const plantedPidTmp = `${path}.tmp-${process.pid}`;
  writeFileSync(plantedPidTmp, "planted-pid-tmp\n");

  const next = { version: 2, extras: { next: true } };
  atomicWriteJson(path, next);

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), next);
  assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, "utf8")), previous);
  assert.equal(existsSync(plantedPidTmp), true);
  assert.equal(readFileSync(plantedPidTmp, "utf8"), "planted-pid-tmp\n");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".tmp-") && name !== `state.json.tmp-${process.pid}`),
    [],
  );
});
