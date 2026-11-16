import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionLines } from "../src/session-lines.js";

test("readSessionLines : dernières lignes non vides", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-sesslines-"));
  const file = join(dir, "session.jsonl");
  try {
    writeFileSync(file, `{"n":1}\n\n{"n":2}\n{"n":3}\n`);
    assert.deepEqual(readSessionLines(file, 2), ['{"n":2}', '{"n":3}']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSessionLines : plafond d'octets — ne relit pas le fichier entier", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-sesscap-"));
  const file = join(dir, "session.jsonl");
  try {
    const rows = Array.from({ length: 200 }, (_, i) => `LINE-${String(i).padStart(3, "0")}-${"y".repeat(80)}`);
    writeFileSync(file, `${rows.join("\n")}\n`);
    const got = readSessionLines(file, 200, 400);
    assert.ok(got.length < 20, `fenêtre d'octets trop large : ${got.length} lignes`);
    assert.ok(got.at(-1)?.startsWith("LINE-199"));
    assert.ok(!got.some((line) => line.startsWith("LINE-000")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
