/**
 * Admission disque et quotas (Skeptic S2 / Constraint Guardian CG1, Plan 0002 §8).
 *
 * Seuil d'admission : on refuse les nouvelles admissions sous le plus grand de
 * 5 GiB ou 20 % d'espace libre, et on réserve de la capacité pour les
 * checkpoints du contrôleur et les receipts d'effets. L'épuration ne touche
 * jamais le travail actif ni les preuves non résolues : à capacité pleine, on
 * alerte et on demande une décision de rétention explicite.
 */

export interface DiskAdmissionPolicy {
  /** Réserve absolue (Plan 0002 : 5 GiB). */
  reserveBytes: number;
  /** Fraction du total (Plan 0002 : 20 %). Le seuil est le plus grand des deux. */
  reserveFraction: number;
  /** Quota par worker (clones jetables + scratch). */
  workerQuotaBytes: number;
}

export const GIB = 1024 ** 3;

export const DEFAULT_DISK_POLICY: DiskAdmissionPolicy = {
  reserveBytes: 5 * GIB,
  reserveFraction: 0.2,
  workerQuotaBytes: 20 * GIB,
};

export interface DiskUsage {
  freeBytes: number;
  totalBytes: number;
}

export type AdmissionDecision = { admit: true } | { admit: false; reason: string };

/** Admet un travail de `plannedBytes` s'il reste au-dessus du seuil de réserve. */
export function admissionDecision(policy: DiskAdmissionPolicy, disk: DiskUsage, plannedBytes: number): AdmissionDecision {
  if (plannedBytes > policy.workerQuotaBytes) {
    return { admit: false, reason: `quota worker dépassé (${plannedBytes} > ${policy.workerQuotaBytes} o)` };
  }
  const reserve = Math.max(policy.reserveBytes, Math.ceil(policy.reserveFraction * disk.totalBytes));
  if (disk.freeBytes - plannedBytes < reserve) {
    return { admit: false, reason: `seuil de réserve disque atteint (réserve ${reserve} o, libre ${disk.freeBytes} o)` };
  }
  return { admit: true };
}

export type RetentionKind = "log" | "clone" | "artifact" | "image" | "transcript" | "approval" | "receipt";

export interface RetentionEntry {
  kind: RetentionKind;
  /** Travail actif : jamais épuré. */
  active: boolean;
  /** Preuve non résolue (effet externe sans receipt) : jamais épurée. */
  unresolvedEffects: boolean;
  /** Le résultat a été exporté/sauvegardé (condition pour un clone terminal). */
  exported: boolean;
  /** Image à conserver (courante, rollback, référencée par une tâche active). */
  pinned: boolean;
  ageMs: number;
  retentionMs: number;
}

export interface PrunePlan {
  prunable: RetentionEntry[];
  /** Jamais épurés : travail actif, preuves non résolues, éléments épinglés. */
  protectedEntries: RetentionEntry[];
}

/**
 * Calcule ce qui PEUT être épuré. Invariants CG1 :
 * - jamais le travail actif, jamais les preuves non résolues ;
 * - jamais les transcripts, approbations ni receipts (autoritatifs, V1) ;
 * - jamais les images épinglées ;
 * - un clone/artifact terminal seulement après export ET expiration de rétention.
 * Si le résultat ne libère pas assez d'espace, la décision est humaine.
 */
export function prunePlan(entries: RetentionEntry[]): PrunePlan {
  const prunable: RetentionEntry[] = [];
  const protectedEntries: RetentionEntry[] = [];
  for (const entry of entries) {
    const isAuthoritative = entry.kind === "transcript" || entry.kind === "approval" || entry.kind === "receipt";
    const kept =
      entry.active || entry.unresolvedEffects || entry.pinned || isAuthoritative ||
      !entry.exported || entry.ageMs < entry.retentionMs;
    (kept ? protectedEntries : prunable).push(entry);
  }
  return { prunable, protectedEntries };
}
