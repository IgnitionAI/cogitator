import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fs = (await import("node:fs")).default;
const { syncBuiltinESMExports } = await import("node:module");

const order: string[] = [];
const originalFsync = fs.fsyncSync;
const originalRename = fs.renameSync;
mock.method(fs, "fsyncSync", (fd: number) => {
  order.push("fsync");
  return originalFsync.call(fs, fd);
});
mock.method(fs, "renameSync", (...args: Parameters<typeof originalRename>) => {
  order.push("rename");
  return originalRename.apply(fs, args);
});
syncBuiltinESMExports();

const { atomicWriteJson } = await import("../src/json-files.js");

const home = mkdtempSync(join(tmpdir(), "cog-json-fsync-"));
test.after(() => rmSync(home, { recursive: true, force: true }));

test("atomicWriteJson : fsync du fichier temporaire avant rename", () => {
  const path = join(home, "state.json");
  order.length = 0;
  atomicWriteJson(path, { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ok: true });
  const fsyncAt = order.indexOf("fsync");
  const renameAt = order.indexOf("rename");
  assert.ok(fsyncAt >= 0, "fsyncSync doit être appelé");
  assert.ok(renameAt >= 0, "renameSync doit être appelé");
  assert.ok(fsyncAt < renameAt, "fsync doit précéder rename");
});
