import assert from "node:assert/strict";
import { test } from "node:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { atomicWriteJson } = await import("../src/json-files.js");

const home = mkdtempSync(join(tmpdir(), "cog-json-"));
test.after(() => rmSync(home, { recursive: true, force: true }));

test("atomicWriteJson : sidecar lien symbolique → écriture refusée, cible intacte", () => {
  const ws = join(home, "ws-sidecar-link");
  mkdirSync(ws);
  const target = join(home, "secret-sidecar.json");
  writeFileSync(target, "do-not-touch\n");
  const sidecar = join(ws, "cogitator.board.json");
  symlinkSync(target, sidecar);

  assert.throws(
    () => atomicWriteJson(sidecar, { version: 2, extras: { pwn: true } }),
    /lien symbolique|fichier régulier/,
  );

  assert.equal(readFileSync(target, "utf8"), "do-not-touch\n");
  assert.equal(lstatSync(sidecar).isSymbolicLink(), true);
});

test("atomicWriteJson : .bak lien symbolique → écriture refusée, cible intacte", () => {
  const ws = join(home, "ws-bak-link");
  mkdirSync(ws);
  const target = join(home, "secret-bak.json");
  writeFileSync(target, "do-not-touch\n");
  const sidecar = join(ws, "cogitator.board.json");
  writeFileSync(sidecar, JSON.stringify({ version: 2, extras: { keep: true } }) + "\n");
  symlinkSync(target, `${sidecar}.bak`);

  assert.throws(
    () => atomicWriteJson(sidecar, { version: 2, extras: { pwn: true } }),
    /lien symbolique|fichier régulier/,
  );

  assert.equal(readFileSync(target, "utf8"), "do-not-touch\n");
  assert.equal(lstatSync(`${sidecar}.bak`).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(sidecar, "utf8")), { version: 2, extras: { keep: true } });
});

test("atomicWriteJson : sidecar régulier s'écrit comme avant, avec son .bak", () => {
  const ws = join(home, "ws-regular");
  mkdirSync(ws);
  const sidecar = join(ws, "cogitator.board.json");
  const previous = { version: 2, extras: { old: true } };
  writeFileSync(sidecar, JSON.stringify(previous, null, 2) + "\n");

  const next = { version: 2, extras: { next: true } };
  atomicWriteJson(sidecar, next);

  assert.equal(lstatSync(sidecar).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(readFileSync(sidecar, "utf8")), next);
  assert.equal(lstatSync(`${sidecar}.bak`).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(readFileSync(`${sidecar}.bak`, "utf8")), previous);
});
