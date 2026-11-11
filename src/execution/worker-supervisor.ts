/**
 * Contrôleur de cycle de vie des workers (ticket #47 / IGN-184) : inspect,
 * stop et waitForExit ne s'appuient que sur une identité persistée et
 * re-vérifiée. Un accusé d'arrêt, un objet manquant, un PID réutilisé ou une
 * inspection impossible ne sont jamais une preuve de sortie. Aucun signal n'est
 * envoyé si l'identité n'est pas la nôtre.
 */

import { readFileSync, existsSync } from "node:fs";
import {
  classifyWorker,
  pidAlive,
  type WorkerClassification,
  type WorkerCreationIntent,
  type WorkerIdentity,
  type WorkerRecord,
} from "../durable/workers.js";

export type InspectObservation =
  | { kind: "running"; identity: WorkerIdentity }
  | { kind: "missing" }
  | { kind: "pid_reuse" }
  | { kind: "identity_mismatch"; observed?: Partial<WorkerIdentity> }
  | { kind: "unavailable"; error: string };

export type StopAcknowledgement =
  | { kind: "acknowledged" }
  | { kind: "refused"; reason: string };

export type WaitObservation =
  | { kind: "exited"; writingStopped: true }
  | { kind: "not_exited" }
  | { kind: "refused"; reason: string };

export type DiscoverObservation =
  | { kind: "none" }
  | { kind: "one"; identity: WorkerIdentity }
  | { kind: "ambiguous"; count: number };

export type CreationReconcile =
  | { kind: "created"; record: WorkerRecord }
  | { kind: "attention"; record: WorkerRecord; reason: string };

export interface WorkerBackend {
  readonly id: string;
  inspect(identity: WorkerIdentity): Promise<InspectObservation>;
  stop(identity: WorkerIdentity): Promise<StopAcknowledgement>;
  waitForExit(identity: WorkerIdentity): Promise<WaitObservation>;
  discover(correlation: string): Promise<DiscoverObservation>;
}

function identityFieldsMatch(expected: WorkerIdentity, observed: WorkerIdentity): boolean {
  return (
    expected.workerId === observed.workerId &&
    expected.executionId === observed.executionId &&
    expected.missionId === observed.missionId &&
    expected.workspaceDir === observed.workspaceDir &&
    expected.backendId === observed.backendId &&
    expected.immutableHandle === observed.immutableHandle
  );
}

export function intentMatchesIdentity(intent: WorkerCreationIntent, identity: WorkerIdentity): boolean {
  return (
    intent.workerId === identity.workerId &&
    intent.executionId === identity.executionId &&
    intent.missionId === identity.missionId &&
    intent.workspaceDir === identity.workspaceDir &&
    intent.backendId === identity.backendId &&
    intent.specBinding === identity.workspaceDir
  );
}

