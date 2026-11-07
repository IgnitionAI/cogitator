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

test("catalog follows only same-origin canonical redirects and preserves pagination", async () => {
  const { catalog } = await import("../src/packages.js");
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: "/packages?type=extension" } }) : new Response('<form class="packages-action-bar"></form><a href="/packages?type=extension&amp;page=2">2</a>');
    assert.equal((await catalog("", "extension", 1)).hasNext, true);
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
    await assert.rejects(() => catalog("", "extension", 1), /externe/);
  } finally { globalThis.fetch = original; }
});

test("updates replace a pinned npm source with the newer exact version and never downgrade", async () => {
  const original = globalThis.fetch; const paths = fixture(); const calls: unknown[] = [];
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "@gotgenes/pi-subagents", version: "25.0.6", keywords: ["pi-package"] }));
    const manager = new PackageManager(paths, async () => 1, async (...args) => { calls.push(args); });
    const op = manager.start("@gotgenes/pi-subagents", "update");
    while (op.status === "running") await new Promise(r => setImmediate(r));
    assert.equal(op.status, "done"); assert.equal(op.deferred, 1);
    assert.deepEqual(calls, [["install", "npm:@gotgenes/pi-subagents@25.0.6", paths]]);
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "@gotgenes/pi-subagents", version: "25.0.4", keywords: ["pi-package"] }));
    const older = manager.start("@gotgenes/pi-subagents", "update");
    while (older.status === "running") await new Promise(r => setImmediate(r));
    assert.equal(older.status, "done"); assert.equal(calls.length, 1);
    const missing = manager.start("missing", "update");
    while (missing.status === "running") await new Promise(r => setImmediate(r));
    assert.equal(missing.status, "error"); assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});
test("version checks use installed manifests instead of ranges and report registry failures", async () => {
  const { packageUpdates, newerVersion } = await import("../src/packages.js");
  const paths = fixture();
  mkdirSync(join(paths.piAgentDir, "npm/node_modules/other"), { recursive: true });
  writeFileSync(join(paths.piAgentDir, "npm/node_modules/other/package.json"), JSON.stringify({ name: "other", version: "2.0.0" }));
  assert.equal(installedPackages(paths).find(p => p.name === "other")?.version, "2.0.0");
  assert.equal(newerVersion("2.0.0", "10.0.0"), false);
  assert.equal(newerVersion("1.10.0", "1.9.0"), true);
  assert.equal(newerVersion("1.0.0", "^1.0.0"), false);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async url => String(url).includes("other") ? new Response(JSON.stringify({ name: "other", version: "2.1.0" })) : new Response("unavailable", { status: 503 });
    const updates = await packageUpdates(paths);
    assert.equal(updates.find(p => p.name === "other")?.available, true);
    assert.equal(updates.find(p => p.name === "@gotgenes/pi-subagents")?.failed, true);
    assert.equal(updates.length, 2);
    writeFileSync(join(paths.piAgentDir, "npm/node_modules/other/package.json"), JSON.stringify({ version: "2.0.0-beta.1" }));
    assert.equal((await packageUpdates(paths)).find(p => p.name === "other")?.failed, true);
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "other", version: "2.1.0", keywords: ["pi-package"] }));
    let invoked = false;
    const manager = new PackageManager(paths, async () => 0, async () => { invoked = true; });
    const op = manager.start("other", "update");
    while (op.status === "running") await new Promise(r => setImmediate(r));
    assert.equal(op.status, "error"); assert.equal(invoked, false);
  } finally { globalThis.fetch = original; }
});
