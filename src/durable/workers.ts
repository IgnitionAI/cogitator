/**
 * Identité et classification des workers de mission (Plan 0002 §5.7, #47) :
 * l'intention de création est persistée AVANT le lancement ; l'identité
 * immuable (exécution, mission, workspace, backend, handle) est vérifiée à
 * chaque inspect/stop/wait. Une disposition déclarative n'est pas une preuve
 * de sortie.
 */

import { defineDoc } from "@earendil-works/pi-durable";
import type { InspectObservation } from "../execution/worker-supervisor.js";

/** Intention gelée, persistée avant toute requête de création. */
export type WorkerCreationIntent = {
  workerId: string;
  executionId: string;
  missionId: string;
  workspaceDir: string;
  backendId: string;
  correlation: string;
  specBinding: string;
  createdAt: number;
};

/** Identité immuable d'un worker : le handle est la cible de mutation, jamais le PID. */
export type WorkerIdentity = {
  workerId: string;
  executionId: string;
  missionId: string;
  workspaceDir: string;
  backendId: string;
  immutableHandle: string;
  starttime: string;
  observationalPid: number;
};

/** Preuve terminale : cessation d'écriture observée, distincte du résultat métier. */
export type VerifiedExit = {
  writingStopped: true;
  observedAt: number;
};

export type WorkerLifecycle =
  | "intent"
  | "created"
  | "started"
  | "stop_requested"
  | "exit_verified"
  | "unknown"
  | "attention";

/** Enregistrement durable d'un worker dispatché par un outil de mission. */
export type WorkerRecord = {
  id: string;
  /** PID observationnel uniquement — jamais une cible de signal. */
  pid: number;
  command: string;
  dispatchedAt: number;
  /** @deprecated Non probant. Conservé pour les journaux existants. */
  disposition?: "recorded-stopped" | "completed" | "failed";
  intent?: WorkerCreationIntent;
  identity?: WorkerIdentity;
  exitProof?: VerifiedExit;
  revision?: number;
  lifecycle?: WorkerLifecycle;
  attentionReason?: string;
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
  | { kind: "exited-unknown"; record: WorkerRecord }
  | { kind: "attention"; record: WorkerRecord; reason: string };

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

export function classifyWorker(record: WorkerRecord, observation: InspectObservation): WorkerClassification {
  if (record.exitProof?.writingStopped) return { kind: "resolved", record };
  switch (observation.kind) {
    case "running":
      return { kind: "live-orphan", record };
    case "missing":
      return { kind: "exited-unknown", record };
    case "pid_reuse":
    case "identity_mismatch":
    case "unavailable":
      return { kind: "attention", record, reason: observation.kind };
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}

/** Des workers non résolus (orphelin, inconnu, attention) bloquent la reprise. */
export function unresolvedWorkers(classifications: readonly WorkerClassification[]): WorkerClassification[] {
  return classifications.filter((c) => c.kind !== "resolved");
}
