import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Lit un JSON tolérant (fichier absent → fallback). */
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Écriture atomique : tmp + rename, backup `.bak` de l'ancien. */
export function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(tmp, path);
}
