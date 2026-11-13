import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { FakeConfiguration } from "./fixtures/fake-configuration.js";

// Environnement injecté : jamais la vraie base ~/.cogitator.
const home = mkdtempSync(join(tmpdir(), "cog-gitimp-"));
const piDir = join(home, "pi-agent");
mkdirSync(join(piDir, "agents"), { recursive: true });
mkdirSync(join(home, "skills"), { recursive: true });
process.env.COGITATOR_HOME = home;
process.env.COGITATOR_PI_AGENT_DIR = piDir;
process.env.COGITATOR_AGENTS_DIR = join(piDir, "agents");
process.env.COGITATOR_SKILLS_DIRS = join(home, "skills");
writeFileSync(join(piDir, "models-store.json"), JSON.stringify({ openai: { models: [{ id: "gpt-5.4" }] } }));

const { normalizeGitUrl, localDirFor, cloneRepo, gitErrorDetail, isInsideDir } = await import("../src/git-import.js");
const { openDb } = await import("../src/db.js");
const { getPaths } = await import("../src/paths.js");
const { createApp } = await import("../src/server.js");
const { PiPool } = await import("../src/pool.js");
const { setConversationStatus } = await import("../src/conversations.js");
const { localizeText, getLocale, setLocale } = await import("../web/src/i18n.js");

class FakeClient {
  configuration = new FakeConfiguration(() => this.opts.args);
  getAvailableModels() { return this.configuration.getAvailableModels(); }
  getAvailableThinkingLevels() { return this.configuration.getAvailableThinkingLevels(); }
  setThinkingLevel(level: Parameters<FakeConfiguration["setThinkingLevel"]>[0]) { return this.configuration.setThinkingLevel(level); }
  sessionFile = `/fake/sessions/${Math.random()}.jsonl`;
  constructor(public opts: { cwd: string; args: string[] }) {}
  async start() {}
  async stop() {}
  onEvent() { return () => {}; }
  async getState() { return { ...await this.configuration.getState(), sessionFile: this.sessionFile, isStreaming: false }; }
  async prompt() { return {}; }
  async abort() {}
  async setModel(provider: string, id: string) { return this.configuration.setModel(provider, id); }
}

const root = () => getPaths().projectsDir;

function makeLocalRepo(name: string): string {
  const src = join(home, "srcs", name);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "README.md"), `# ${name}\n`);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: src, stdio: ["ignore", "ignore", "ignore"] });
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  return src;
}

// ---------- Unités : normalisation, destination, clone ----------

test("getPaths : COGITATOR_PROJECTS_DIR prime la racine par défaut (D1bis)", () => {
  const custom = join(home, "projets-custom");
  process.env.COGITATOR_PROJECTS_DIR = custom;
  try {
    assert.equal(getPaths().projectsDir, custom);
  } finally {
    delete process.env.COGITATOR_PROJECTS_DIR;
  }
  assert.equal(getPaths().projectsDir, join(home, "projects")); // défaut restauré
});

test("normalizeGitUrl : owner/repo → https://github.com/owner/repo (D3, S1)", () => {
  assert.equal(normalizeGitUrl("octocatz/helloworldz"), "https://github.com/octocatz/helloworldz");
  assert.equal(normalizeGitUrl("  octocatz/helloworldz  "), "https://github.com/octocatz/helloworldz");
});

