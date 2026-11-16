import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js";
import { getPaths } from "../src/paths.js";
import { createApp } from "../src/server.js";
import { PiPool } from "../src/pool.js";
import { applyAgent } from "../src/agents.js";
import { buildArgs } from "../src/spawn.js";
import { importFromDir, importFromGitHub, importSkills, runSkillCommand } from "../src/skills-import.js";

const home = mkdtempSync(join(tmpdir(), "cog-host-import-"));
const piDir = join(home, "pi-agent");
mkdirSync(join(piDir, "agents"), { recursive: true });
mkdirSync(join(home, "skills"), { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = join(piDir, "agents");
process.env.COGITATOR_SKILLS_DIRS = join(home, "skills");
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));

function probePackage(marker: string): string {
  const dir = mkdtempSync(join(home, "probe-pkg-"));
  writeFileSync(join(dir, "write-marker.cjs"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "skill-import-probe",
    version: "0.0.0",
    scripts: { preinstall: "node write-marker.cjs" },
  }));
  return dir;
}

function wrapBins(marker: string): string {
  const dir = mkdtempSync(join(home, "wrap-bin-"));
  writeFileSync(join(dir, "npm"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(dir, "npx"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
  return dir;
}

function makeSkill(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: probe\n---\n# ${name}\n`);
  return dir;
}

const { db } = openDb(join(home, "cogitator.db"));
const agentA = randomUUID();
const agentB = randomUUID();
const convA = randomUUID();
const convB = randomUUID();
for (const [id, name] of [[agentA, "allowed"], [agentB, "other"]] as const) {
  db.prepare("INSERT INTO agent_preset(id,slug,name,provider,model) VALUES (?,?,?,?,?)").run(id, name, name, "openai", "gpt-5.4");
}
db.prepare("INSERT INTO conversation(id,agent_id,provider,model,spawn_args,status) VALUES (?,?,?,?,?,?)").run(convA, agentA, "openai", "gpt-5.4", "{}", "idle");
db.prepare("INSERT INTO conversation(id,agent_id,provider,model,spawn_args,status) VALUES (?,?,?,?,?,?)").run(convB, agentB, "openai", "gpt-5.4", "{}", "idle");

const pool = new PiPool({ factory: () => ({ start: async () => {}, stop: async () => {}, onEvent: () => () => {}, getState: async () => ({}), prompt: async () => ({}), abort: async () => {}, setModel: async () => ({}) }) });
const server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: 3, paths: getPaths(), pool });
let base = "";
let origin = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  origin = base;
});

after(() => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("MCP / appel sans origine navigateur : npx/npm refusé en local et n'exécute pas de script", async () => {
  const marker = join(home, "pwned-mcp");
  const bins = wrapBins(marker);
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${bins}:${previousPath}`;
  try {
    const res = await fetch(`${base}/api/skills/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "npx --yes skill-import-probe" }),
    });
    const body = await res.json() as { error?: string };
    assert.equal(res.status, 400);
    assert.match(body.error ?? "", /humaine|interface/i);
    assert.doesNotMatch(body.error ?? "", /désactivé en mode distant|aucun skill nouveau/);
    assert.equal(existsSync(marker), false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("outil MCP : la source commande est refusée avant tout appel HTTP", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/mcp-server.ts"), "utf8");
  assert.match(src, /skillCommandSource/);
  assert.doesNotMatch(src, /npx aiblueprint/);
});

test("UI humaine (Origin du panneau) : commande possible, scripts npm ignorés", async () => {
  const marker = join(home, "pwned-ui");
  const pkg = probePackage(marker);
  const res = await fetch(`${base}/api/skills/import`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ source: `npm install ${pkg}` }),
  });
  const body = await res.json() as { error?: string; imported?: string[] };
  assert.ok(res.status === 200 || res.status === 400, JSON.stringify(body));
  assert.doesNotMatch(body.error ?? "", /humaine|interface/i);
  assert.equal(existsSync(marker), false);
});

test("runSkillCommand force --ignore-scripts : un preinstall ne s'exécute pas", async () => {
  const marker = join(home, "pwned-cli");
  const pkg = probePackage(marker);
  const empty = join(home, "empty-cli-skills");
  mkdirSync(empty, { recursive: true });
  const r = await runSkillCommand(`npm install ${pkg}`, [empty], 30_000);
  assert.equal(existsSync(marker), false);
  assert.equal(r.imported.length, 0);
  const pkgJson = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8");
  assert.doesNotMatch(pkgJson, /skill-import-probe/);
});

