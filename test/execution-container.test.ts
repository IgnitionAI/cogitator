/**
 * Fixture adversariale d'exécution conteneurisée (ticket #14, Plan 0002 §8 P2).
 *
 * Exécute un script malveillant DANS un worker selon la spec P2 et vérifie :
 * le script ne peut ni lire des fichiers hors du workspace enrôlé, ni écrire
 * hors de celui-ci, ni joindre les métadonnées cloud / le réseau, ni voir le
 * socket Docker ou des secrets d'environnement.
 *
 * Limite (documentée dans le rapport) : le Docker local de développement
 * (Docker Desktop / dockerd non rootless ici) n'est pas une preuve rootless de
 * production ; ces scénarios valident la spec et les montages, pas le
 * durcissement du démon sur la cible VPS.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildWorkerContainerSpec, dockerRunArgs } = await import("../src/execution/container.js");

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 });
  return r.status === 0;
}

const ALPINE = "alpine:3";

function ensureImage(): boolean {
  const inspect = spawnSync("docker", ["image", "inspect", ALPINE], { timeout: 10_000 });
  if (inspect.status === 0) return true;
  const pull = spawnSync("docker", ["pull", ALPINE], { timeout: 180_000, stdio: "ignore" });
  return pull.status === 0;
}

const home = mkdtempSync(join(tmpdir(), "cog-exec-ct-"));
test.after(() => rmSync(home, { recursive: true, force: true }));

// Script malveillant exécuté dans le conteneur : chaque tentative d'attaque
// imprime un marqueur ; le harnais de test les interprète.
const MALICIOUS = [
  "set -u",
  // 1. fichiers du plan de contrôle invisibles (non montés)
  "for p in /host/etc/passwd /var/run/docker.sock /run/secrets/provider.key /state/runtime.sqlite; do",
  "  [ -e \"$p\" ] && echo \"LEAK:$p\" || echo \"OK:absent:$p\"",
  "done",
  // 2. métadonnées cloud injoignables (network none)
  "wget -T 3 -qO- http://169.254.169.254/latest/meta-data >/dev/null 2>&1 && echo 'LEAK:metadata' || echo 'OK:metadata'",
  // 3. résolution DNS impossible (network none) — busybox nslookup
  "nslookup github.com >/dev/null 2>&1 && echo 'LEAK:dns' || echo 'OK:dns'",
  // 4. rootfs en lecture seule
  "(touch /evil.txt 2>/dev/null && echo 'LEAK:rootfs') || echo 'OK:rootfs'",
  // 5. écriture hors workspace : même nom dans /tmp seul (tmpfs) — le /workspace est le seul montage persistant
  "touch /workspace/.scratch/write-test && echo 'OK:scratch-write' || echo 'LEAK:scratch'",
  "touch /workspace/pwned-by-fixture && echo 'OK:workspace-write' || echo 'LEAK:workspace'",
  // 6. aucun secret dans l'environnement
  "env | grep -iE 'token|secret|key|aws_|github_' && echo 'LEAK:env' || echo 'OK:env'",
  // 7. l'utilisateur n'est pas root
  "[ \"$(id -u)\" = '0' ] && echo 'LEAK:root-user' || echo 'OK:user'",
].join("\n");

test("fixture malveillante : confinement P2 dans un conteneur local", { skip: !dockerAvailable() || !ensureImage(), timeout: 120_000 }, () => {
  const enrolledRoot = join(home, "enrolled");
  const workspace = join(enrolledRoot, "ws");
  mkdirSync(workspace, { recursive: true });
  // le worker tourne en uid 65534 (nobody) : rendre le volume enrôlé accessible
  chmodSync(workspace, 0o777);
  writeFileSync(join(workspace, "code.txt"), "projet");
  // fichiers « plan de contrôle » sur l'hôte : ne doivent JAMAIS être montés
  writeFileSync(join(home, "provider.key"), "SECRET-PROVIDER");
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "runtime.sqlite"), "DB");
  writeFileSync(join(home, "evil-host-target.txt"), "HOST");

  const built = buildWorkerContainerSpec(
    {
      image: ALPINE,
      name: `cogitator-p2-fixture-${process.pid}`,
      command: ["sh", "-c", MALICIOUS],
      workspaceMount: { source: workspace, target: "/workspace" },
      env: { PLAIN_VAR: "ok" },
    },
    { remote: true, enrolledRoots: [enrolledRoot] },
  );
  assert.ok("spec" in built, "error" in built ? built.error : "spec attendue");
  assert.equal(built.spec.network, "none");

  const args = dockerRunArgs(built.spec);
  const run = spawnSync("docker", args, { timeout: 90_000, encoding: "utf8" });
  const out = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, `fixture échouée:\n${out}`);

  for (const p of ["/host/etc/passwd", "/var/run/docker.sock", "/run/secrets/provider.key", "/state/runtime.sqlite"]) {
    assert.ok(out.includes(`OK:absent:${p}`), `fichier visible: ${p}\n${out}`);
  }
  for (const marker of ["OK:metadata", "OK:dns", "OK:rootfs", "OK:scratch-write", "OK:workspace-write", "OK:env", "OK:user"]) {
    assert.ok(out.includes(marker), `marqueur manquant: ${marker}\n${out}`);
  }
  assert.ok(!out.includes("LEAK:"), `fuite détectée:\n${out}`);
  // la fixture a bien écrit dans le workspace enrôlé (visible côté hôte)
  assert.ok(existsSync(join(workspace, "pwned-by-fixture")), "écriture workspace non persistée");
  // le fichier hôte cible, jamais monté, est intact
  const hostTarget = join(home, "evil-host-target.txt");
  assert.equal(existsSync(hostTarget), true);
  assert.equal(execFileSync("cat", [hostTarget], { encoding: "utf8" }), "HOST");
});

test("montages malveillants refusés à la construction (spec)", () => {
  const enrolledRoot = join(home, "enrolled2");
  mkdirSync(enrolledRoot, { recursive: true });
  // socket docker via un chemin détourné reste refusé
  const sock = buildWorkerContainerSpec(
    { image: ALPINE, name: "x", command: [], workspaceMount: { source: "/run/docker.sock", target: "/workspace" } },
    { remote: false, enrolledRoots: [] },
  );
  assert.ok("error" in sock);
  // montage de l'état du runtime hôte refusé en mode distant (hors racine)
  const state = buildWorkerContainerSpec(
    { image: ALPINE, name: "x", command: [], workspaceMount: { source: stateDirSafe(), target: "/workspace" } },
    { remote: true, enrolledRoots: [enrolledRoot] },
  );
  assert.ok("error" in state);
  // secret fournisseur refusé dans l'env du worker
  const secret = buildWorkerContainerSpec(
    { image: ALPINE, name: "x", command: [], env: { OPENAI_API_KEY: "sk-live" } },
    { remote: false, enrolledRoots: [] },
  );
  assert.ok("error" in secret);
  function stateDirSafe() { const d = join(home, "state2"); mkdirSync(d, { recursive: true }); return d; }
});
