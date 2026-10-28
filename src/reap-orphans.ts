import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reapIntervalMs } from "./config.js";

/** Marqueur posé sur les process pi spawnés par Cogitator (hors pool.ts) : `pid:starttime`. */
export const OWNED_PI_ENV = "COGITATOR_OWNED_PI";

export interface ProcStat {
  ppid: number;
  starttime: string;
  state: string;
}

/** `/proc/<pid>/stat` : comm entre parenthèses, puis champs 3… ; le 22 est starttime. */
export function parseProcStat(stat: string): ProcStat | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const state = rest[0];
  const ppid = Number(rest[1]);
  const starttime = rest[19];
  if (!state || !Number.isInteger(ppid) || starttime === undefined || starttime === "") return undefined;
  return { ppid, starttime, state };
}

export function readProcStat(pid: number): ProcStat | undefined {
  try {
    return parseProcStat(readFileSync(join("/proc", String(pid), "stat"), "utf8"));
  } catch {
    return undefined;
  }
}

export function parseOwnedPiMarker(value: string): { pid: number; starttime: string } | undefined {
  const sep = value.indexOf(":");
  if (sep <= 0) return undefined;
  const pid = Number(value.slice(0, sep));
  const starttime = value.slice(sep + 1);
  if (!Number.isInteger(pid) || pid <= 0 || starttime === "") return undefined;
  return { pid, starttime };
}

/** Marqueur de l'hôte courant (pid + starttime) pour battre la réutilisation de pid. */
export function ownedPiMarker(pid = process.pid): string | undefined {
  const stat = readProcStat(pid);
  return stat ? `${pid}:${stat.starttime}` : undefined;
}

export function ownerStillAlive(marker: { pid: number; starttime: string }): boolean {
  const stat = readProcStat(marker.pid);
  return Boolean(stat && stat.state !== "Z" && stat.starttime === marker.starttime);
}

/** Mort, zombie, ou pid réutilisé : `kill(pid, 0)` réussit encore sur un zombie. */
export function processIsGone(pid: number): boolean {
  const stat = readProcStat(pid);
  if (!stat || stat.state === "Z") return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function environEntry(environ: string, key: string): string | undefined {
  const prefix = `${key}=`;
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return undefined;
}

/** Uniquement le process rpc (`node … --mode rpc`), pas les descendants détachés (xdg-open, nohup). */
export function isPiRpcCmdline(cmdline: string): boolean {
  const parts = cmdline.split("\0");
  return parts.some((part, i) => part === "--mode" && parts[i + 1] === "rpc");
}

function readCmdline(pid: number): string | undefined {
  try {
    return readFileSync(join("/proc", String(pid), "cmdline"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Tue les process pi orphelins d'un hôte Cogitator mort (SIGKILL, subreaper, pid réutilisé).
 * Orphelin = marqueur `pid:starttime` + même `COGITATOR_HOME` + cmdline `--mode rpc`,
 * et l'hôte n'est plus ce process (pid mort, starttime différent). Jamais un process
 * sans marqueur, sans cmdline rpc, ni un process dont l'hôte est encore vivant.
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
    try {
      environ = readFileSync(join("/proc", name, "environ"), "utf8");
    } catch {
      continue;
    }
    if (environEntry(environ, "COGITATOR_HOME") !== home) continue;
    const marker = parseOwnedPiMarker(environEntry(environ, OWNED_PI_ENV) ?? "");
    if (!marker) continue;
    const cmdline = readCmdline(pid);
    if (!cmdline || !isPiRpcCmdline(cmdline)) continue;
    if (ownerStillAlive(marker)) continue;
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

export function startPeriodicReap(home: string, intervalMs = reapIntervalMs()): { stop(): void } {
  if (intervalMs <= 0) return { stop() { /* désactivé */ } };
  const timer = setInterval(() => { reapOrphanOwnedPi(home); }, intervalMs);
  timer.unref?.();
  return { stop() { clearInterval(timer); } };
}
