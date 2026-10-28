import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPaths } from "./paths.js";

/**
 * PDEATHSIG (PR_SET_PDEATHSIG) est délivré à la mort du *thread* parent, pas du
 * process. RpcClient.spawn doit donc s'exécuter depuis le thread principal Node
 * (pas worker_threads). Cogitator n'utilise pas worker_threads sur ce chemin.
 */

const WRAP_JS = fileURLToPath(new URL("./pi-rpc-wrap.js", import.meta.url));
const NO_SETPRIV = "COGITATOR_PI_NO_SETPRIV";

let cachedSetpriv: string | null | undefined;
const shimDirs = new Map<string, string>();

/** util-linux `setpriv`, détecté à l'exécution (absent hors Linux / hors PATH). */
export function linuxSetprivPath(): string | undefined {
  if (cachedSetpriv !== undefined) return cachedSetpriv ?? undefined;
  if (process.platform !== "linux") {
    cachedSetpriv = null;
    return undefined;
  }
  try {
    const found = execFileSync("which", ["setpriv"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!found) {
      cachedSetpriv = null;
      return undefined;
    }
    execFileSync(found, ["--help"], { stdio: ["ignore", "pipe", "ignore"] });
    cachedSetpriv = found;
    return found;
  } catch {
    cachedSetpriv = null;
    return undefined;
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function setprivAllowed(): boolean {
  return process.env[NO_SETPRIV] !== "1";
}

/**
 * Répertoire mis en tête de PATH pour que `spawn("node", …)` d'RpcClient
 * exécute un shim. Le shim restaure PATH avant exec setpriv, pour que les
 * outils de pi (bash / nohup node) n'héritent pas du pdeathsig.
 */
function setprivShimDir(home: string, origPath: string): string | undefined {
  if (!setprivAllowed()) return undefined;
  const setpriv = linuxSetprivPath();
  if (!setpriv) return undefined;
  const existing = shimDirs.get(home);
  if (existing) return existing;
  mkdirSync(home, { recursive: true });
  const dir = mkdtempSync(join(home, "pdeathsig-"));
  chmodSync(dir, 0o700);
  const script = `#!/bin/sh\nPATH=${shQuote(origPath)} exec ${shQuote(setpriv)} --pdeathsig KILL ${shQuote(process.execPath)} "$@"\n`;
  const dest = join(dir, "node");
  writeFileSync(dest, script, { encoding: "utf8" });
  chmodSync(dest, 0o755);
  shimDirs.set(home, dir);
  return dir;
}

export function piRpcWrapPath(): string {
  if (!existsSync(WRAP_JS)) throw new Error(`wrapper rpc pi introuvable: ${WRAP_JS}`);
  return WRAP_JS;
}

/** Supprime les shims setpriv (arrêt de l'hôte). */
export function disposeSetprivShims(): void {
  for (const dir of shimDirs.values()) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* déjà parti */ }
  }
  shimDirs.clear();
}

export interface GuardedRpcSpawn {
  cliPath: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  shimDir?: string;
}

/** Options RpcClient : setpriv via PATH si possible, sinon wrapper watchdog. */
export function guardedRpcSpawn(
  piCliPath: string,
  opts: { cwd: string; args: string[]; env?: Record<string, string> },
): GuardedRpcSpawn {
  const env: Record<string, string> = { ...opts.env };
  const home = env.COGITATOR_HOME ?? getPaths().home;
  const origPath = env.PATH ?? process.env.PATH ?? "";
  const shim = setprivShimDir(home, origPath);
  if (shim) {
    env.PATH = origPath ? `${shim}:${origPath}` : shim;
    return { cliPath: piCliPath, cwd: opts.cwd, args: opts.args, env, shimDir: shim };
  }
  env.COGITATOR_PI_CLI = piCliPath;
  return { cliPath: piRpcWrapPath(), cwd: opts.cwd, args: opts.args, env };
}
