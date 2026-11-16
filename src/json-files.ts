import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";

/** Lit un JSON. Fichier absent → fallback ; toute autre erreur (JSON tronqué, EACCES, …) est remontée. */
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

function writeTempJson(tmp: string, data: string, mode?: number): void {
  const fd = mode === undefined ? openSync(tmp, "w") : openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Écriture atomique : tmp aléatoire + fsync + rename, backup `.bak` de l'ancien. */
export function atomicWriteJson(path: string, value: unknown, mode?: number): void {
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  writeTempJson(tmp, JSON.stringify(value, null, 2) + "\n", mode);
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
    if (mode !== undefined) chmodSync(`${path}.bak`, mode);
  }
  renameSync(tmp, path);
}
