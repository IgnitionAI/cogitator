import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { createAgent } from "../src/agents.js";
import { insertGroup, listGroupMembers } from "../src/groups.js";
import { createConversation } from "../src/conversations.js";

test("listGroupMembers : JSON pending_configuration invalide ne jette pas", () => {
  const dir = mkdtempSync(join(tmpdir(), "cog-grpjson-"));
  const opened = openDb(join(dir, "cogitator.db"));
  try {
    const agent = createAgent(opened.db, {
      name: "Bot JSON",
      provider: "openai",
      model: "gpt-5.4",
      system_prompt: "",
      skills: [],
      mcp_servers: [],
    });
    const group = insertGroup(opened.db, { name: "g", memberAgentIds: [agent.id], hostAgentId: agent.id });
    createConversation(opened.db, {
      agentId: agent.id,
      groupId: group.id,
      spawn: { provider: "openai", model: "gpt-5.4" },
    });
    opened.db.prepare("UPDATE conversation SET pending_configuration = ? WHERE group_id = ?").run("{not-json", group.id);
    const members = listGroupMembers(opened.db, group.id);
    assert.equal(members.length, 1);
    assert.equal(members[0]!.pending_configuration, null);
  } finally {
    opened.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
