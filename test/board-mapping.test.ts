import assert from "node:assert/strict";
import { test } from "node:test";
const { statusFromIssue, priorityFromIssue } = await import("../src/board.js");

const mk = (state: string, labels: string[]) => ({
  number: 1, title: "t", body: "", state: state as "OPEN" | "CLOSED",
  labels: labels.map((name) => ({ name })), url: "", createdAt: "", updatedAt: "",
});

test("mapping colonnes : labels status + état clos", () => {
  assert.equal(statusFromIssue(mk("OPEN", ["status:backlog"])), "backlog");
  assert.equal(statusFromIssue(mk("OPEN", ["status:in_progress", "bug"])), "in_progress");
  assert.equal(statusFromIssue(mk("OPEN", ["bug"])), "todo"); // défaut
  assert.equal(statusFromIssue(mk("CLOSED", [])), "done"); // clos sans label → terminé
  assert.equal(statusFromIssue(mk("CLOSED", ["status:canceled"])), "canceled");
});

test("mapping priorité : labels priority, défaut medium", () => {
  assert.equal(priorityFromIssue(mk("OPEN", ["priority:urgent"])), "urgent");
  assert.equal(priorityFromIssue(mk("OPEN", ["priority:low"])), "low");
  assert.equal(priorityFromIssue(mk("OPEN", [])), "medium");
});
