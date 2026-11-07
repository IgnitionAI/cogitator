import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { findPackageRoot } from "../src/default-agent.js";
import { currentMcpServers, runtimeIntegration } from "../src/project-setup.js";
test("bundled MCP uses the current runtime without overwriting custom servers", () => {
  const root = findPackageRoot()!;
  const own = { name: "cogitator", command: "node", args: [join(root, "dist/src/mcp-server.js")] };
  const custom = { name: "custom", command: "custom-command", args: ["script"] };
  const result = currentMcpServers([own, custom]);
  assert.equal(result[0]!.command, process.execPath);
  assert.deepEqual(result[0]!.args, [runtimeIntegration().server]);
  assert.equal(result[1], custom);
  assert.ok(runtimeIntegration().extension.endsWith("dist/extensions/index.js"));
});
