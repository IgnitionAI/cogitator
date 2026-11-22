#!/usr/bin/env node
/**
 * cogitator-updater — service root de mise à jour pour une installation systemd
 * (releases sous /opt/cogitator/releases, lien /opt/cogitator/current).
 *
 * Autonome (modules Node + CLI npm uniquement) : `install` le copie hors du code de
 * Cogitator, appartenant à root. Le compte du serveur ne peut que DÉPOSER une demande
 * (inbox/request.json, contenu : une version). Le service vérifie qu'il s'agit de la
 * dernière version publiée sur npm, puis : npm pack (intégrité du registre) → release
 * neuve → npm install --omit=dev → npm audit signatures → bascule atomique de `current`
 * → systemctl restart → vérification (version servie + /api/status). Échec après la
 * bascule : retour automatique à la release précédente.
 *
 * Commandes : install | run | status | uninstall   (voir docs/updater.md)
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, chownSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, constants,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = "@ignitionai/cogitator";
export const DEFAULT_CONFIG = "/etc/cogitator-updater.json";
const INSTALL_DIR = "/usr/local/lib/cogitator-updater";
const SYSTEMD_DIR = "/etc/systemd/system";
const RELEASE_PREFIX = "npm-";
const KEEP_RELEASES = 3;
const LOCK_STALE_MS = 30 * 60_000;

export interface UpdaterConfig {
  /** Unité systemd de Cogitator. */
  unit: string;
  /** Compte du service (propriétaire autorisé des demandes). */
  user: string;
  releases: string;
  current: string;
  /** État du service : status.json (lisible) et inbox/ (dépôt des demandes). */
  stateDir: string;
  /** COGITATOR_HOME du service (server.pid → version servie). */
  home: string;
  port: number;
  registry: string;
  /** Exécutables (surchargés en test). */
  npm: string;
  systemctl: string;
  tar: string;
  verifyTimeoutMs: number;
}

export type UpdaterPhase = "idle" | "downloading" | "installing" | "switching" | "restarting" | "verifying" | "done" | "rolling-back" | "rolled-back" | "error";
export interface UpdaterStatus { status: UpdaterPhase; target?: string; from?: string; message?: string; at: string }

export function defaults(partial: Partial<UpdaterConfig> = {}): UpdaterConfig {
  return {
    unit: "cogitator.service", user: "cogitator", releases: "/opt/cogitator/releases", current: "/opt/cogitator/current",
    stateDir: "/var/lib/cogitator-updater", home: "/var/lib/cogitator", port: 5320, registry: "https://registry.npmjs.org",
    npm: "npm", systemctl: "systemctl", tar: "tar", verifyTimeoutMs: 90_000, ...partial,
  };
}

export function loadConfig(path = DEFAULT_CONFIG): UpdaterConfig {
  return defaults(JSON.parse(readFileSync(path, "utf8")) as Partial<UpdaterConfig>);
}

