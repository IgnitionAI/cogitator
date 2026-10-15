/**
 * Identité et classification des workers de mission (Plan 0002 §5.7) : un
 * crash peut laisser une commande worker en vie ; l'identité est persistée
 * AVANT le dispatch, et au redémarrage on observe/arrête et on classe avant
 * tout travail de remplacement.
 */

import { defineDoc } from "@earendil-works/pi-durable";

/** Enregistrement durable d'un worker dispatché par un outil de mission. */
export type WorkerRecord = {
  id: string;
  pid: number;
  command: string;
  dispatchedAt: number;
  /** Disposition terminale connue (écrite après observation/arrêt). */
  disposition?: "recorded-stopped" | "completed" | "failed";
};

export type WorkerRecordsDoc = { workers: WorkerRecord[] };

export const WorkerRecords = defineDoc<WorkerRecordsDoc>({
  kind: "cogitator.workers",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ workers: [] }),
});

export type WorkerClassification =
  | { kind: "resolved"; record: WorkerRecord }
  | { kind: "live-orphan"; record: WorkerRecord }
  | { kind: "exited-unknown"; record: WorkerRecord };

/** true si un processus vit sous ce pid (ESRCH = mort ; EPERM = vivant, pas à nous). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function classifyWorker(record: WorkerRecord): WorkerClassification {
  if (record.disposition) return { kind: "resolved", record };
  if (pidAlive(record.pid)) return { kind: "live-orphan", record };
  // Plus de processus et aucune disposition/receipt : l'issue est inétablie.
  return { kind: "exited-unknown", record };
}

export function classifyWorkers(records: readonly WorkerRecord[]): WorkerClassification[] {
  return records.map(classifyWorker);
}

/** Des workers non résolus (orphelin vivant OU issue inconnue) bloquent la reprise. */
export function unresolvedWorkers(classifications: readonly WorkerClassification[]): WorkerClassification[] {
  return classifications.filter((c) => c.kind !== "resolved");
}
