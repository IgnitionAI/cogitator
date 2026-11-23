/**
 * Mise à jour de Cogitator en un clic, pour une installation gérée par pi
 * (`pi install npm:@ignitionai/cogitator`, serveur lancé par `/cogitator`).
 *
 * 1. `pi install npm:@ignitionai/cogitator@<dernière>` : remplace le paquet sur place ;
 * 2. un relanceur détaché attend la fin de ce processus puis relance la même commande ;
 * 3. le serveur s'arrête proprement (SIGTERM → arrêt habituel de cli.ts).
 *
 * Refusé pour une release source ou un service systemd : leur code n'appartient pas au
 * compte du serveur (protection voulue) ; l'UI affiche alors la procédure du guide VPS.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { findPackageRoot } from "./default-agent.js";
import type { Paths } from "./paths.js";

export const PACKAGE = "@ignitionai/cogitator";

export type SelfUpdateBlock = "SOURCE_BUILD" | "NOT_PI_MANAGED" | "SERVICE_MANAGED";
/** `pi` : installation gérée par pi ; `updater` : service root cogitator-updater (VPS systemd). */
export interface SelfUpdateSupport { supported: boolean; mode?: "pi" | "updater"; reason?: SelfUpdateBlock }

/** Dossier d'état du service cogitator-updater (voir src/updater/cogitator-updater.ts). */
export function updaterDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COGITATOR_UPDATER_DIR ?? "/var/lib/cogitator-updater";
}

/** Updater installé : status.json lisible et inbox/ accessible en écriture pour ce compte. */
export function updaterAvailable(dir: string): boolean {
  try {
    accessSync(join(dir, "status.json"), constants.R_OK);
    accessSync(join(dir, "inbox"), constants.W_OK | constants.X_OK);
    return true;
  } catch { return false; }
}

export interface UpdaterStatus { status: string; target?: string; from?: string; message?: string; at?: string }
export function readUpdaterStatus(dir: string): UpdaterStatus | null {
  try { return JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as UpdaterStatus; } catch { return null; }
}

