import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSubagentTranscript, tasksDirFor } from "../src/subagents.js";
const line = (value: unknown) => JSON.stringify(value) + "\n";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cog-subchat-"));
  const parent = join(home, "parent.jsonl");
  writeFileSync(parent, line({ type: "session", id: "parent" }));
  mkdirSync(tasksDirFor(parent), { recursive: true });
  return { home, parent, child: join(tasksDirFor(parent), "not-the-session-id.jsonl") };
}
test("reads a verified child by header id, joins tool results, and observes appended replies", () => {
  const f = fixture();
  writeFileSync(f.child, line({ type: "session", id: "child", parentSession: "parent" }) + line({ type: "message", message: { role: "user", content: "Mission" } }) + line({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "fixture" } }] } }) + line({ type: "message", message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "result" }] } }));
  const initial = readSubagentTranscript(f.parent, "child")!;
  assert.equal(initial.subagent.status, "working");
  assert.equal(initial.entries[1]?.type, "tool");
  assert.equal((initial.entries[1] as { result: string }).result, "result");
  appendFileSync(f.child, line({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } }));
  assert.equal(readSubagentTranscript(f.parent, "child")!.subagent.status, "done");
  assert.equal(readSubagentTranscript(f.parent, "../child"), null);
});
test("refuses foreign parents and symlinked files or task directories", () => {
  const f = fixture();
  writeFileSync(f.child, line({ type: "session", id: "foreign", parentSession: "other" }));
  assert.equal(readSubagentTranscript(f.parent, "foreign"), null);
  const outside = join(f.home, "outside.jsonl");
  writeFileSync(outside, line({ type: "session", id: "outside", parentSession: "parent" }));
  symlinkSync(outside, join(tasksDirFor(f.parent), "linked.jsonl"));
  assert.equal(readSubagentTranscript(f.parent, "outside"), null);
  const p2 = join(f.home, "second.jsonl"); writeFileSync(p2, line({ type: "session", id: "parent" }));
  mkdirSync(join(f.home, "second")); symlinkSync(tasksDirFor(f.parent), tasksDirFor(p2));
  assert.equal(readSubagentTranscript(p2, "foreign"), null);
});
test("bounds the transcript and reports truncated history, ignoring incomplete writes", () => {
  const f = fixture();
  writeFileSync(f.child, line({ type: "session", id: "long", parentSession: "parent" }) + Array.from({ length: 305 }, (_, i) => line({ type: "message", message: { role: "user", content: String(i) } })).join("") + '{"type":');
  const result = readSubagentTranscript(f.parent, "long")!;
  assert.equal(result.entries.length, 300); assert.equal(result.truncated, true);
});
