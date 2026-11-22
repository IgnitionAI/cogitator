import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, pointCurrent, pruneReleases, readStatus, runOnce, takeRequest, writeStatus, type UpdaterConfig } from "../src/updater/cogitator-updater.js";
import { requestUpdater, selfUpdateSupport, SelfUpdater, updaterAvailable } from "../src/self-update.js";
import { getPaths } from "../src/paths.js";

const uid = process.getuid?.() ?? 0;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "cog-updater-"));
  const cfg = defaults({
    releases: join(root, "opt", "releases"), current: join(root, "opt", "current"), stateDir: join(root, "state"),
    home: join(root, "home"), port: 0, registry: "", verifyTimeoutMs: 3000,
  });
  mkdirSync(cfg.releases, { recursive: true }); mkdirSync(join(cfg.stateDir, "inbox"), { recursive: true }); mkdirSync(cfg.home, { recursive: true });
  return { root, cfg };
}

test("demande : lien, taille, propriétaire et version contrôlés ; fichier consommé", () => {
  const { root, cfg } = sandbox();
  try {
    const file = join(cfg.stateDir, "inbox", "request.json");
    assert.equal(takeRequest(cfg, [uid]), null);
    writeFileSync(file, JSON.stringify({ version: "1.2.3" }));
    assert.deepEqual(takeRequest(cfg, [uid]), { version: "1.2.3" });
    assert.equal(existsSync(file), false, "consommée");
    writeFileSync(file, JSON.stringify({ version: "1.2.3; rm -rf /" }));
    assert.throws(() => takeRequest(cfg, [uid]), /version invalide/);
    writeFileSync(file, JSON.stringify({ version: "1.2.3" }));
    assert.throws(() => takeRequest(cfg, [uid + 12345]), /propriétaire/);
    writeFileSync(file, "x".repeat(2000));
    assert.throws(() => takeRequest(cfg, [uid]), /invalide/);
    writeFileSync(join(root, "target.json"), JSON.stringify({ version: "1.2.3" }));
    symlinkSync(join(root, "target.json"), file);
    assert.throws(() => takeRequest(cfg, [uid]), /lien/);
    assert.equal(existsSync(join(root, "target.json")), true, "la cible d'un lien n'est jamais touchée");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bascule atomique et nettoyage : seules les releases npm-* au-delà de 3 sont supprimées", () => {
  const { root, cfg } = sandbox();
  try {
    const dirs = ["src-abc", "npm-0.1.0", "npm-0.2.0", "npm-0.3.0", "npm-0.4.0", "npm-0.5.0"].map((n, i) => {
      const d = join(cfg.releases, n); mkdirSync(d); utimesSync(d, 1000 + i, 1000 + i); return d;
    });
    pointCurrent(cfg, dirs[5]!);
    assert.equal(readlinkSync(cfg.current), dirs[5]);
    pointCurrent(cfg, dirs[0]!);
    assert.equal(readlinkSync(cfg.current), dirs[0]);
    const removed = pruneReleases(cfg, [dirs[5]!, dirs[0]!]);
    assert.deepEqual(removed.sort(), [dirs[1], dirs[2], dirs[3]].sort());
    assert.ok(existsSync(dirs[0]!) && existsSync(dirs[4]!) && existsSync(dirs[5]!));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Faux npm (pack depuis un dossier de fixture, install, audit), faux systemctl (sert la version de `current`). */
function fakeTools(root: string, cfg: UpdaterConfig, opts: { auditFails?: boolean; badVersion?: string } = {}) {
  const bin = join(root, "bin"); mkdirSync(bin);
  const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!/bin/sh
case "$1" in
  pack)
    v=\${2##*@}; d=${fixtures}/v$v/package; mkdir -p "$d/dist/src"
    printf '{"name":"@ignitionai/cogitator","version":"%s","peerDependencies":{"pi-peer":"*"},"devDependencies":{"pi-peer":"1.2.3"}}' "$v" > "$d/package.json"; echo "// cli" > "$d/dist/src/cli.js"
    tar -czf "$4/ignitionai-cogitator-$v.tgz" -C ${fixtures}/v$v package
    printf '[{"filename":"ignitionai-cogitator-%s.tgz","version":"%s"}]' "$v" "$v" ;;
  install) echo "$*" >> ${root}/npm-install.log; cp package.json ${root}/installed-manifest.json; grep -q '"pi-peer": "1.2.3"' package.json && grep -q '"dependencies"' package.json && mkdir -p node_modules/pi-peer && echo '{}' > node_modules/pi-peer/package.json ;;
  audit) ${opts.auditFails ? "echo 'invalid signature' >&2; exit 1" : "echo ok"} ;;
esac
`);
  const systemctl = join(bin, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh
echo "$*" >> ${root}/systemctl.log
v=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' ${cfg.current}/package.json | head -1)
${opts.badVersion ? `[ "$v" = "${opts.badVersion}" ] && v=broken` : ""}
printf '{"pid":1,"version":"%s","port":1,"startedAt":"x"}' "$v" > ${cfg.home}/server.pid
`);
  chmodSync(npm, 0o755); chmodSync(systemctl, 0o755);
  return { npm, systemctl };
}

async function fakeRegistry(latest: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url?.includes("cogitator")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ name: "@ignitionai/cogitator", version: latest })); return; }
    res.writeHead(200); res.end("{}"); // /api/status du serveur « redémarré »
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function oldRelease(cfg: UpdaterConfig, version: string) {
  const dir = join(cfg.releases, "src-old"); mkdirSync(join(dir, "dist", "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@ignitionai/cogitator", version }));
  pointCurrent(cfg, dir);
  return dir;
}

