import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Identité écrite par un serveur Cogitator à l'écoute : elle permet à l'extension
 * `/cogitator` de savoir *quel* process détient le port avant de décider d'un arrêt. */
export interface ServerIdentity {
  pid: number;
  version: string;
  port: number;
  startedAt: string;
}

/** `<home>/server.pid` — même home que la base et le verrou d'instance. */
export function serverIdentityPath(home: string): string {
  return join(home, "server.pid");
}

/** Valide strictement le contenu d'un pidfile ; `null` si absent, illisible ou incohérent. */
export function parseServerIdentity(raw: unknown): ServerIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const { pid, version, port, startedAt } = r;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof version !== "string" || version.trim() === "") return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (typeof startedAt !== "string" || startedAt === "") return null;
  return { pid, version, port, startedAt };
}

export function readServerIdentity(home: string): ServerIdentity | null {
  try {
    return parseServerIdentity(JSON.parse(readFileSync(serverIdentityPath(home), "utf8")));
  } catch {
    return null;
  }
}

/** Écriture atomique (tmp + rename), mode 0600 : un lecteur ne voit jamais un JSON partiel. */
export function writeServerIdentity(home: string, identity: ServerIdentity): void {
  const target = serverIdentityPath(home);
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(identity));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
}

/** Supprime le pidfile seulement s'il désigne encore `pid` (jamais celui d'une instance plus récente). */
export function removeServerIdentity(home: string, pid: number): void {
  const current = readServerIdentity(home);
  if (current && current.pid !== pid) return;
  try {
    unlinkSync(serverIdentityPath(home));
  } catch {
    // Déjà supprimé (arrêt concurrent) : rien à faire.
  }
}

/** `kill(pid, 0)` : vrai si le process existe encore, y compris sans droit de signal. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
