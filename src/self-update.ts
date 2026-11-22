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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { findPackageRoot } from "./default-agent.js";
import type { Paths } from "./paths.js";

export const PACKAGE = "@ignitionai/cogitator";

export type SelfUpdateBlock = "SOURCE_BUILD" | "NOT_PI_MANAGED" | "SERVICE_MANAGED";
export interface SelfUpdateSupport { supported: boolean; reason?: SelfUpdateBlock }

export function selfUpdateSupport(paths: Paths, root: string | null = findPackageRoot(), env: NodeJS.ProcessEnv = process.env): SelfUpdateSupport {
  if (!root) return { supported: false, reason: "SOURCE_BUILD" };
  const piModules = join(paths.piAgentDir, "npm", "node_modules");
  let real: string, base: string;
  try { real = realpathSync(root); base = realpathSync(piModules); } catch { return { supported: false, reason: "NOT_PI_MANAGED" }; }
  if (!real.startsWith(base + sep)) return { supported: false, reason: "NOT_PI_MANAGED" };
  // Un service (systemd) gère lui-même le cycle de vie : pas de relance concurrente.
  if (env.INVOCATION_ID || env.COGITATOR_SELF_UPDATE === "0") return { supported: false, reason: "SERVICE_MANAGED" };
  return { supported: true };
}

export interface SelfUpdateState {
  status: "idle" | "installing" | "restarting" | "error";
  target?: string;
  error?: string;
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
}

export class SelfUpdateError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly detail?: Record<string, unknown>) { super(code); }
}

export class SelfUpdater {
  state: SelfUpdateState = { status: "idle" };
  constructor(private readonly deps: SelfUpdateDeps) {}

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
