import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedPackages, PackageManager, parseCatalog } from "../src/packages.js";
import { getPaths } from "../src/paths.js";

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "cog-packages-"));
  const paths = getPaths({ HOME: home, COGITATOR_HOME: home });
  mkdirSync(paths.piAgentDir, { recursive: true });
  writeFileSync(join(paths.piAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:@gotgenes/pi-subagents@25.0.5", { source: "npm:other@1.0.0", extensions: [] }, "/local/extension"] }));
  return paths;
};
test("catalog parses official cards as plain text, rejecting executable package names", () => {
  const result = parseCatalog(`<form class="packages-action-bar"></form><article data-package-name="@scope/pkg"><p class="packages-desc">Tools &amp; skills &lt;b&gt;safe&lt;/b&gt;</p><span data-type="extension"></span></article><article data-package-name="--evil"><p class="packages-desc">bad</p></article>`);
  assert.deepEqual(result.packages, [{ name: "@scope/pkg", description: "Tools & skills <b>safe</b>", types: ["extension"] }]);
  assert.throws(() => parseCatalog("<h1>Maintenance</h1>"));
});
test("installed packages are profile scoped and preserve exact pinned source and resource filters", () => {
  const paths = fixture();
  assert.deepEqual(installedPackages(paths).map(p => [p.name, p.removable]), [["@gotgenes/pi-subagents", true], ["other", true], ["/local/extension", false]]);
  assert.deepEqual(installedPackages(getPaths({ HOME: join(paths.home, "other") })), []);
});
test("removal uses the installed source, serializes changes, and reports busy sessions", async () => {
  const paths = fixture(); let release!: () => void; const calls: unknown[] = [];
  const manager = new PackageManager(paths, async () => 2, async (...args) => { calls.push(args); await new Promise<void>(r => { release = r; }); });
  const op = manager.start("@gotgenes/pi-subagents", "remove");
  assert.equal(op.status, "running");
  assert.throws(() => manager.start("other", "remove"), /déjà/);
  assert.deepEqual(calls, [["remove", "npm:@gotgenes/pi-subagents@25.0.5", paths]]);
  release(); await new Promise(r => setImmediate(r));
  assert.equal(op.status, "done"); assert.equal(op.deferred, 2);
});
test("rejects arbitrary commands and missing removals without invoking pi", async () => {
  let calls = 0; const manager = new PackageManager(fixture(), async () => 0, async () => { calls++; });
  for (const name of ["--flag", "https://evil.test", "pkg;echo", "../pkg", "npm:pkg", "$(id)"]) assert.throws(() => manager.start(name, "install"));
  const op = manager.start("absent", "remove"); await new Promise(r => setImmediate(r));
  assert.equal(op.status, "error"); assert.equal(calls, 0);
});

test("installation validates registry metadata, pins the resolved version and uses the service profile", async () => {
  const original = globalThis.fetch;
  const paths = fixture(); const calls: unknown[] = [];
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "test-extension", version: "1.2.3", keywords: ["pi-package"] }));
    const manager = new PackageManager(paths, async () => 0, async (...args) => { calls.push(args); });
    const op = manager.start("test-extension", "install");
    for (let i = 0; i < 10 && op.status === "running"; i++) await new Promise(r => setImmediate(r));
    assert.equal(op.status, "done");
    assert.deepEqual(calls, [["install", "npm:test-extension@1.2.3", paths]]);
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "test-extension", version: "1.2.3", keywords: [] }));
    const rejected = manager.start("test-extension", "install");
    for (let i = 0; i < 10 && rejected.status === "running"; i++) await new Promise(r => setImmediate(r));
    assert.equal(rejected.status, "error"); assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});
