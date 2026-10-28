#!/usr/bin/env node
/**
 * Repli sans setpriv : le process RpcClient est ce wrapper.
 * Il spawn le vrai cli pi et quitte si l'hôte (pid:starttime) meurt ou est réutilisé.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WATCH_MS = 1500;

function parseProcStat(stat) {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const state = rest[0];
  const starttime = rest[19];
  if (!state || starttime === undefined || starttime === "") return undefined;
  return { state, starttime };
}

function readProcStat(pid) {
  try {
    return parseProcStat(readFileSync(join("/proc", String(pid), "stat"), "utf8"));
  } catch {
    return undefined;
  }
}

function parseMarker(value) {
  const sep = value.indexOf(":");
  if (sep <= 0) return undefined;
  const pid = Number(value.slice(0, sep));
  const starttime = value.slice(sep + 1);
  if (!Number.isInteger(pid) || pid <= 0 || starttime === "") return undefined;
  return { pid, starttime };
}

function hostGone(marker) {
  const stat = readProcStat(marker.pid);
  return !stat || stat.state === "Z" || stat.starttime !== marker.starttime;
}

const realCli = process.env.COGITATOR_PI_CLI;
if (!realCli) {
  process.stderr.write("COGITATOR_PI_CLI manquant\n");
  process.exit(1);
}

const marker = parseMarker(process.env.COGITATOR_OWNED_PI ?? "");
const child = spawn(process.execPath, [realCli, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (err) => {
  process.stderr.write(String(err));
  process.exit(1);
});

if (process.platform !== "win32" && marker) {
  const timer = setInterval(() => {
    if (!hostGone(marker)) return;
    try { child.kill("SIGKILL"); } catch { /* déjà mort */ }
    process.exit(1);
  }, WATCH_MS);
  timer.unref?.();
}
