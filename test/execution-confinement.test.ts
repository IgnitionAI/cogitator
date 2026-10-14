import assert from "node:assert/strict";
import { test } from "node:test";
import { symlinkSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveConfined, enrollWorkspaceDir, enrollmentPolicyFromEnv } = await import("../src/execution/confinement.js");
const {
  assertEgressAllowed, egressProxyEnv, EgressDeniedError, defaultToolchainRegistry,
  assertCommandApproved, assertMcpServerApproved, assertExtensionApproved,
  UnclassifiedCapabilityError, DEFAULT_APPROVED_DESTINATIONS,
} = await import("../src/execution/egress.js");
const { buildWorkerContainerSpec, dockerRunArgs, validateHostEnforcement, CLOUD_METADATA_IP } = await import("../src/execution/container.js");
const { admissionDecision, prunePlan, DEFAULT_DISK_POLICY, GIB } = await import("../src/execution/admission.js");
const { readWorkspaceFile } = await import("../src/workspace-files.js");
const { createWorkspace } = await import("../src/workspaces.js");

const home = mkdtempSync(join(tmpdir(), "cog-exec-"));

test.after(() => rmSync(home, { recursive: true, force: true }));

// ---------- Confinement de chemins (symlink escape) ----------

test("resolveConfined : chemin normal sous la racine", () => {
  const root = join(home, "ws1");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "x");
  const r = resolveConfined(root, join(root, "src", "a.ts"));
  assert.ok("path" in r);
  assert.equal(r.path, realpathSync(join(root, "src", "a.ts")));
});

test("resolveConfined : symlink de fichier pointant hors racine rejeté (lecture)", () => {
  const root = join(home, "ws2");
  const outside = join(home, "secret-outside.txt");
  mkdirSync(root, { recursive: true });
  writeFileSync(outside, "SECRET");
  symlinkSync(outside, join(root, "fuite.ts"));
  const r = resolveConfined(root, join(root, "fuite.ts"));
  assert.ok("error" in r);
});

test("resolveConfined : symlink de dossier intermédiaire rejeté (écriture via préfixe existant)", () => {
  const root = join(home, "ws3");
  const outside = join(home, "hors-racine");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(outside, "sub"), { recursive: true });
  symlinkSync(outside, join(root, "link"));
  // le fichier n'existe pas encore : la queue lexicale doit rester confinée
  const r = resolveConfined(root, join(root, "link", "sub", "nouveau.txt"));
  assert.ok("error" in r);
});

test("resolveConfined : traversal lexical rejeté", () => {
  const root = join(home, "ws4");
  mkdirSync(root, { recursive: true });
  const r = resolveConfined(root, join(root, "..", "autre.txt"));
  assert.ok("error" in r);
});

test("readWorkspaceFile : symlink escape rejeté à la lecture", () => {
  const root = join(home, "ws5");
  const outside = join(home, "secret-lecture.txt");
  mkdirSync(root, { recursive: true });
  writeFileSync(outside, "SECRET");
  symlinkSync(outside, join(root, "fuite.md"));
  const r = readWorkspaceFile(root, join(root, "fuite.md"));
  assert.equal(r.error, "chemin hors du workspace");
  assert.ok(!r.file);
});

test("readWorkspaceFile : chemin valide toujours lisible", () => {
  const root = join(home, "ws6");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "ok.md"), "bonjour");
  const r = readWorkspaceFile(root, join(root, "ok.md"));
  assert.equal(r.file?.content, "bonjour");
});

// ---------- Enrôlement de workspaces ----------

test("enrollWorkspaceDir : mode local = canonicalisation historique", () => {
  const dir = join(home, "local-ws");
  mkdirSync(dir, { recursive: true });
  const r = enrollWorkspaceDir({ remote: false, enrolledRoots: [] }, dir);
  assert.ok("dir" in r);
});

test("enrollWorkspaceDir : mode distant refuse un dossier arbitraire hors racines", () => {
  const dir = join(home, "arbitraire");
  mkdirSync(dir, { recursive: true });
  const enrolled = join(home, "enrolled-root");
  mkdirSync(enrolled, { recursive: true });
  const r = enrollWorkspaceDir({ remote: true, enrolledRoots: [enrolled] }, dir);
  assert.ok("error" in r);
  assert.match(r.error, /arbitraire/);
});

test("enrollWorkspaceDir : mode distant accepte sous racine enrôlée et rejette le symlink sortant", () => {
  const enrolled = join(home, "enrolled-root2");
  const inside = join(enrolled, "ws-ok");
  mkdirSync(inside, { recursive: true });
  const policy = { remote: true, enrolledRoots: [enrolled] };
  const ok = enrollWorkspaceDir(policy, inside);
  assert.ok("dir" in ok);
  assert.equal(ok.dir, realpathSync(inside));
  // symlink dans la racine qui sort : refusé
  const outside = join(home, "ailleurs");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(enrolled, "ws-link"));
  const bad = enrollWorkspaceDir(policy, join(enrolled, "ws-link"));
  assert.ok("error" in bad);
  assert.match(bad.error, /symlink/);
});