test("runOnce : demande → téléchargement → release → bascule → redémarrage → vérifié", async () => {
  const { root, cfg: base } = sandbox();
  const { server, url } = await fakeRegistry("0.8.0");
  try {
    const cfg = { ...base, registry: url, port: (server.address() as AddressInfo).port };
    Object.assign(cfg, fakeTools(root, cfg));
    oldRelease(cfg, "0.7.0");
    writeStatus(cfg, { status: "idle" });
    writeFileSync(join(cfg.stateDir, "inbox", "request.json"), JSON.stringify({ version: "0.8.0" }));
    const result = await runOnce(cfg, [uid]);
    assert.equal(result?.status, "done", result?.message);
    assert.equal(result?.from, "0.7.0");
    assert.equal(readlinkSync(cfg.current), join(cfg.releases, "npm-0.8.0"));
    assert.ok(existsSync(join(cfg.releases, "npm-0.8.0", "node_modules", "pi-peer")), "peer pi installé");
    const installed = JSON.parse(readFileSync(join(root, "installed-manifest.json"), "utf8"));
    assert.equal(installed.dependencies["pi-peer"], "1.2.3", "peer ajouté aux dépendances à la version figée");
    assert.equal(installed.devDependencies, undefined, "devDependencies retirées avant --omit=dev");
    assert.match(readFileSync(join(root, "systemctl.log"), "utf8"), /restart cogitator\.service/);
    assert.equal(await runOnce(cfg, [uid]), null, "plus rien à faire");
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runOnce : refuse une version qui n'est pas la dernière publiée, sans rien toucher", async () => {
  const { root, cfg: base } = sandbox();
  const { server, url } = await fakeRegistry("0.9.0");
  try {
    const cfg = { ...base, registry: url };
    Object.assign(cfg, fakeTools(root, cfg));
    const old = oldRelease(cfg, "0.7.0");
    writeFileSync(join(cfg.stateDir, "inbox", "request.json"), JSON.stringify({ version: "0.8.0" }));
    const result = await runOnce(cfg, [uid]);
    assert.equal(result?.status, "error");
    assert.match(result!.message!, /dernière version publiée \(0\.9\.0\)/);
    assert.equal(readlinkSync(cfg.current), old);
    assert.equal(existsSync(join(root, "systemctl.log")), false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runOnce : signatures invalides → erreur avant bascule ; nouvelle version muette → retour arrière", async () => {
  const { root, cfg: base } = sandbox();
  const { server, url } = await fakeRegistry("0.8.0");
  try {
    const cfg = { ...base, registry: url, port: (server.address() as AddressInfo).port };
    Object.assign(cfg, fakeTools(root, cfg, { auditFails: true }));
    const old = oldRelease(cfg, "0.7.0");
    writeFileSync(join(cfg.stateDir, "inbox", "request.json"), JSON.stringify({ version: "0.8.0" }));
    const audit = await runOnce(cfg, [uid]);
    assert.equal(audit?.status, "error");
    assert.match(audit!.message!, /audit/);
    assert.equal(readlinkSync(cfg.current), old, "aucune bascule");

    rmSync(join(root, "bin"), { recursive: true }); rmSync(join(root, "fixtures"), { recursive: true });
    Object.assign(cfg, fakeTools(root, cfg, { badVersion: "0.8.0" }));
    writeFileSync(join(cfg.stateDir, "inbox", "request.json"), JSON.stringify({ version: "0.8.0" }));
    const rolled = await runOnce(cfg, [uid]);
    assert.equal(rolled?.status, "rolled-back", rolled?.message);
    assert.match(rolled!.message!, /Retour à 0\.7\.0/);
    assert.equal(readlinkSync(cfg.current), old, "release précédente rétablie");
    assert.equal(readFileSync(join(root, "systemctl.log"), "utf8").trim().split("\n").length, 2, "redémarré deux fois");
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Cogitator : détecte l'updater, dépose la demande, suit l'état et le retour arrière", async () => {
  const { root, cfg } = sandbox();
  try {
    const env = { COGITATOR_UPDATER_DIR: cfg.stateDir };
    const paths = getPaths({ COGITATOR_HOME: cfg.home, COGITATOR_PI_AGENT_DIR: join(root, "pi") });
    assert.equal(updaterAvailable(cfg.stateDir), false, "status.json absent");
    writeStatus(cfg, { status: "idle" });
    assert.deepEqual(selfUpdateSupport(paths, null, env), { supported: true, mode: "updater" });
    assert.deepEqual(selfUpdateSupport(paths, null, { ...env, COGITATOR_SELF_UPDATE: "0" }), { supported: false, reason: "SERVICE_MANAGED" });

    const updater = new SelfUpdater({
      support: () => selfUpdateSupport(paths, null, env),
      release: async () => ({ current: "0.7.0", latest: "0.8.0", status: "available" }),
      busy: async () => 0,
      install: async () => { throw new Error("pi ne doit pas être utilisé en mode updater"); },
      installedVersion: () => null, relaunch: () => { throw new Error("pas de relance locale"); }, shutdown: () => {},
      requestUpdater: (v) => requestUpdater(cfg.stateDir, v),
      updaterStatus: () => readStatus(cfg) as never,
    });
    assert.deepEqual(await updater.start(), { status: "installing", target: "0.8.0", step: "requested" });
    assert.deepEqual(takeRequest(cfg, [uid]), { version: "0.8.0" }, "demande déposée, lisible par l'updater");
    writeStatus(cfg, { status: "downloading", target: "0.8.0" });
    assert.deepEqual(updater.state, { status: "installing", target: "0.8.0", step: "downloading" });
    writeStatus(cfg, { status: "verifying", target: "0.8.0" });
    assert.equal(updater.state.status, "restarting");
    writeStatus(cfg, { status: "rolled-back", target: "0.8.0", message: "Retour à 0.7.0." });
    assert.deepEqual(updater.state, { status: "error", target: "0.8.0", step: "rolled-back", error: "Retour à 0.7.0." });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("install : script root hors du code, inbox en dépôt seul, unités systemd (path → service)", async () => {
  const { root, cfg: base } = sandbox();
  try {
    const { install } = await import("../src/updater/cogitator-updater.js");
    const units = join(root, "systemd"); mkdirSync(units);
    const log = join(root, "systemctl.log");
    const systemctl = join(root, "systemctl"); writeFileSync(systemctl, `#!/bin/sh\necho "$*" >> ${log}\n`); chmodSync(systemctl, 0o755);
    const cfg = { ...base, user: "root", systemctl };
    const configPath = join(root, "cogitator-updater.json");
    install(cfg, configPath, { installDir: join(root, "lib"), systemdDir: units });
    const script = join(root, "lib", "cogitator-updater.mjs");
    assert.ok(existsSync(script));
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).unit, "cogitator.service");
    const { statSync } = await import("node:fs");
    assert.equal(statSync(join(cfg.stateDir, "inbox")).mode & 0o777, 0o730, "dépôt sans lecture du dossier");
    assert.equal(readStatus(cfg)?.status, "idle");
    const path = readFileSync(join(units, "cogitator-updater.path"), "utf8");
    const service = readFileSync(join(units, "cogitator-updater.service"), "utf8");
    assert.match(path, new RegExp(`PathExists=${join(cfg.stateDir, "inbox", "request.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(service, /Type=oneshot/);
    assert.ok(service.includes(`${script} run --config ${configPath}`));
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["daemon-reload", "enable --now cogitator-updater.path"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
