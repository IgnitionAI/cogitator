import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PDEATHSIG (PR_SET_PDEATHSIG) est délivré à la mort du *thread* parent, pas du
 * process. RpcClient.spawn doit donc s'exécuter depuis le thread principal Node
 * (pas worker_threads). Cogitator n'utilise pas worker_threads sur ce chemin.
 */

const WRAP_JS = fileURLToPath(new URL("./pi-rpc-wrap.js", import.meta.url));

let cachedSetpriv: string | null | undefined;
let cachedShimDir: string | undefined;

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

/**
 * Répertoire mis en tête de PATH pour que `spawn("node", …)` d'RpcClient
 * exécute un shim `exec setpriv --pdeathsig KILL <node réel> …`.
 * `exec` remplace le shim : l'enfant direct de l'hôte est pi, PDEATHSIG vise l'hôte.
 */
function setprivShimDir(): string | undefined {
  const setpriv = linuxSetprivPath();
  if (!setpriv) return undefined;
  if (cachedShimDir) return cachedShimDir;
  const dir = join(tmpdir(), `cogitator-pdeathsig-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh\nexec ${shQuote(setpriv)} --pdeathsig KILL ${shQuote(process.execPath)} "$@"\n`;
  const dest = join(dir, "node");
  writeFileSync(dest, script, { encoding: "utf8" });
  chmodSync(dest, 0o755);
  cachedShimDir = dir;
  return dir;
}

export function piRpcWrapPath(): string {
  if (!existsSync(WRAP_JS)) throw new Error(`wrapper rpc pi introuvable: ${WRAP_JS}`);
  return WRAP_JS;
}

/** Options RpcClient : setpriv via PATH si possible, sinon wrapper watchdog. */
export function guardedRpcSpawn(
  piCliPath: string,
  opts: { cwd: string; args: string[]; env?: Record<string, string> },
): { cliPath: string; cwd: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { ...opts.env };
  const shim = setprivShimDir();
  if (shim) {
    const rest = env.PATH ?? process.env.PATH ?? "";
    env.PATH = rest ? `${shim}:${rest}` : shim;
    return { cliPath: piCliPath, cwd: opts.cwd, args: opts.args, env };
  }
  env.COGITATOR_PI_CLI = piCliPath;
  return { cliPath: piRpcWrapPath(), cwd: opts.cwd, args: opts.args, env };
}