test("enrollmentPolicyFromEnv : mode distant = COGITATOR_AUTH_REQUIRED=1, racines depuis COGITATOR_ENROLLED_ROOTS", () => {
  const p = enrollmentPolicyFromEnv({ COGITATOR_AUTH_REQUIRED: "1", COGITATOR_ENROLLED_ROOTS: "/a:/b" } as NodeJS.ProcessEnv);
  assert.equal(p.remote, true);
  assert.deepEqual(p.enrolledRoots, ["/a", "/b"]);
  const local = enrollmentPolicyFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(local.remote, false);
  assert.throws(() => enrollmentPolicyFromEnv({ COGITATOR_AUTH_REQUIRED: "peut-etre" } as NodeJS.ProcessEnv), /must be unset/);
});

test("createWorkspace : politique distante appliquée (arbitraire refusé, enrôlé accepté)", async () => {
  // db réel minimal : schéma restreint au domaine workspace
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:") as unknown as import("../src/db.js").Db;
  db.exec("CREATE TABLE workspace (id TEXT PRIMARY KEY, dir TEXT UNIQUE, name TEXT, default_agent_id TEXT)");
  db.exec("CREATE TABLE agent_preset (id TEXT PRIMARY KEY)");
  const enrolled = join(home, "enrolled-db");
  const inside = join(enrolled, "ws-db");
  mkdirSync(inside, { recursive: true });
  const arbitrary = join(home, "hors-db");
  mkdirSync(arbitrary, { recursive: true });
  const remote = { remote: true, enrolledRoots: [enrolled] };
  const refused = createWorkspace(db, { dir: arbitrary }, remote);
  assert.match(refused.error ?? "", /arbitraire/);
  const accepted = createWorkspace(db, { dir: inside }, remote);
  assert.ok(accepted.workspace);
  assert.equal(accepted.workspace.dir, realpathSync(inside));
});

// ---------- Egress default-deny ----------

test("egress : default-deny, allowlist uniquement, pas de bypass proxy", () => {
  const policy = { allowedHosts: [...DEFAULT_APPROVED_DESTINATIONS], proxy: "http://proxy.internal:3128" };
  assert.doesNotThrow(() => assertEgressAllowed(policy, "registry.npmjs.org"));
  assert.doesNotThrow(() => assertEgressAllowed(policy, "GitHub.com:443"));
  assert.throws(() => assertEgressAllowed(policy, "evil.example.com"), EgressDeniedError);
  assert.throws(() => assertEgressAllowed(policy, CLOUD_METADATA_IP), EgressDeniedError);
  const env = egressProxyEnv(policy);
  assert.equal(env.HTTPS_PROXY, "http://proxy.internal:3128");
  assert.equal(env.NO_PROXY, "");
  assert.throws(() => egressProxyEnv({ allowedHosts: [], proxy: null }), /non configuré/);
});

test("classification : commande/MCP/extension non classés indisponibles en mode distant", () => {
  const registry = defaultToolchainRegistry();
  assert.doesNotThrow(() => assertCommandApproved(registry, "node"));
  assert.throws(() => assertCommandApproved(registry, "curl"), UnclassifiedCapabilityError);
  assert.throws(() => assertMcpServerApproved(registry, "serveur-inconnu"), UnclassifiedCapabilityError);
  assert.throws(() => assertExtensionApproved(registry, "extension-inconnue"), UnclassifiedCapabilityError);
});

// ---------- Spécification conteneur ----------

test("container : spec refuse socket docker, montage hors enrôlement et secrets dans l'env", () => {
  const remote = { remote: true, enrolledRoots: [join(home, "enrolled-ct")] };
  const enrolledWs = join(remote.enrolledRoots[0], "ws");
  mkdirSync(enrolledWs, { recursive: true });
  // montage hors enrôlement
  const badMount = buildWorkerContainerSpec(
    { image: "img", name: "w", command: ["node"], workspaceMount: { source: join(home, "ailleurs"), target: "/workspace" } },
    remote,
  );
  assert.ok("error" in badMount);
  // socket docker
  const badSock = buildWorkerContainerSpec(
    { image: "img", name: "w", command: ["node"], workspaceMount: { source: "/var/run/docker.sock", target: "/workspace" } },
    { remote: false, enrolledRoots: [] },
  );
  assert.ok("error" in badSock);
  // secret dans l'env
  const badEnv = buildWorkerContainerSpec(
    { image: "img", name: "w", command: ["node"], workspaceMount: { source: enrolledWs, target: "/workspace" }, env: { GITHUB_TOKEN: "ghp_x" } },
    remote,
  );
  assert.ok("error" in badEnv);
  // metadata dans une valeur d'env
  const badMeta = buildWorkerContainerSpec(
    { image: "img", name: "w", command: ["node"], workspaceMount: { source: enrolledWs, target: "/workspace" }, env: { FOO: `http://${CLOUD_METADATA_IP}/` } },
    remote,
  );
  assert.ok("error" in badMeta);
});