function inspectIsUnsafe(observation: InspectObservation): boolean {
  switch (observation.kind) {
    case "running":
      return false;
    case "missing":
      return false;
    case "pid_reuse":
    case "identity_mismatch":
    case "unavailable":
      return true;
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}

export class WorkerSupervisor {
  constructor(private readonly backend: WorkerBackend) {}

  async inspect(record: WorkerRecord): Promise<InspectObservation> {
    if (!record.identity) return { kind: "unavailable", error: "identité absente" };
    if (record.identity.backendId !== this.backend.id) {
      return { kind: "identity_mismatch", observed: { backendId: this.backend.id } };
    }
    const observation = await this.backend.inspect(record.identity);
    if (observation.kind === "running" && !identityFieldsMatch(record.identity, observation.identity)) {
      return { kind: "identity_mismatch", observed: observation.identity };
    }
    return observation;
  }

  async classify(record: WorkerRecord): Promise<WorkerClassification> {
    if (record.exitProof?.writingStopped) return { kind: "resolved", record };
    if (record.intent && !record.identity) {
      return { kind: "attention", record, reason: "intent_unbound" };
    }
    const observation = await this.inspect(record);
    return classifyWorker(record, observation);
  }

  async stop(record: WorkerRecord): Promise<StopAcknowledgement> {
    const observation = await this.inspect(record);
    if (observation.kind !== "running" || inspectIsUnsafe(observation)) {
      return { kind: "refused", reason: observation.kind };
    }
    return this.backend.stop(observation.identity);
  }

  async waitForExit(record: WorkerRecord): Promise<WaitObservation> {
    const observation = await this.inspect(record);
    if (inspectIsUnsafe(observation) || !record.identity) {
      return { kind: "refused", reason: observation.kind };
    }
    if (observation.kind !== "running") return { kind: "not_exited" };
    return this.backend.waitForExit(record.identity);
  }

  /**
   * Stop then wait. Missing after a verified running inspect of this identity
   * is cessation of that incarnation — not a missing object found cold.
   */
  async stopThenWait(record: WorkerRecord): Promise<WaitObservation> {
    const before = await this.inspect(record);
    if (before.kind !== "running" || !record.identity) {
      return { kind: "refused", reason: before.kind };
    }
    const stopped = await this.stop(record);
    if (stopped.kind !== "acknowledged") return { kind: "refused", reason: stopped.reason };
    const after = await this.inspect(record);
    if (inspectIsUnsafe(after)) return { kind: "refused", reason: after.kind };
    if (after.kind === "missing") return { kind: "exited", writingStopped: true };
    return this.backend.waitForExit(record.identity);
  }

  async assertSafeToReplace(records: readonly WorkerRecord[]): Promise<void> {
    for (const record of records) {
      const classified = await this.classify(record);
      if (classified.kind !== "resolved") {
        throw new Error(`remplacement refusé avant preuve de sortie: worker ${record.id} (${classified.kind})`);
      }
    }
  }

  async reconcileCreation(record: WorkerRecord): Promise<CreationReconcile> {
    if (record.identity) return { kind: "created", record };
    if (!record.intent) {
      return { kind: "attention", record, reason: "intent_unbound" };
    }
    const found = await this.backend.discover(record.intent.correlation);
    switch (found.kind) {
      case "one":
        if (!intentMatchesIdentity(record.intent, found.identity)) {
          return { kind: "attention", record, reason: "identity_mismatch" };
        }
        return {
          kind: "created",
          record: {
            ...record,
            identity: found.identity,
            pid: found.identity.observationalPid,
            lifecycle: "created",
            revision: (record.revision ?? 0) + 1,
          },
        };
      case "none":
        return { kind: "attention", record, reason: "intent_unbound" };
      case "ambiguous":
        return { kind: "attention", record, reason: "ambiguous_create" };
      default: {
        const exhaustive: never = found;
        return exhaustive;
      }
    }
  }
}

export function readProcessStarttime(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const rest = stat.slice(close + 2).split(" ");
    return rest[19];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export class ProcessWorkerBackend implements WorkerBackend {
  readonly id = "process";

  async inspect(identity: WorkerIdentity): Promise<InspectObservation> {
    if (!existsSync("/proc/self/stat")) {
      return { kind: "unavailable", error: "/proc indisponible" };
    }
    let starttime: string | undefined;
    try {
      starttime = readProcessStarttime(identity.observationalPid);
    } catch (err) {
      return { kind: "unavailable", error: (err as Error).message };
    }
    if (starttime === undefined) return { kind: "missing" };
    if (starttime !== identity.starttime) return { kind: "pid_reuse" };
    if (!pidAlive(identity.observationalPid)) return { kind: "missing" };
    return { kind: "running", identity };
  }

  async stop(identity: WorkerIdentity): Promise<StopAcknowledgement> {
    const observation = await this.inspect(identity);
    if (observation.kind !== "running") return { kind: "refused", reason: observation.kind };
    try {
      process.kill(identity.observationalPid, "SIGTERM");
      return { kind: "acknowledged" };
    } catch (err) {
      return { kind: "refused", reason: (err as Error).message };
    }
  }

  async waitForExit(identity: WorkerIdentity): Promise<WaitObservation> {
    const first = await this.inspect(identity);
    if (first.kind !== "running") return { kind: "not_exited" };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = await this.inspect(identity);
      switch (current.kind) {
        case "missing":
          return { kind: "exited", writingStopped: true };
        case "running":
          await new Promise((resolve) => setTimeout(resolve, 50));
          break;
        case "pid_reuse":
        case "identity_mismatch":
        case "unavailable":
          return { kind: "refused", reason: current.kind };
        default: {
          const exhaustive: never = current;
          return exhaustive;
        }
      }
    }
    return { kind: "not_exited" };
  }

  async discover(_correlation: string): Promise<DiscoverObservation> {
    return { kind: "none" };
  }
}
