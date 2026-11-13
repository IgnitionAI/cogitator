import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mcpAgentPath,
  mcpConversationsListPath,
  mcpPathIdSchema,
  mcpSchedulePath,
  mcpWorkspacePath,
} from "../src/mcp-server.js";

/** Identifiants persistés : `crypto.randomUUID()` (agents, workspaces, cron, conversations). */
const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";

test("un identifiant contenant /, .., ? ou # est refusé par le schéma", () => {
  for (const id of ["a/b", "..", "?", "#", "../api/health", "id?x=1", "id#frag", `${VALID_ID}/../health`]) {
    assert.throws(() => mcpPathIdSchema.parse(id), /UUID|uuid|identifiant/i, id);
  }
  assert.equal(mcpPathIdSchema.parse(VALID_ID), VALID_ID);
});

test("un identifiant valide appelle exactement la route attendue", () => {
  const encoded = encodeURIComponent(VALID_ID);
  assert.equal(mcpAgentPath(VALID_ID), `/api/agents/${encoded}`);
  assert.equal(mcpAgentPath(VALID_ID, "/validate"), `/api/agents/${encoded}/validate`);
  assert.equal(mcpAgentPath(VALID_ID, "/default"), `/api/agents/${encoded}/default`);
  assert.equal(mcpSchedulePath(VALID_ID), `/api/schedules/${encoded}`);
  assert.equal(mcpSchedulePath(VALID_ID, "/run"), `/api/schedules/${encoded}/run`);
  assert.equal(mcpSchedulePath(VALID_ID, "/runs"), `/api/schedules/${encoded}/runs`);
  assert.equal(mcpWorkspacePath(VALID_ID), `/api/workspaces/${encoded}`);
});

test("workspace_id est encodé dans la chaîne de requête", () => {
  assert.match(mcpConversationsListPath.toString(), /encodeURIComponent/);
  assert.equal(mcpConversationsListPath(), "/api/conversations");
  assert.equal(
    mcpConversationsListPath(VALID_ID),
    `/api/conversations?workspace_id=${encodeURIComponent(VALID_ID)}`,
  );
  const parsed = new URL(mcpConversationsListPath(VALID_ID), "http://cogitator.local");
  assert.equal(parsed.pathname, "/api/conversations");
  assert.equal(parsed.searchParams.get("workspace_id"), VALID_ID);
  assert.equal([...parsed.searchParams.keys()].join(","), "workspace_id");
});
