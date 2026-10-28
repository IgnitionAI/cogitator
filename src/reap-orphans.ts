import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Marqueur posé sur les process pi spawnes par Cogitator (hors pool.ts). */
export const OWNED_PI_ENV = "COGITATOR_OWNED_PI";

function ppidOf(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = stat.slice(close + 1).trim().split(" ");
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

function environHas(environ: string, key: string, value: string): boolean {
  return environ.split("\0").includes(`${key}=${value}`);
}

/**
 * Tue les process pi orphelins (ppid 1) issus d'un hôte Cogitator tué par SIGKILL.
 * Identification : env `COGITATOR_OWNED_PI=1` + même `COGITATOR_HOME`. Hors pool.ts.
 */
export function reapOrphanOwnedPi(home: string, signal: NodeJS.Signals = "SIGKILL"): { pids: number[] } {
  if (process.platform === "win32") return { pids: [] };
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return { pids: [] };
  }
  const pids: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: string;
    let stat: string;
    try {
      environ = readFileSync(join("/proc", name, "environ"), "utf8");
      stat = readFileSync(join("/proc", name, "stat"), "utf8");
    } catch {
      continue;
    }
    if (!environHas(environ, OWNED_PI_ENV, "1")) continue;
    if (!environHas(environ, "COGITATOR_HOME", home)) continue;
    if (ppidOf(stat) !== 1) continue;
    pids.push(pid);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* déjà mort */
    }
  }
  return { pids };
}