test("normalizeGitUrl : conserve https, ssh et chemins locaux (D1)", () => {
  assert.equal(normalizeGitUrl("https://github.com/o/r"), "https://github.com/o/r");
  assert.equal(normalizeGitUrl("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(normalizeGitUrl("ssh://git@github.com/o/r.git"), "ssh://git@github.com/o/r.git");
  const local = join(home, "repo-local");
  mkdirSync(local);
  assert.equal(normalizeGitUrl(local), local);
});

test("normalizeGitUrl : raccourci owner/repo borné à exactement 2 segments (R1)", () => {
  // >2 segments sans schéma : conservé tel quel (le clone échouera, catalogué) — jamais
  // réécrit vers https://github.com/gitlab.com/o ni confondu avec une autre source.
  assert.equal(normalizeGitUrl("gitlab.com/o/r"), "gitlab.com/o/r");
  assert.equal(normalizeGitUrl("git.example.com/team/projet"), "git.example.com/team/projet");
  // 2 segments : le raccourci D3 s'applique toujours
  assert.equal(normalizeGitUrl("o/r"), "https://github.com/o/r");
});

test("normalizeGitUrl : rejette segments . et .., préfixe -, transports ext::/file: (S4)", () => {
  assert.equal(normalizeGitUrl("../x"), null);
  assert.equal(normalizeGitUrl("a/../b"), null);
  assert.equal(normalizeGitUrl("-x"), null);
  assert.equal(normalizeGitUrl("ext::sh -c id"), null);
});

test("localDirFor : destination stable <root>/<owner>/<repo> et source normalisée (S1, S3)", () => {
  const r = root();
  assert.deepEqual(localDirFor("https://github.com/o/r", r), { dest: join(r, "o", "r"), source: "https://github.com/o/r" });
  assert.deepEqual(localDirFor("git@github.com:o/r.git", r), { dest: join(r, "o", "r"), source: "git@github.com:o/r.git" });
  assert.deepEqual(localDirFor("octocatz/helloworldz", r), { dest: join(r, "octocatz", "helloworldz"), source: "https://github.com/octocatz/helloworldz" });
  const local = join(home, "quelque-part", "monrepo");
  assert.deepEqual(localDirFor(local, r), { dest: join(r, "monrepo"), source: local });
});

test("localDirFor : refuse segments . et .. et backslash, sans écriture (S4)", () => {
  const r = root();
  for (const hostile of ["../x", "..\\x", "a/../b", "https://github.com/../x", "https://github.com/a/../b"]) {
    const res = localDirFor(hostile, r);
    assert.ok("error" in res, hostile);
    assert.match(res.error, /^URL git invalide: /);
  }
  assert.equal(existsSync(join(home, "x")), false); // rien ne sort de la racine
});

test("cloneRepo : refuse de réutiliser un dossier venant d'une autre source (M2, critère 10)", async () => {
  const dest = join(root(), "meme-nom");
  const first = makeLocalRepo("monorepo-a");
  const second = makeLocalRepo("monorepo-b");
  assert.ok("dir" in await cloneRepo(first, dest));
  const mismatch = await cloneRepo(second, dest);
  assert.ok("error" in mismatch);
  assert.match(mismatch.error, /^dépôt différent déjà cloné à cet emplacement: /);
  // la même source est bien reprise (pas de re-clone)
  const again = await cloneRepo(first, dest);
  assert.ok("dir" in again);
  assert.equal(again.cloned, false);
});

test("cloneRepo : sources sans schéma >2 segments jamais confondues (R1, critère 10)", async () => {
  const dest = join(root(), "r1-repo");
  assert.ok("dir" in await cloneRepo(makeLocalRepo("r1-src"), dest));
  execFileSync("git", ["-C", dest, "remote", "set-url", "origin", "gitlab.com/o/r1"]);
  // même dernier segment, même hôte : deux sources DISTINCTES → refus, pas de reprise
  const other = await cloneRepo("gitlab.com/o/r2", dest);
  assert.ok("error" in other);
  assert.match(other.error, /^dépôt différent déjà cloné à cet emplacement: /);
  // la source identique (littérale) est bien reprise
  const again = await cloneRepo("gitlab.com/o/r1", dest);
  assert.ok("dir" in again);
  assert.equal(again.cloned, false);
});

test("cloneRepo : forme non-GitHub équivalente (barre oblique finale, casse d'hôte) reprise (S4, critère 10)", async () => {
  const dest = join(root(), "s4-repo");
  assert.ok("dir" in await cloneRepo(makeLocalRepo("s4-src"), dest));
  execFileSync("git", ["-C", dest, "remote", "set-url", "origin", "https://gitlab.com/a/b"]);
  for (const equivalent of ["https://gitlab.com/a/b/", "https://GITLAB.COM/a/b"]) {
    const again = await cloneRepo(equivalent, dest);
    assert.ok("dir" in again, equivalent);
    assert.equal(again.cloned, false, equivalent);
  }
});

test("cloneRepo : reprise par forme d'URL équivalente, refus d'une vraie autre source (M2, critère 10)", async () => {
  const seed = makeLocalRepo("formes-url");
  const dest = join(root(), "m2", "r"); // owner dédié : ne pas créer <root>/o (assert S5)
  assert.ok("dir" in await cloneRepo(seed, dest));
  // même dépôt désigné sous une autre forme d'URL → reprise du clone, pas de re-clone
  execFileSync("git", ["-C", dest, "remote", "set-url", "origin", "https://github.com/m2/r.git"]);
  for (const equivalent of ["https://github.com/m2/r", "git@github.com:m2/r.git", "https://github.com/m2/r.git"]) {
    const again = await cloneRepo(equivalent, dest);
    assert.ok("dir" in again, equivalent);
    assert.equal(again.cloned, false, equivalent);
  }
  // une vraie autre source reste refusée à cet emplacement
  const other = await cloneRepo("https://github.com/m2/autre", dest);
  assert.ok("error" in other);
  assert.match(other.error, /^dépôt différent déjà cloné à cet emplacement: /);
});

test("localDirFor : refuse les identifiants embarqués dans l'URL, sans les afficher (L3, D1)", () => {
  const r = root();
  for (const credentialed of ["https://user:token@github.com/o/r", "https://ghp_secret@github.com/o/r", "ssh://git:token@github.com/o/r.git"]) {
    const res = localDirFor(credentialed, r);
    assert.ok("error" in res, credentialed);
    assert.match(res.error, /^identifiants embarqués dans l'URL git refusés/);
    assert.ok(!res.error.includes("ghp_secret") && !res.error.includes("user:token")); // aucune fuite du secret
  }
  // formes ssh standard sans mot de passe : conservées (utilisateur ssh légitime)
  assert.equal(normalizeGitUrl("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(normalizeGitUrl("ssh://git@github.com/o/r.git"), "ssh://git@github.com/o/r.git");
});

test("localDirFor : forme scp-like avec jeton refusée, sans écho du secret (R3, D1)", () => {
  const r = root();
  const res = localDirFor("ghp_secretjeton@gitlab.com:o/r", r);
  assert.ok("error" in res);
  assert.match(res.error, /^identifiants embarqués dans l'URL git refusés/);
  assert.ok(!res.error.includes("secretjeton")); // aucune fuite du jeton
  // l'utilisateur scp-like standard `git` reste accepté (L3)
  assert.equal(normalizeGitUrl("git@gitlab.com:o/r.git"), "git@gitlab.com:o/r.git");
});

test("cloneRepo : jeton en utilisateur scp-like → refus catalogué sans écho (R3, D1)", async () => {
  const res = await cloneRepo("ghp_secretjeton@gitlab.com:o/r", join(root(), "o", "r"));
  assert.ok("error" in res);
  assert.match(res.error, /^URL git invalide: /);
  assert.ok(!res.error.includes("secretjeton"));
  assert.equal(existsSync(join(root(), "o")), false);
});

test("cloneRepo : clone réel d'un dépôt local (S3)", async () => {
  const src = makeLocalRepo("src-clone");
  const dest = join(root(), "src-clone");
  const res = await cloneRepo(src, dest);
  assert.ok("dir" in res);
  assert.equal(existsSync(join(dest, ".git")), true);
  assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "# src-clone\n");
});

test("cloneRepo : un lien symbolique du dépôt source n'est pas recréé (core.symlinks=false)", async () => {
  const src = join(home, "srcs", "symlink-sidecar");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "README.md"), "# symlink-sidecar\n");
  symlinkSync("/tmp/secret-outside-board.json", join(src, "cogitator.board.json"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: src, stdio: ["ignore", "ignore", "ignore"] });
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  const dest = join(root(), "symlink-sidecar");
  const res = await cloneRepo(src, dest);
  assert.ok("dir" in res);
  const planted = join(dest, "cogitator.board.json");
  assert.equal(existsSync(planted), true);
  assert.equal(lstatSync(planted).isSymbolicLink(), false);
  assert.equal(readFileSync(planted, "utf8"), "/tmp/secret-outside-board.json");
});

test("cloneRepo : échec → erreur cataloguée, aucun dossier résiduel (S3, critère 4)", async () => {
  const dest = join(root(), "repo-inexistant");
  const res = await cloneRepo(join(home, "nexiste-pas"), dest);
  assert.ok("error" in res);
  assert.match(res.error, /^clone échoué: /);
  assert.equal(existsSync(dest), false);
});

test("cloneRepo : refuse URL vide/préfixe - et masque les identifiants (S5)", async () => {
  const res = await cloneRepo("-https://user:secret@github.com/o/r", join(root(), "o", "r"));
  assert.ok("error" in res);
  assert.match(res.error, /^URL git invalide: /);
  assert.ok(res.error.includes("user:***@"));
  assert.ok(!res.error.includes("secret"));
  assert.equal(existsSync(join(root(), "o")), false);
});

test("gitErrorDetail : masque user:token sur un stderr court (S5)", () => {
  const detail = gitErrorDetail("fatal: Authentication failed for 'https://user:secret@github.com/o/r'");
  assert.ok(detail.includes("user:***@"));
  assert.ok(!detail.includes("secret"));
});

test("gitErrorDetail : masque un token en nom d'utilisateur (S5)", () => {
  const detail = gitErrorDetail("fatal: Authentication failed for 'https://ghp_secret@github.com/o/r'");
  assert.ok(!detail.includes("ghp_secret"));
  assert.ok(detail.includes("https://***@github.com/o/r"));
});

test("gitErrorDetail : masque un token en nom d'utilisateur (S5)", () => {
  const detail = gitErrorDetail("fatal: Authentication failed for 'https://ghp_secret@github.com/o/r'");
  assert.ok(!detail.includes("ghp_secret"));
  assert.ok(detail.includes("https://***@github.com/o/r"));
});

test("gitErrorDetail : masque un jeton en utilisateur scp-like, conserve git@ (R3)", () => {
  const detail = gitErrorDetail("Command failed: git clone --quiet -- ghp_secretjeton@gitlab.com:o/r /tmp/x");
  assert.ok(!detail.includes("secretjeton"));
  assert.ok(detail.includes("***@gitlab.com:o/r"));
  assert.ok(detail.includes("git clone")); // le reste du message est conservé
});

test("gitErrorDetail : tronque en conservant la queue (S5)", () => {
  const tail = "x".repeat(20);
  const detail = gitErrorDetail(`${"x".repeat(500)}${tail}`);
  assert.ok(detail.length <= 300);
  assert.ok(detail.endsWith(tail));
});

// ---------- Route POST /api/workspaces ----------

let db: Database.Database;
let dbVersion: number;
let pool: PiPool;
let server: ReturnType<typeof createApp>;
let base: string;

before(async () => {
  const opened = openDb(join(home, "cogitator.db"));
  db = opened.db;
  dbVersion = opened.version;
  pool = new PiPool({
    factory: (o) => new FakeClient(o),
    callbacks: { onStatus: (id, s) => setConversationStatus(db, id, s) },
  });
  server = createApp({ db, dbPath: join(home, "cogitator.db"), dbVersion: opened.version, paths: getPaths(), pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const postWorkspace = async (body: unknown) => {
  const res = await fetch(`${base}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> & { workspace?: { id: string; dir: string } } };
};

test("POST git_url vide : message exact catalogué (L1)", async () => {
  const res = await postWorkspace({ git_url: "" });
  assert.equal(res.status, 400);
  assert.ok((res.body.issues as string[]).some((issue) => issue.includes("git_url: URL git requise")));
});

test("POST sans source : message exact dir ou git_url requis (M3)", async () => {
  const res = await postWorkspace({ name: "rien" });
  assert.equal(res.status, 400);
  assert.ok((res.body.issues as string[]).some((issue) => issue.includes("dir ou git_url requis")));
});

test("POST dir et git_url : toujours refusé (pas les deux)", async () => {
  const res = await postWorkspace({ dir: home, git_url: "o/r" });
  assert.equal(res.status, 400);
  assert.ok((res.body.issues as string[]).some((issue) => issue.includes("fournir dir ou git_url (pas les deux)")));
});

// Une seule implémentation de la règle B1 en production : isInsideDir, utilisée par la
// route. Ces tests la couvrent ; le refus de route est testé juste en dessous.
test("isInsideDir : racine enrôlée acceptée (B1)", () => {
  assert.equal(isInsideDir(join(root(), "projects"), root()), true);
  assert.equal(isInsideDir(join(root(), "projects", "sous-dossier"), root()), true);
  assert.equal(isInsideDir(root(), root()), true);
});

test("isInsideDir : racine hors enrôlement refusée (B1)", () => {
  assert.equal(isInsideDir(join(home, "ailleurs"), root()), false);
  assert.equal(isInsideDir(join(home, "projects-bis"), root()), false); // préfixe de chaîne ≠ sous-dossier
});

// B1 bout en bout, en mode distant : refus AVANT toute écriture, puis succès dès que la
// racine est enrôlée. Le 503 AUTH_UNAVAILABLE observé plus tôt venait de cloneRepo(undefined)
// (localDirFor ne renvoyait pas encore `source`) : l'exception était convertie en 503 par
// le wrapper d'auth. Corrigé ; les deux temps sont désormais vérifiés.
test("import git : mode distant refuse AVANT le clone si racine non enrôlée (B1, critère 5)", async () => {
  const { fixture, authenticated } = await import("./native-auth-fixture.js");
  const f = await fixture();
  try {
    const { browser } = await authenticated(f); // mode protégé : session owner MFA
    const src = makeLocalRepo("b1-repo");
    const projectsDir = join(f.home, "projects");
    process.env.COGITATOR_AUTH_REQUIRED = "1";
    process.env.COGITATOR_ENROLLED_ROOTS = join(f.home, "ailleurs");
    try {
      const refused = await browser.call("/api/workspaces", { git_url: src });
      assert.equal(refused.status, 400);
      assert.match(String(refused.data.error), /^racine de clone hors des racines enrôlées: /);
      assert.equal(existsSync(projectsDir), false); // refus avant toute écriture
      // correction de la cause → le même import réussit, sans clone orphelin
      process.env.COGITATOR_ENROLLED_ROOTS = projectsDir;
      const ok = await browser.call("/api/workspaces", { git_url: src });
      assert.equal(ok.status, 201);
      // macOS : /tmp est un symlink de /private/tmp, l'enrôlement canonicalise
      assert.ok(String((ok.data.workspace as { dir: string }).dir).startsWith(realpathSync(projectsDir)));
      assert.equal(existsSync(join(projectsDir, "b1-repo", ".git")), true);
    } finally {
      delete process.env.COGITATOR_AUTH_REQUIRED;
      delete process.env.COGITATOR_ENROLLED_ROOTS;
    }
  } finally {
    await f.close();
  }
});

test("import git : mode distant refuse un <root>/<slug> symlinké hors racine avant écriture (L2, critère 3)", async () => {
  const { fixture, authenticated } = await import("./native-auth-fixture.js");
  const f = await fixture();
  try {
    const { browser } = await authenticated(f); // mode protégé : session owner MFA
    const outside = join(f.home, "dehors");
    mkdirSync(outside, { recursive: true });
    // <root>/<slug> existe déjà en symlink vers l'extérieur : toute écriture le
    // suivrait. La garde canonicalisée doit refuser avant le clone.
    const slugDir = join(f.home, "projects", "repo-l2");
    mkdirSync(dirname(slugDir), { recursive: true });
    symlinkSync(outside, slugDir, "dir");
    process.env.COGITATOR_AUTH_REQUIRED = "1";
    process.env.COGITATOR_ENROLLED_ROOTS = join(f.home, "projects");
    try {
      const res = await browser.call("/api/workspaces", { git_url: makeLocalRepo("repo-l2") });
      assert.equal(res.status, 400);
      assert.match(String(res.data.error), /^racine de clone hors des racines enrôlées: /);
      assert.deepEqual(readdirSync(outside), []); // rien écrit hors racine
    } finally {
      delete process.env.COGITATOR_AUTH_REQUIRED;
      delete process.env.COGITATOR_ENROLLED_ROOTS;
    }
  } finally {
    await f.close();
  }
});

test("import git : échec après clone → clone supprimé, réimport possible (D4, critère 5)", async () => {
  const src = makeLocalRepo("d4-repo");
  const failed = await postWorkspace({ git_url: src, default_agent_id: "agent-introuvable" });
  assert.equal(failed.status, 400);
  assert.match(String(failed.body.error), /^agent par défaut introuvable: /);
  assert.equal(existsSync(join(root(), "d4-repo")), false); // pas de clone orphelin
  const ok = await postWorkspace({ git_url: src });
  assert.equal(ok.status, 201);
  assert.equal(existsSync(join(ok.body.workspace!.dir, ".git")), true);
});

test("import git : dossier vide préexistant jamais supprimé (S3)", async () => {
  const src = makeLocalRepo("s3-repo");
  const dest = join(root(), "s3-repo");
  mkdirSync(dest, { recursive: true }); // préexistant, vide, pas créé par Cogitator
  const failed = await postWorkspace({ git_url: src, default_agent_id: "agent-introuvable" });
  assert.equal(failed.status, 400);
  assert.equal(existsSync(dest), true); // le dossier préexistant est préservé
  const ok = await postWorkspace({ git_url: src });
  assert.equal(ok.status, 201); // le clone réutilise le dossier sans le supprimer
  assert.equal(existsSync(join(dest, ".git")), true);
});

test("import git : échec réel de git → 400 catalogué, aucun dossier résiduel ni workspace (R5, critère 4)", async () => {
  // source clonable par normalizeGitUrl (chemin local existant) qui n'est PAS un dépôt git :
  // ici git lui-même échoue — le mapping 400 est prouvé au niveau HTTP.
  const notARepo = join(home, "pas-un-depot");
  mkdirSync(notARepo, { recursive: true });
  writeFileSync(join(notARepo, "note.txt"), "pas un dépôt\n");
  const res = await postWorkspace({ git_url: notARepo });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /^clone échoué: /);
  assert.equal(existsSync(join(root(), "pas-un-depot")), false); // aucun dossier résiduel
  const list = (await (await fetch(`${base}/api/workspaces`)).json()) as { workspaces: { dir: string }[] };
  assert.ok(list.workspaces.every((w) => !w.dir.endsWith("pas-un-depot"))); // aucun workspace
});

test("import git : source sans schéma >2 segments → 400 catalogué, pas de réécriture github (R1, critère 10)", async () => {
  const res = await postWorkspace({ git_url: "gitlab.com/o/r" });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /^clone échoué: /);
  assert.ok(!JSON.stringify(res.body).includes("github.com/gitlab.com")); // pas de faux clone
  assert.equal(existsSync(join(root(), "gitlab.com")), false); // destination <root>/gitlab.com/o non créée
  assert.equal(existsSync(join(root(), "r")), false); // aucun résiduel non plus
});

test("import git : échec avec clone référencé par un workspace concurrent → arbre préservé (M1, critère 5, course simulée)", async () => {
  const src = makeLocalRepo("m1-repo");
  const dest = join(root(), "m1-repo");
  // Course simulée par insertion SQL directe (la vraie course concurrente n'est pas
  // exerçable en test unitaire) : un workspace référence déjà la destination,
  // avec la forme canonicalisée que createWorkspace écrit en base. Sans M1 (comparaison
  // lexicale), la garde ne matche pas sur racine symlinkée (/tmp macOS) et le clone
  // référencé serait supprimé.
  mkdirSync(root(), { recursive: true }); // racine absente en exécution isolée : realpath exige le préfixe
  db.prepare("INSERT INTO workspace (id, dir, name) VALUES (?, ?, ?)").run("ws-m1-concurrent", join(realpathSync(root()), "m1-repo"), "concurrent");
  try {
    const res = await postWorkspace({ git_url: src, default_agent_id: "agent-introuvable" });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /^workspace déjà enregistré pour /);
    assert.equal(existsSync(join(dest, ".git")), true); // l'arbre git valide est préservé
  } finally {
    db.prepare("DELETE FROM workspace WHERE id = ?").run("ws-m1-concurrent");
  }
});

test("import git : exception après clone → clone supprimé, réimport possible (M3, critère 5)", async () => {
  const src = makeLocalRepo("m3-repo");
  const dest = join(root(), "m3-repo");
  // Injection du point de création : lève comme une panne réelle entre le clone et
  // l'enrôlement — exerce réellement le catch + discardClone de la route.
  const failing = createApp({
    db, dbPath: join(home, "cogitator.db"), dbVersion, paths: getPaths(), pool,
    createWorkspaceImpl: () => { throw new Error("panne simulée après clone"); },
  });
  await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(failing.address() as AddressInfo).port}/api/workspaces`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ git_url: src }),
    });
    assert.equal(res.status, 500); // l'exception se propage au wrapper d'erreur
    assert.equal(existsSync(dest), false); // le nettoyage d'exception a supprimé le clone
  } finally {
    failing.closeAllConnections();
    await new Promise<void>((resolve) => failing.close(() => resolve()));
  }
  const ok = await postWorkspace({ git_url: src });
  assert.equal(ok.status, 201); // disque propre : le réimport repart de zéro
  assert.equal(existsSync(join(ok.body.workspace!.dir, ".git")), true);
});

test("import git : « déjà importé » seulement si un workspace pointe dessus (S2, D4)", async () => {
  const src = makeLocalRepo("s2-repo");
  const first = await postWorkspace({ git_url: src });
  assert.equal(first.status, 201);
  const again = await postWorkspace({ git_url: src });
  assert.equal(again.status, 400);
  assert.match(String(again.body.error), /^workspace déjà enregistré pour /);
  // suppression du workspace → réimport : le dossier existant est réutilisé, pas refusé
  const del = await fetch(`${base}/api/workspaces/${first.body.workspace!.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const reimport = await postWorkspace({ git_url: src });
  assert.equal(reimport.status, 201);
  assert.equal(reimport.body.workspace!.dir, first.body.workspace!.dir);
});

test("import git : URL hostiles → 400 sans écriture hors racine (S4, critère 3)", async () => {
  for (const hostile of ["../x", "..\\x", "https://github.com/../x", "-x"]) {
    const res = await postWorkspace({ git_url: hostile });
    assert.equal(res.status, 400, hostile);
    assert.match(String(res.body.error), /^(URL git invalide|clone échoué): /);
  }
  assert.equal(existsSync(join(home, "x")), false);
  assert.equal(existsSync(join(root(), "x")), false);
});

test("les erreurs d'import git se localisent fr↔en (S5, critère 7)", () => {
  const previous = getLocale();
  try {
    const cases = [
      "URL git invalide: https://github.com/../x",
      "clone échoué: fatal: repository '/nope' does not exist",
      `racine de clone hors des racines enrôlées: ${root()}`,
      "URL git requise",
      "identifiants embarqués dans l'URL git refusés — utilise les identifiants git configurés sur ce poste",
      "dépôt différent déjà cloné à cet emplacement: /tmp/x",
      "fournir dir ou git_url (pas les deux)",
      "dir ou git_url requis",
    ];
    for (const text of cases) {
      setLocale("en");
      const en = localizeText(text);
      assert.notEqual(en, text);
      setLocale("fr");
      assert.equal(localizeText(en), text);
    }
  } finally { setLocale(previous); }
});