test("container : spec saine = rootfs RO, network none, non-root, limites, seul workspace rw", () => {
  const remote = { remote: true, enrolledRoots: [join(home, "enrolled-ct2")] };
  const ws = join(remote.enrolledRoots[0], "ws");
  mkdirSync(ws, { recursive: true });
  const built = buildWorkerContainerSpec(
    { image: "img:pin", name: "mission-1", command: ["node", "test"], workspaceMount: { source: ws, target: "/workspace" } },
    remote,
  );
  assert.ok("spec" in built);
  const spec = built.spec;
  assert.equal(spec.network, "none");
  assert.equal(spec.user, "65534:65534");
  assert.equal(spec.mounts.length, 1);
  assert.equal(spec.mounts[0].readOnly, false);
  const args = dockerRunArgs(spec);
  const flat = args.join(" ");
  for (const flag of ["--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--network none", "--memory", "--cpus", "--pids-limit", "--user 65534:65534"]) {
    assert.ok(flat.includes(flag), `flag manquant: ${flag}`);
  }
  assert.ok(flat.includes(`-v ${realpathSync(ws)}:/workspace:rw`));
  // egress : proxy imposé, réseau bridge
  const withEgress = buildWorkerContainerSpec(
    { image: "img", name: "w", command: [], workspaceMount: { source: ws, target: "/workspace" }, egress: { allowedHosts: ["registry.npmjs.org"], proxy: "http://p:3128" } },
    remote,
  );
  assert.ok("spec" in withEgress);
  assert.equal(withEgress.spec.network, "egress");
  const eflat = dockerRunArgs(withEgress.spec).join(" ");
  assert.ok(eflat.includes("--network bridge"));
  assert.ok(eflat.includes("HTTPS_PROXY=http://p:3128"));
});

test("container : limite hôte non supportée = échec de déploiement (pas d'abaissement silencieux)", () => {
  assert.doesNotThrow(() => validateHostEnforcement({ securityOptions: ["name=seccomp,profile=builtin"], cgroupDriver: "systemd" }));
  assert.throws(() => validateHostEnforcement({ securityOptions: [], cgroupDriver: "systemd" }), /seccomp/);
  assert.throws(() => validateHostEnforcement({ securityOptions: ["name=seccomp"], cgroupDriver: "" }), /cgroup/);
});

// ---------- Admission disque et rétention (CG1) ----------

test("admission : seuil = plus grand de 5 GiB / 20 %, quota worker, jamais sous la réserve", () => {
  // disque 100 GiB → réserve = 20 GiB (> 5 GiB)
  const disk = { freeBytes: 25 * GIB, totalBytes: 100 * GIB };
  assert.deepEqual(admissionDecision(DEFAULT_DISK_POLICY, disk, 5 * GIB), { admit: true });
  const refused = admissionDecision(DEFAULT_DISK_POLICY, disk, 6 * GIB);
  assert.equal(refused.admit, false);
  assert.match(refused.reason ?? "", /réserve/);
  // petit disque 10 GiB → réserve = 5 GiB (le plus grand reste 5 GiB vs 2 GiB)
  const small = { freeBytes: 6 * GIB, totalBytes: 10 * GIB };
  assert.deepEqual(admissionDecision(DEFAULT_DISK_POLICY, small, GIB), { admit: true });
  assert.equal(admissionDecision(DEFAULT_DISK_POLICY, small, 2 * GIB).admit, false);
  // quota par worker
  const quota = admissionDecision(DEFAULT_DISK_POLICY, { freeBytes: 100 * GIB, totalBytes: 500 * GIB }, 21 * GIB);
  assert.equal(quota.admit, false);
  assert.match(quota.reason ?? "", /quota/);
});

test("prunePlan : actif et preuves non résolues jamais épurés, terminal exporté expiré seulement", () => {
  const base = { exported: true, pinned: false, ageMs: 10 * 24 * 3600 * 1000, retentionMs: 7 * 24 * 3600 * 1000 };
  const entries = [
    { kind: "clone" as const, active: true, unresolvedEffects: false, ...base },
    { kind: "artifact" as const, active: false, unresolvedEffects: true, ...base },
    { kind: "clone" as const, active: false, unresolvedEffects: false, ...base },
    { kind: "clone" as const, active: false, unresolvedEffects: false, ...base, exported: false },
    { kind: "clone" as const, active: false, unresolvedEffects: false, ...base, ageMs: 3600 * 1000 },
    { kind: "receipt" as const, active: false, unresolvedEffects: false, ...base },
    { kind: "image" as const, active: false, unresolvedEffects: false, ...base, pinned: true },
  ];
  const plan = prunePlan(entries);
  assert.equal(plan.prunable.length, 1); // seul le clone terminal exporté + expiré
  assert.equal(plan.protectedEntries.length, 6);
});
