import { chmodSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";

/** Lit un JSON tolérant (fichier absent → fallback). */
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function refuseUnsafeJsonPath(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`écriture JSON refusée : ${path} est un lien symbolique ou n'est pas un fichier régulier`);
  }
}

const NOFOLLOW_WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

function writeFileNoFollow(path: string, data: string | Uint8Array, mode?: number): void {
  const fd = mode === undefined ? openSync(path, NOFOLLOW_WRITE) : openSync(path, NOFOLLOW_WRITE, mode);
  try {
    if (typeof data === "string") writeSync(fd, data);
    else writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function copyFileNoFollow(src: string, dest: string): void {
  const srcFd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    writeFileNoFollow(dest, readFileSync(srcFd));
  } finally {
    closeSync(srcFd);
  }
}

/** Écriture atomique : tmp + rename, backup `.bak` de l'ancien. Refuse les liens symboliques. */
export function atomicWriteJson(path: string, value: unknown, mode?: number): void {
  refuseUnsafeJsonPath(path);
  refuseUnsafeJsonPath(`${path}.bak`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileNoFollow(tmp, JSON.stringify(value, null, 2) + "\n", mode);
  if (existsSync(path)) {
    copyFileNoFollow(path, `${path}.bak`);
    if (mode !== undefined) chmodSync(`${path}.bak`, mode);
  }
  renameSync(tmp, path);
}