const STABLE = /^\d+\.\d+\.\d+$/;
export function newer(a: string, b: string): boolean {
  if (!STABLE.test(a) || !STABLE.test(b)) return false;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

function now() { return new Date().toISOString(); }

export function writeStatus(cfg: UpdaterConfig, status: Omit<UpdaterStatus, "at">): void {
  const file = join(cfg.stateDir, "status.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...status, at: now() }, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, file);
}

export function readStatus(cfg: UpdaterConfig): UpdaterStatus | null {
  try { return JSON.parse(readFileSync(join(cfg.stateDir, "status.json"), "utf8")) as UpdaterStatus; } catch { return null; }
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): string {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8", timeout: opts.timeoutMs ?? 600_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`${basename(cmd)} : ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${basename(cmd)} ${args[0] ?? ""} a échoué (code ${r.status}) : ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  return r.stdout;
}

function uidOf(user: string): number | null {
  const r = spawnSync("id", ["-u", user], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.trim()) : null;
}

/**
 * Lit puis supprime la demande. Refuse lien symbolique, fichier non régulier, trop gros,
 * ou dont le propriétaire n'est ni root ni le compte du service.
 */
export function takeRequest(cfg: UpdaterConfig, allowedUids: number[]): { version: string } | null {
  const file = join(cfg.stateDir, "inbox", "request.json");
  if (!existsSync(file)) return null;
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { unlinkSync(file); throw new Error("Demande refusée : lien ou fichier illisible."); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024) throw new Error("Demande refusée : fichier invalide.");
    if (!allowedUids.includes(st.uid)) throw new Error("Demande refusée : propriétaire inattendu.");
    const data = JSON.parse(readFileSync(fd, "utf8")) as { version?: unknown };
    if (typeof data.version !== "string" || !STABLE.test(data.version)) throw new Error("Demande refusée : version invalide.");
    return { version: data.version };
  } finally { closeSync(fd); try { unlinkSync(file); } catch { /* déjà retirée */ } }
}

export async function latestVersion(cfg: UpdaterConfig): Promise<string> {
  const res = await fetch(`${cfg.registry}/${PACKAGE.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!res.ok) throw new Error(`Registre npm indisponible (HTTP ${res.status}).`);
  const data = await res.json() as { name?: unknown; version?: unknown };
  if (data.name !== PACKAGE || typeof data.version !== "string" || !STABLE.test(data.version)) throw new Error("Métadonnées npm invalides.");
  return data.version;
}

export function releaseVersion(dir: string): string | null {
  try { const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; return typeof v === "string" ? v : null; } catch { return null; }
}

function servedVersion(cfg: UpdaterConfig): string | null {
  try { const v = JSON.parse(readFileSync(join(cfg.home, "server.pid"), "utf8")).version; return typeof v === "string" ? v : null; } catch { return null; }
}

async function statusOk(cfg: UpdaterConfig): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${cfg.port}/api/status`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

/** La version attendue est servie ET le serveur répond. */
export async function waitServing(cfg: UpdaterConfig, version: string): Promise<boolean> {
  const deadline = Date.now() + cfg.verifyTimeoutMs;
  while (Date.now() < deadline) {
    if (servedVersion(cfg) === version && await statusOk(cfg)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Bascule atomique du lien `current` (lien temporaire + rename). */
export function pointCurrent(cfg: UpdaterConfig, target: string): void {
  const tmp = `${cfg.current}.tmp-${randomBytes(4).toString("hex")}`;
  symlinkSync(target, tmp);
  renameSync(tmp, cfg.current);
}

function npmEnv(cache: string): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
}

interface Manifest { version?: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string> }
function manifest(dir: string): Manifest {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest; } catch { return {}; }
}

/**
 * Les peerDependencies (pi) ne sont pas installées par `npm install` dans le paquet lui-même :
 * on les ajoute explicitement, à la version figée des devDependencies quand le peer accepte tout.
 */
export function peerSpecs(dir: string): Record<string, string> {
  const m = manifest(dir);
  return Object.fromEntries(Object.entries(m.peerDependencies ?? {}).map(([name, range]) => [name, range === "*" && m.devDependencies?.[name] ? m.devDependencies[name]! : range]));
}

/**
 * Manifeste de la release : peers ajoutés aux dépendances (sinon non installés), devDependencies
 * retirées (sinon un peer aussi listé en dev serait omis par --omit=dev).
 */
export function prepareManifest(dir: string): void {
  const m = manifest(dir);
  const next = { ...m, dependencies: { ...(m.dependencies ?? {}), ...peerSpecs(dir) } };
  delete next.devDependencies;
  writeFileSync(join(dir, "package.json"), JSON.stringify(next, null, 2) + "\n");
}

function complete(dir: string, version: string): boolean {
  if (releaseVersion(dir) !== version || !existsSync(join(dir, "dist", "src", "cli.js"))) return false;
  return Object.keys(manifest(dir).peerDependencies ?? {}).every((name) => existsSync(join(dir, "node_modules", name, "package.json")));
}

/** Construit la release `npm-<version>` (réutilisée si déjà complète). */
export function buildRelease(cfg: UpdaterConfig, version: string, onPhase: (p: UpdaterPhase) => void): string {
  const final = join(cfg.releases, `${RELEASE_PREFIX}${version}`);
  if (complete(final, version)) return final;
  mkdirSync(cfg.releases, { recursive: true });
  const work = join(cfg.releases, `.work-${version}-${randomBytes(4).toString("hex")}`);
  mkdirSync(work, { mode: 0o755 });
  try {
    const cache = join(work, ".npm-cache");
    const pack = join(work, ".pack");
    const root = join(work, "release");
    mkdirSync(pack); mkdirSync(root);
    onPhase("downloading");
    // npm pack vérifie l'intégrité (sha512) annoncée par le registre.
    const out = run(cfg.npm, ["pack", `${PACKAGE}@${version}`, "--pack-destination", pack, "--json"], { cwd: work, env: npmEnv(cache) });
    const file = (JSON.parse(out) as Array<{ filename: string; version: string }>)[0];
    if (!file || file.version !== version) throw new Error("Paquet npm inattendu.");
    run(cfg.tar, ["-xzf", join(pack, basename(file.filename)), "-C", root, "--strip-components=1", "--no-same-owner"]);
    if (releaseVersion(root) !== version) throw new Error("Version du paquet extrait inattendue.");
    onPhase("installing");
    prepareManifest(root);
    run(cfg.npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: root, env: npmEnv(cache) });
    // Signatures du registre et attestations de provenance des paquets installés.
    run(cfg.npm, ["audit", "signatures"], { cwd: root, env: npmEnv(cache) });
    if (!complete(root, version)) throw new Error("Release incomplète : dist/src/cli.js ou une dépendance pi manquante.");
    run("chmod", ["-R", "go-w", root]);
    rmSync(final, { recursive: true, force: true });
    renameSync(root, final);
    return final;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Garde la release active, la précédente et les plus récentes `npm-*` (3 au total) ; ne touche jamais aux autres. */
export function pruneReleases(cfg: UpdaterConfig, keep: string[]): string[] {
  const releases = readdirSync(cfg.releases).filter((n) => n.startsWith(RELEASE_PREFIX)).map((n) => join(cfg.releases, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const kept = new Set(keep);
  const removed: string[] = [];
  for (const dir of releases) {
    if (kept.has(dir)) continue;
    if (kept.size < KEEP_RELEASES) { kept.add(dir); continue; }
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

function acquireLock(cfg: UpdaterConfig): () => void {
  const lock = join(cfg.stateDir, "updater.lock");
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => { try { unlinkSync(lock); } catch { /* déjà retiré */ } };
}

/** Traite une demande si présente. Renvoie l'état final (ou null si rien à faire). */
export async function runOnce(cfg: UpdaterConfig, allowedUids: number[]): Promise<UpdaterStatus | null> {
  let release: () => void;
  try { release = acquireLock(cfg); } catch { return null; } // une mise à jour est déjà en cours
  let target: string | undefined;
  let from: string | undefined;
  const set = (status: UpdaterPhase, message?: string) => writeStatus(cfg, { status, target, from, ...(message ? { message } : {}) });
  try {
    const request = takeRequest(cfg, allowedUids);
    if (!request) return null;
    target = request.version;
    const previous = existsSync(cfg.current) ? readlinkSync(cfg.current) : null;
    from = previous ? releaseVersion(previous) ?? undefined : undefined;
    const latest = await latestVersion(cfg);
    if (target !== latest) throw new Error(`Seule la dernière version publiée (${latest}) peut être installée.`);
    if (from && !newer(target, from)) throw new Error(`La version ${target} n'est pas plus récente que ${from}.`);

    const dir = buildRelease(cfg, target, (p) => set(p));
    set("switching");
    pointCurrent(cfg, dir);
    try {
      set("restarting");
      run(cfg.systemctl, ["restart", cfg.unit], { timeoutMs: 120_000 });
      set("verifying");
      if (!await waitServing(cfg, target)) throw new Error(`La version ${target} n'a pas répondu après le redémarrage.`);
    } catch (error) {
      if (!previous) throw error;
      set("rolling-back", (error as Error).message);
      pointCurrent(cfg, previous);
      try { run(cfg.systemctl, ["restart", cfg.unit], { timeoutMs: 120_000 }); } catch { /* état rapporté ci-dessous */ }
      const back = from ? await waitServing(cfg, from) : false;
      set("rolled-back", `${(error as Error).message} Retour à ${from ?? "la release précédente"}${back ? "" : " (vérifier le service)"}.`);
      return readStatus(cfg);
    }
    try { pruneReleases(cfg, [dir, ...(previous ? [previous] : [])]); } catch { /* nettoyage facultatif */ }
    set("done");
    return readStatus(cfg);
  } catch (error) {
    set("error", (error as Error).message);
    return readStatus(cfg);
  } finally { release(); }
}

// ---------- Installation (root) ----------

function unitFiles(cfg: UpdaterConfig, script: string, configPath: string) {
  return {
    "cogitator-updater.service": `[Unit]
Description=Cogitator updater (installs a published release requested from the web UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${process.execPath} ${script} run --config ${configPath}
Environment=PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin
TimeoutStartSec=20min
NoNewPrivileges=true
PrivateTmp=true
`,
    "cogitator-updater.path": `[Unit]
Description=Watch for Cogitator update requests

[Path]
PathExists=${join(cfg.stateDir, "inbox", "request.json")}
Unit=cogitator-updater.service

[Install]
WantedBy=multi-user.target
`,
  };
}

export function install(cfg: UpdaterConfig, configPath = DEFAULT_CONFIG, opts: { systemd?: boolean; installDir?: string; systemdDir?: string } = {}): string[] {
  const done: string[] = [];
  const gid = Number(spawnSync("id", ["-g", cfg.user], { encoding: "utf8" }).stdout.trim());
  if (!Number.isInteger(gid)) throw new Error(`Compte inconnu : ${cfg.user}`);
  const installDir = opts.installDir ?? INSTALL_DIR;
  mkdirSync(installDir, { recursive: true, mode: 0o755 });
  const script = join(installDir, "cogitator-updater.mjs");
  copyFileSync(fileURLToPath(import.meta.url), script);
  chmodSync(script, 0o755);
  done.push(script);
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o644 });
  done.push(configPath);
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o755 });
  chmodSync(cfg.stateDir, 0o755);
  const inbox = join(cfg.stateDir, "inbox");
  mkdirSync(inbox, { recursive: true });
  // Le compte du service peut déposer une demande, sans lister ni lire le dossier.
  chownSync(inbox, 0, gid);
  chmodSync(inbox, 0o730);
  if (!existsSync(join(cfg.stateDir, "status.json"))) writeStatus(cfg, { status: "idle" });
  done.push(cfg.stateDir);
  if (opts.systemd !== false) {
    const dir = opts.systemdDir ?? SYSTEMD_DIR;
    for (const [name, body] of Object.entries(unitFiles(cfg, script, configPath))) { writeFileSync(join(dir, name), body, { mode: 0o644 }); done.push(join(dir, name)); }
    run(cfg.systemctl, ["daemon-reload"]);
    run(cfg.systemctl, ["enable", "--now", "cogitator-updater.path"]);
  }
  return done;
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`Argument inattendu : ${a}`);
    if (a === "--no-systemd") { flags["no-systemd"] = "1"; continue; }
    const [k, v] = a.includes("=") ? a.slice(2).split(/=(.*)/s) as [string, string] : [a.slice(2), rest[++i] ?? ""];
    flags[k] = v;
  }
  return { cmd, flags };
}

const USAGE = `cogitator-updater <install|run|status|uninstall> [options]
  install   --user cogitator --unit cogitator.service --home /var/lib/cogitator --port 5320
            [--releases /opt/cogitator/releases] [--current /opt/cogitator/current] [--state-dir /var/lib/cogitator-updater]
            [--config ${DEFAULT_CONFIG}] [--no-systemd] [--install-dir ${INSTALL_DIR}]
  run       [--config ${DEFAULT_CONFIG}]   traite une demande en attente (lancé par systemd)
  status    [--config ${DEFAULT_CONFIG}]
  uninstall [--config ${DEFAULT_CONFIG}]`;

async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  const configPath = flags.config || DEFAULT_CONFIG;
  if (cmd === "install") {
    if (process.getuid?.() !== 0) throw new Error("install doit être lancé en root (sudo).");
    const cfg = defaults({
      ...(flags.user ? { user: flags.user } : {}), ...(flags.unit ? { unit: flags.unit } : {}), ...(flags.home ? { home: flags.home } : {}),
      ...(flags.port ? { port: Number(flags.port) } : {}), ...(flags.releases ? { releases: flags.releases } : {}),
      ...(flags.current ? { current: flags.current } : {}), ...(flags["state-dir"] ? { stateDir: flags["state-dir"] } : {}),
      ...(flags.systemctl ? { systemctl: flags.systemctl } : {}), ...(flags.npm ? { npm: flags.npm } : {}),
    });
    if (!Number.isInteger(cfg.port) || cfg.port <= 0) throw new Error("--port invalide");
    for (const line of install(cfg, configPath, { systemd: !("no-systemd" in flags), ...(flags["install-dir"] ? { installDir: flags["install-dir"] } : {}) })) console.log(`  ✓ ${line}`);
    console.log("cogitator-updater installé. Le bouton « Mettre à jour » de Cogitator l'utilisera automatiquement.");
    return 0;
  }
  if (cmd === "run") {
    const cfg = loadConfig(configPath);
    const uid = uidOf(cfg.user);
    const result = await runOnce(cfg, [0, ...(uid !== null ? [uid] : [])]);
    if (result) console.log(`${result.status}${result.target ? ` ${result.target}` : ""}${result.message ? ` — ${result.message}` : ""}`);
    return result && (result.status === "error" || result.status === "rolled-back") ? 1 : 0;
  }
  if (cmd === "status") { console.log(JSON.stringify(readStatus(loadConfig(configPath)), null, 2)); return 0; }
  if (cmd === "uninstall") {
    if (process.getuid?.() !== 0) throw new Error("uninstall doit être lancé en root (sudo).");
    const cfg = loadConfig(configPath);
    spawnSync(cfg.systemctl, ["disable", "--now", "cogitator-updater.path"]);
    for (const name of ["cogitator-updater.service", "cogitator-updater.path"]) rmSync(join(SYSTEMD_DIR, name), { force: true });
    spawnSync(cfg.systemctl, ["daemon-reload"]);
    rmSync(cfg.stateDir, { recursive: true, force: true });
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    rmSync(configPath, { force: true });
    console.log("cogitator-updater désinstallé (les releases sous /opt sont conservées).");
    return 0;
  }
  console.log(USAGE);
  return cmd === "help" ? 0 : 2;
}

const invoked = process.argv[1] && (() => { try { return statSync(process.argv[1]!).isFile() && basename(process.argv[1]!).startsWith("cogitator-updater"); } catch { return false; } })();
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: Error) => { console.error(`[cogitator-updater] ${error.message}`); process.exitCode = 1; });
}