/** Dépôt atomique de la demande (fichier temporaire du même dossier puis rename). */
export function requestUpdater(dir: string, version: string): void {
  const inbox = join(dir, "inbox");
  const tmp = join(inbox, `.request-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify({ version, requested_at: new Date().toISOString() }), { mode: 0o640 });
  renameSync(tmp, join(inbox, "request.json"));
}

export function selfUpdateSupport(paths: Paths, root: string | null = findPackageRoot(), env: NodeJS.ProcessEnv = process.env): SelfUpdateSupport {
  if (env.COGITATOR_SELF_UPDATE === "0") return { supported: false, reason: "SERVICE_MANAGED" };
  if (updaterAvailable(updaterDir(env))) return { supported: true, mode: "updater" };
  if (!root) return { supported: false, reason: "SOURCE_BUILD" };
  const piModules = join(paths.piAgentDir, "npm", "node_modules");
  let real: string, base: string;
  try { real = realpathSync(root); base = realpathSync(piModules); } catch { return { supported: false, reason: "NOT_PI_MANAGED" }; }
  if (!real.startsWith(base + sep)) return { supported: false, reason: "NOT_PI_MANAGED" };
  // Un service (systemd) gère lui-même le cycle de vie : pas de relance concurrente.
  if (env.INVOCATION_ID) return { supported: false, reason: "SERVICE_MANAGED" };
  return { supported: true, mode: "pi" };
}

/**
 * Commande d'installation du service cogitator-updater, pré-remplie pour CE serveur
 * (affichée par l'UI quand la mise à jour en un clic n'est pas encore possible sur un VPS systemd).
 */
export function updaterSetupCommand(input: {
  support: SelfUpdateSupport; root: string | null; home: string; port: number; user: string;
  env?: NodeJS.ProcessEnv; cgroup?: () => string; platform?: NodeJS.Platform;
}): string | null {
  const { support, root } = input;
  if (support.supported || !root) return null;
  if (support.reason !== "NOT_PI_MANAGED" && support.reason !== "SERVICE_MANAGED") return null;
  if ((input.platform ?? process.platform) !== "linux") return null;
  const env = input.env ?? process.env;
  let unit = env.COGITATOR_SERVICE_UNIT ?? "";
  if (!unit) {
    try {
      const text = (input.cgroup ?? (() => readFileSync("/proc/self/cgroup", "utf8")))();
      unit = [...text.matchAll(/([\w@.-]+\.service)\b/g)].pop()?.[1] ?? "";
    } catch { /* pas de cgroup lisible */ }
  }
  if (!unit || unit.startsWith("user@") || unit.startsWith("session-")) unit = "cogitator.service";
  const quote = (v: string) => /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
  const script = join(root, "dist", "src", "updater", "cogitator-updater.js");
  return `sudo node ${quote(script)} install --user ${quote(input.user)} --unit ${quote(unit)} --home ${quote(input.home)} --port ${input.port}`;
}

export interface SelfUpdateState {
  status: "idle" | "installing" | "restarting" | "error";
  target?: string;
  error?: string;
  /** Étape détaillée du service updater (downloading, installing, switching…). */
  step?: string;
}

export interface SelfUpdateDeps {
  support: () => SelfUpdateSupport;
  /** Dernière version publiée (vérifiée) et version en cours. */
  release: () => Promise<{ current: string; latest: string; status: string }>;
  busy: () => Promise<number>;
  install: (source: string) => Promise<void>;
  /** Version présente sur disque après installation. */
  installedVersion: () => string | null;
  relaunch: () => void;
  shutdown: () => void;
  /** Mode updater : dépose la demande et lit l'avancement du service root. */
  requestUpdater?: (version: string) => void;
  updaterStatus?: () => UpdaterStatus | null;
}

export class SelfUpdateError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly detail?: Record<string, unknown>) { super(code); }
}

export class SelfUpdater {
  private internal: SelfUpdateState = { status: "idle" };
  private requestedAt = 0;
  constructor(private readonly deps: SelfUpdateDeps) {}

  /** État courant ; en mode updater, il suit le status.json du service root. */
  get state(): SelfUpdateState {
    const s = this.internal;
    // Processus relancé après un retour arrière : signaler l'échec récent du service updater.
    if (s.status === "idle" && this.deps.updaterStatus) {
      const u = this.deps.updaterStatus();
      if (u && (u.status === "rolled-back" || u.status === "error") && u.at && Date.now() - Date.parse(u.at) < 5 * 60_000) {
        return { status: "error", target: u.target, step: u.status, error: u.message ?? u.status };
      }
    }
    if (!this.requestedAt || s.status !== "installing" || !this.deps.updaterStatus) return s;
    const u = this.deps.updaterStatus();
    if (!u || u.target !== s.target || (u.at && Date.parse(u.at) < this.requestedAt - 1000)) return s;
    if (u.status === "error" || u.status === "rolled-back") return { status: "error", target: s.target, step: u.status, error: u.message ?? u.status };
    if (u.status === "restarting" || u.status === "verifying" || u.status === "rolling-back") return { status: "restarting", target: s.target, step: u.status };
    return { ...s, step: u.status };
  }
  set state(value: SelfUpdateState) { this.internal = value; }

  /** Lance la mise à jour ; l'installation se poursuit en tâche de fond (suivie par `state`). */
  async start(force = false): Promise<SelfUpdateState> {
    if (this.state.status === "installing" || this.state.status === "restarting") throw new SelfUpdateError("SELF_UPDATE_RUNNING");
    const support = this.deps.support();
    if (!support.supported) throw new SelfUpdateError(`SELF_UPDATE_${support.reason}`, 400);
    const release = await this.deps.release();
    if (release.status !== "available") throw new SelfUpdateError("SELF_UPDATE_NOT_AVAILABLE", 409, { current: release.current, latest: release.latest });
    const busy = await this.deps.busy();
    if (busy > 0 && !force) throw new SelfUpdateError("SELF_UPDATE_BUSY", 409, { busy });
    const target = release.latest;
    if (support.mode === "updater") {
      if (!this.deps.requestUpdater) throw new SelfUpdateError("SELF_UPDATE_SERVICE_MANAGED", 400);
      this.deps.requestUpdater(target);
      this.requestedAt = Date.now();
      this.state = { status: "installing", target, step: "requested" };
      return { ...this.state };
    }
    this.requestedAt = 0;
    this.state = { status: "installing", target };
    void this.run(target);
    return { ...this.state };
  }

  private async run(target: string): Promise<void> {
    try {
      await this.deps.install(`npm:${PACKAGE}@${target}`);
      const installed = this.deps.installedVersion();
      if (installed !== target) throw new Error(`Version installée inattendue : ${installed ?? "inconnue"}`);
      this.state = { status: "restarting", target };
      this.deps.relaunch();
      // Laisse le temps à l'UI de lire l'état « restarting » avant l'arrêt.
      setTimeout(() => this.deps.shutdown(), 500).unref();
    } catch (error) {
      this.state = { status: "error", target, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function installedPackageVersion(root: string | null = findPackageRoot()): string | null {
  if (!root) return null;
  const file = join(root, "package.json");
  if (!existsSync(file)) return null;
  try { const v = JSON.parse(readFileSync(file, "utf8")).version; return typeof v === "string" ? v : null; } catch { return null; }
}

/**
 * Relanceur détaché : attend la sortie de ce processus (60 s max), puis relance
 * exactement la même commande (`node …/cli.js [--auth-required]`) avec le même environnement.
 */
export function spawnRelauncher(pid = process.pid, exec = process.execPath, args = process.argv.slice(1), env = process.env): void {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const [pid, exec, ...args] = process.argv.slice(1);",
    "const deadline = Date.now() + 60000;",
    "const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };",
    "(function wait() {",
    "  if (alive() && Date.now() < deadline) return setTimeout(wait, 200);",
    "  spawn(exec, args, { detached: true, stdio: 'ignore' }).unref();",
    "})();",
  ].join("\n");
  spawn(process.execPath, ["-e", script, String(pid), exec, ...args], { detached: true, stdio: "ignore", env }).unref();
}
