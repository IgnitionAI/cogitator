import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPaths } from "./paths.js";
import { buildChildEnv, providerFromSpawnArgs } from "./spawn.js";

/**
 * PDEATHSIG (PR_SET_PDEATHSIG) est délivré à la mort du *thread* parent, pas du
 * process. RpcClient.spawn doit donc s'exécuter depuis le thread principal Node
 * (pas worker_threads). Cogitator n'utilise pas worker_threads sur ce chemin.
 */

const WRAP_JS = fileURLToPath(new URL("./pi-rpc-wrap.js", import.meta.url));
const NO_SETPRIV = "COGITATOR_PI_NO_SETPRIV";
const SHIM_PREFIX = "pdeathsig-";

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
function setprivShimDir(home: string): string | undefined {
  if (!setprivAllowed()) return undefined;
  const setpriv = linuxSetprivPath();
  if (!setpriv) return undefined;
  const existing = shimDirs.get(home);
  if (existing) return existing;
  mkdirSync(home, { recursive: true });
  const dir = mkdtempSync(join(home, SHIM_PREFIX));
  chmodSync(dir, 0o700);
  // PATH recalculé à chaque exécution du shim (pas figé au premier spawn) : on retire
  // le dossier de shim du PATH de l'appelant, puis on exec setpriv. Les outils de pi
  // (bash, nohup node) héritent donc du PATH de l'appelant, sans le pdeathsig.
  const script = [
    "#!/bin/sh",
    `shim=${shQuote(dir)}`,
    'case $PATH in',
    '  "$shim:"*) caller_path=${PATH#"$shim:"} ;;',
    '  "$shim") caller_path= ;;',
    '  *) caller_path=$PATH ;;',
    'esac',
    `PATH=$caller_path exec ${shQuote(setpriv)} --pdeathsig KILL ${shQuote(process.execPath)} "$@"`,
    "",
  ].join("\n");
  const dest = join(dir, "node");
  writeFileSync(dest, script, { encoding: "utf8" });
  chmodSync(dest, 0o755);
  shimDirs.set(home, dir);
  return dir;
}

/**
 * Dossiers de shim encore référencés par un process vivant (PATH d'un `/proc/<pid>/environ`)
 * plus ceux créés par ce process. Limite : hors Linux (`/proc` absent) ou pour un process
 * d'un autre utilisateur (environ illisible), on ne peut pas savoir → on ne supprime rien.
 */
function pdeathsigDirsInUse(): Set<string> {
  const used = new Set<string>(shimDirs.values());
  if (process.platform !== "linux") return used;
  let pids: string[];
  try {
    pids = readdirSync("/proc");
  } catch {
    return used;
  }
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    let environ: string;
    try {
      environ = readFileSync(join("/proc", name, "environ"), "utf8");
    } catch {
      continue;
    }
    for (const entry of environ.split("\0")) {
      if (!entry.startsWith("PATH=")) continue;
      for (const part of entry.slice("PATH=".length).split(":")) {
        if (part.includes(`/${SHIM_PREFIX}`)) used.add(part);
      }
    }
  }
  return used;
}

/**
 * Ramasse les shims `pdeathsig-*` orphelins d'un hôte tué sans arrêt propre (`kill -9`,
 * crash), à appeler au démarrage une fois le home verrouillé. Un dossier référencé par
 * le PATH d'un process vivant est conservé. Renvoie les dossiers supprimés.
 */
export function reapStaleSetprivShims(home: string): string[] {
  // Sans `/proc` on ne sait pas distinguer un shim vivant d'un orphelin : on ne touche à rien.
  if (process.platform !== "linux") return [];
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  const candidates = names.filter((name) => name.startsWith(SHIM_PREFIX)).map((name) => join(home, name));
  if (!candidates.length) return [];
  const inUse = pdeathsigDirsInUse();
  const removed: string[] = [];
  for (const dir of candidates) {
    if (inUse.has(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* déjà parti ou protégé */
    }
  }
  return removed;
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

export interface GuardedRpcClient {
  start(): Promise<void>;
  stop?: () => Promise<void>;
}

/**
 * Remplace `process.env` le temps d'un appel synchrone jusqu'au premier await.
 * RpcClient.start() fait `env: { ...process.env, ...options.env }` puis `await`
 * : le spawn a déjà eu lieu, on restaure avant de rendre la main à l'event loop.
 */
export function runWithProcessEnv<T>(env: Record<string, string>, fn: () => T): T {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) snapshot[key] = process.env[key];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function bindChildEnvOnStart<T extends GuardedRpcClient>(client: T, env: Record<string, string>): T {
  const start = client.start.bind(client);
  client.start = () => runWithProcessEnv(env, start);
  return client;
}

/** Options RpcClient : env à liste d'autorisation, setpriv via PATH si possible, sinon wrapper watchdog. */
export function guardedRpcSpawn(
  piCliPath: string,
  opts: { cwd: string; args: string[]; env?: Record<string, string> },
): GuardedRpcSpawn {
  const env = buildChildEnv({
    provider: providerFromSpawnArgs(opts.args),
    extra: opts.env,
  });
  const home = env.COGITATOR_HOME ?? getPaths().home;
  const origPath = env.PATH ?? "";
  const shim = setprivShimDir(home);
  if (shim) {
    env.PATH = origPath ? `${shim}:${origPath}` : shim;
    return { cliPath: piCliPath, cwd: opts.cwd, args: opts.args, env, shimDir: shim };
  }
  env.COGITATOR_PI_CLI = piCliPath;
  return { cliPath: piRpcWrapPath(), cwd: opts.cwd, args: opts.args, env };
}

export function createGuardedRpcClient<T extends GuardedRpcClient>(
  RpcClient: new (opts: GuardedRpcSpawn) => T,
  piCliPath: string,
  opts: { cwd: string; args: string[]; env?: Record<string, string> },
): T {
  const spawnOpts = guardedRpcSpawn(piCliPath, opts);
  return bindChildEnvOnStart(new RpcClient(spawnOpts), spawnOpts.env);
}
