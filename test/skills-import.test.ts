import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const { scanSkillDirs, importFromDir, importFromGitHub, parseGitHubRepo, sanitizeSkillName, importSkills, runSkillCommand } = await import("../src/skills-import.js");

const home = mkdtempSync(join(tmpdir(), "cog-skillimp-"));

function makeSkill(root: string, name: string, desc = "Un skill de test"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
  return dir;
}

test("scanSkillDirs : détecte SKILL.md à la racine et profondeur 2, ignore node_modules", () => {
  const repo = join(home, "repo-a");
  makeSkill(repo, "skill-root");
  makeSkill(join(repo, "pack"), "skill-nested");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "SKILL.md"), "---\nnname: x\n---\n");
  mkdirSync(join(repo, "vide"), { recursive: true });

  const found = scanSkillDirs(repo).map((d) => d.split("/").pop());
  assert.deepEqual(found.sort(), ["skill-nested", "skill-root"]);
});

test("importFromDir : copie, skip les existants, overwrite optionnel", () => {
  const src = join(home, "src-import");
  const dest = join(home, "dest-skills");
  makeSkill(src, "alpha");
  makeSkill(src, "beta");

  const r1 = importFromDir(src, dest);
  assert.deepEqual(r1.imported.sort(), ["alpha", "beta"]);
  assert.equal(existsSync(join(dest, "alpha", "SKILL.md")), true);

  // modifie la source, réimport sans overwrite → skip
  makeSkill(src, "alpha", "version 2");
  const r2 = importFromDir(src, dest);
  assert.deepEqual(r2.skipped.sort(), ["alpha", "beta"]);
  assert.match(readSkill(dest, "alpha"), /Un skill de test/); // ancienne version conservée

  const r3 = importFromDir(src, dest, true);
  assert.equal(r3.imported.length, 2);
  assert.match(readSkill(dest, "alpha"), /version 2/);
});

test("parseGitHubRepo : les formes courantes", () => {
  assert.deepEqual(parseGitHubRepo("https://github.com/IgnitionAI/skills"), { owner: "IgnitionAI", repo: "skills" });
  assert.deepEqual(parseGitHubRepo("IgnitionAI/skills"), { owner: "IgnitionAI", repo: "skills" });
  assert.deepEqual(parseGitHubRepo("git@github.com:IgnitionAI/skills.git"), { owner: "IgnitionAI", repo: "skills" });
  assert.deepEqual(parseGitHubRepo("https://github.com/o/r/tree/main/sub"), { owner: "o", repo: "r" });
  assert.equal(parseGitHubRepo("pas un repo"), null);
});

test("sanitizeSkillName : pas de traversal, kebab propre", () => {
  assert.equal(sanitizeSkillName("../evil"), "evil");
  assert.equal(sanitizeSkillName("Mon Skill v2!"), "Mon-Skill-v2");
});

test("importFromGitHub : tarball local via tar système (stub du download non nécessaire — archive réelle créée par tar)", async () => {
  // construit un vrai .tar.gz d'un repo-skill via le tar système
  const repo = join(home, "gh-repo");
  makeSkill(repo, "from-gh");
  const tgz = join(home, "gh-repo.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", home, "gh-repo"]);

  // on patche fetch pour servir le tarball local (même code path que le réseau)
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(readFileSync(tgz), { status: 200 })) as typeof fetch;
  try {
    const dest = join(home, "dest-gh");
    const r = await importFromGitHub("IgnitionAI/skills", dest);
    assert.deepEqual(r.imported, ["from-gh"]);
    assert.equal(existsSync(join(dest, "from-gh", "SKILL.md")), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("importSkills : source inconnue → erreur propre", async () => {
  const r = await importSkills("/chemin/qui/nexiste/pas", join(home, "x"));
  assert.ok(r.error);
  assert.equal(r.imported.length, 0);
});

test("runSkillCommand : garde npx/npm uniquement", async () => {
  const refused = await runSkillCommand("rm -rf /", [join(home, "x")]);
  assert.match(refused.error ?? "", /seuls npx et npm/);
});

test("runSkillCommand : npm --version s'exécute, aucun skill nouveau → rapport avec sortie", async () => {
  const empty = join(home, "empty-skills");
  mkdirSync(empty, { recursive: true });
  const r = await runSkillCommand("npm --version", [empty], 30_000);
  assert.equal(r.imported.length, 0);
  assert.ok(r.error);
  assert.match(r.error, /sortie:/);
});

function readSkill(dest: string, name: string): string {
  return readFileSync(join(dest, name, "SKILL.md"), "utf8");
}

test.after(() => rmSync(home, { recursive: true, force: true }));
