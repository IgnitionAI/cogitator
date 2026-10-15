/**
 * Bail d'exécution (runtime lease, Plan 0002 §5 « Runtime lease » + §8
 * « Recovery ») : propriété OS-exclusive du stockage Durable par UN processus.
 *
 * Le SDK Durable n'a pas de bail inter-processus (constat P0) : on l'impose
 * ici avec `locking_mode = EXCLUSIVE` de SQLite (verrou de fichier OS via
 * better-sqlite3, déjà dépendance du contrôleur). Le second processus qui
 * ouvre la même base de bail obtient SQLITE_BUSY et sort SANS planifier quoi
 * que ce soit ; la mort du détenteur (SIGKILL inclus) libère le verrou côté OS.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export class RuntimeLeaseError extends Error {
  constructor(message = "bail d'exécution déjà détenu par un autre processus") {
    super(message);
    this.name = "RuntimeLeaseError";
  }
}

export interface RuntimeLease {
  readonly path: string;
  /** Ferme la connexion et libère le verrou OS. */
  release(): void;
}

export function acquireRuntimeLease(dir: string): RuntimeLease {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "lease.sqlite");
  const db = new Database(path);
  try {
    db.pragma("locking_mode = EXCLUSIVE");
    // Première instruction : prend le verrou EXCLUSIVE ; SQLITE_BUSY si un
    // autre processus détient déjà le bail. Pas de busy_timeout : échec net.
    db.exec("CREATE TABLE IF NOT EXISTS runtime_lease (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, acquired_at TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO runtime_lease (id, pid, acquired_at) VALUES (1, ?, datetime('now'))").run(process.pid);
  } catch (err) {
    db.close();
    if (err instanceof Error && "code" in err && err.code === "SQLITE_BUSY") throw new RuntimeLeaseError();
    throw err;
  }
  return {
    path,
    release: () => {
      try {
        db.close();
      } catch {
        /* déjà fermé */
      }
    },
  };
}
