import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEntries } from "../src/history.js";
import { readFileEvents } from "../src/file-changes.js";

test("transcript previews preserve content and use language-neutral truncation and missing-name metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "cogitator-i18n-"));
  try {
    const file = join(dir, "session.jsonl");
    const content = "Texte utilisateur (tronqué)\n" + "x".repeat(5000);
    const rows = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: content }] } },
      { type: "message", timestamp: "2026-05-01T00:00:00Z", message: { role: "assistant", content: [
        { type: "toolCall", id: "unknown", arguments: content },
        { type: "toolCall", id: "write", name: "write", arguments: { path: "file.txt", content } },
      ] } },
      { type: "message", message: { role: "toolResult", toolCallId: "write", content: [{ type: "text", text: content }] } },
    ];
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
    const entries = readEntries(file);
    assert.equal(entries[0]?.type, "user");
    assert.equal(entries[0] && "text" in entries[0] ? entries[0].text : "", content);
    const unnamed = entries.find((entry) => entry.type === "tool" && entry.id === "unknown");
    assert.ok(unnamed?.type === "tool");
    assert.equal(unnamed.name, "");
    assert.equal(unnamed.args, content.slice(0, 4000) + "\n…");
    const tool = entries.find((entry) => entry.type === "tool" && entry.id === "write");
    assert.ok(tool?.type === "tool");
    assert.equal(tool.result, content.slice(0, 4000) + "\n…");
    assert.equal(readFileEvents(file)[0]?.hunks[0]?.new, content.slice(0, 3000) + "\n…");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