test("importSkills refuse une source commande sans autorisation humaine", async () => {
  const marker = join(home, "pwned-direct");
  const bins = wrapBins(marker);
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${bins}:${previousPath}`;
  try {
    const r = await importSkills("npx --yes skill-import-probe", join(home, "dest-cmd"));
    assert.match(r.error ?? "", /humaine|interface/i);
    assert.doesNotMatch(r.error ?? "", /aucun skill nouveau/);
    assert.equal(existsSync(marker), false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("extraction d'archive : un lien symbolique est refusé et n'est pas recopié", async () => {
  const repo = join(home, "gh-symlink");
  makeSkill(repo, "from-link");
  const outside = join(home, "outside-secret.txt");
  writeFileSync(outside, "SECRET");
  symlinkSync(outside, join(repo, "from-link", "leak"));
  const tgz = join(home, "gh-symlink.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", home, "gh-symlink"]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(readFileSync(tgz), { status: 200 })) as typeof fetch;
  try {
    const dest = join(home, "dest-symlink");
    const r = await importFromGitHub("owner/skills-probe", dest);
    assert.match(r.error ?? "", /symbolique|symlink/i);
    assert.equal(r.imported.length, 0);
    assert.equal(existsSync(join(dest, "from-link", "leak")), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("importFromDir refuse un skill qui contient un lien symbolique", () => {
  const src = join(home, "src-link");
  makeSkill(src, "alpha");
  symlinkSync(join(home, "skills"), join(src, "alpha", "out"));
  assert.throws(() => importFromDir(src, join(home, "dest-link")), /symbolique|symlink/i);
});

test("conversationId du corps est ignoré : l'identité agent vient de l'en-tête du transport", async () => {
  const created = await fetch(`${base}/api/browser/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name: "Marketing", agentIds: [agentA] }),
  });
  const createdBody = await created.json() as { id?: string; error?: string };
  assert.equal(created.status, 200, JSON.stringify(createdBody));
  const profileId = createdBody.id;

  const forged = await fetch(`${base}/api/browser/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cogitator-conversation-id": convB },
    body: JSON.stringify({ conversationId: convA }),
  });
  const forgedBody = await forged.json() as { profiles?: Array<{ id: string }>; error?: string };
  assert.equal(forged.status, 200, JSON.stringify(forgedBody));
  assert.deepEqual(forgedBody.profiles ?? [], []);

  const trusted = await fetch(`${base}/api/browser/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cogitator-conversation-id": convA },
    body: JSON.stringify({ conversationId: convB }),
  });
  const trustedBody = await trusted.json() as { profiles?: Array<{ id: string }> };
  assert.equal(trusted.status, 200, JSON.stringify(trustedBody));
  assert.equal(trustedBody.profiles?.[0]?.id, profileId);

  const bodyOnly = await fetch(`${base}/api/browser/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: convA }),
  });
  assert.equal(bodyOnly.status, 400);
});

test("front-matter des subagents est échappé (pas d'injection de clés YAML)", () => {
  const paths = getPaths();
  applyAgent(paths, {
    id: randomUUID(),
    slug: "probe",
    name: "Probe",
    description: "",
    provider: "openai",
    model: "gpt-5.4",
    thinking: null,
    system_prompt: "",
    skills: [],
    tools_allowlist: null,
    mcp_servers: [],
    created_at: "",
    updated_at: "",
    subagents: [{
      id: randomUUID(),
      name: "reviewer",
      description: `ok"\nkind: injected\n---\n`,
      provider: "openai",
      model: "gpt-5.4",
      thinking: null,
      system_prompt: "corps",
      skills: [],
      mcp_servers: [],
    }],
  });
  const md = readFileSync(join(paths.piAgentsDir, "noo-probe-reviewer.md"), "utf8");
  assert.match(md, /^---\nname: /);
  assert.doesNotMatch(md, /^kind: injected$/m);
  assert.match(md, /description: ".*kind: injected.*"/);
});

test("fichier de prompt spawn écrit en 0600", () => {
  const dir = join(home, "prompt-mode");
  mkdirSync(dir, { recursive: true });
  buildArgs({ provider: "openai", model: "gpt-5.4", systemPrompt: "secret-scope" }, dir, convA);
  const file = join(dir, `${convA}.prompt.md`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!lstatSync(file).isSymbolicLink());
});
