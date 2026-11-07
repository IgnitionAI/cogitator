import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importSkillUpload } from "../src/skills-upload.js";
const file = (path: string, content: string) => ({ path, content: Buffer.from(content).toString("base64") });
const skill = file("library/review/SKILL.md", "---\nname: review\ndescription: Review changes\n---\nRead the references first.");
test("directory upload preserves references and existing skills", () => {
  const dest = mkdtempSync(join(tmpdir(), "skills-upload-"));
  assert.deepEqual(importSkillUpload([skill, file("library/review/references/example.md", "example")], dest), { imported: ["review"], skipped: [] });
  assert.equal(readFileSync(join(dest, "review/references/example.md"), "utf8"), "example");
  assert.deepEqual(importSkillUpload([skill], dest), { imported: [], skipped: ["review"] });
});
test("directory upload rejects traversal, hidden files, conflicts and oversized payloads before importing", () => {
  const dest = mkdtempSync(join(tmpdir(), "skills-upload-invalid-"));
  for (const path of ["../escape", "/absolute", "folder/../escape", "folder\\escape", "folder/.env"]) assert.throws(() => importSkillUpload([skill, file(path, "bad")], dest));
  assert.throws(() => importSkillUpload([skill, skill], dest));
  assert.throws(() => importSkillUpload([skill, file("library/review/big", "x".repeat(6 * 1024 * 1024))], dest));
  assert.throws(() => importSkillUpload([file("folder/SKILL.md", "invalid")], dest));
  assert.equal(existsSync(join(dest, "review")), false);
});
