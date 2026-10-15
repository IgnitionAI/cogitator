/**
 * Admission des missions (Plan 0002 §5/§7, ADR-008 D7, UA3) :
 * - au plus DEUX missions s'exécutent en concurrence ; une troisième file
 *   visiblement (état `queued`, jamais de travail caché) ;
 * - une mission détient un claim EXCLUSIF sur son workspace : deux jobs ne
 *   courent jamais sur le même checkout ; le claim n'est relâché qu'après
 *   l'arrêt des écritures (waitForIdle confirmé côté runtime) ;
 * - les budgets : seul le gate QUOTIDIEN se réinitialise, à minuit UTC ;
 *   les limites par mission ne se réinitialisent JAMAIS implicitement ; l'UI
 *   nomme la limite liante et la prochaine action (UA3) ;
 * - l'attente (queued, budget_paused) ne consomme pas de slot d'exécution.
 */

// ---------- Deux slots d'exécution ----------

export interface SlotAdmission {
  admitted: boolean;
  /** Présent quand admitted = false : motif visible pour l'UI et les tests. */
  reason?: string;
}

export class MissionSlotPool {
  private readonly holders = new Set<string>();
  private readonly queue: string[] = [];

  constructor(readonly capacity = 2) {}

  get running(): readonly string[] {
    return [...this.holders];
  }

  get queued(): readonly string[] {
    return [...this.queue];
  }

  /** Tente d'admettre une mission ; sinon la met en file (visible), FIFO. */
  tryAcquire(missionId: string): SlotAdmission {
    if (this.holders.has(missionId)) return { admitted: true };
    if (this.holders.size < this.capacity) {
      this.holders.add(missionId);
      return { admitted: true };
    }
    if (!this.queue.includes(missionId)) this.queue.push(missionId);
    return { admitted: false, reason: "slots_missions_pleins" };
  }

  /** Relâche le slot et promeut la mission en tête de file s'il y a place. */
  release(missionId: string): string | null {
    this.holders.delete(missionId);
    const i = this.queue.indexOf(missionId);
    if (i >= 0) this.queue.splice(i, 1);
    const next = this.queue[0];
    if (next !== undefined && this.holders.size < this.capacity) {
      this.queue.shift();
      this.holders.add(next);
      return next;
    }
    return null;
  }
}

// ---------- Claims workspace exclusifs ----------

export type ClaimAdmission =
  | { claimed: true }
  | { claimed: false; heldBy: string };

export class WorkspaceClaims {
  private readonly byDir = new Map<string, string>();

  /** Claim exclusif : un second job sur le même dossier attend (ne race pas). */
  acquire(dir: string, missionId: string): ClaimAdmission {
    const holder = this.byDir.get(dir);
    if (holder && holder !== missionId) return { claimed: false, heldBy: holder };
    this.byDir.set(dir, missionId);
    return { claimed: true };
  }

  /** Relâche uniquement si la mission en est le détenteur (jamais le claim d'autrui). */
  release(dir: string, missionId: string): void {
    if (this.byDir.get(dir) === missionId) this.byDir.delete(dir);
  }

  holder(dir: string): string | undefined {
    return this.byDir.get(dir);
  }

  /** Vue pour l'observabilité et les tests. */
  entries(): Record<string, string> {
    return Object.fromEntries(this.byDir);
  }

  /** Relâche tous les claims détenus par une mission (fermeture de runtime). */
  releaseByMission(missionId: string): void {
    for (const [dir, holder] of this.byDir) {
      if (holder === missionId) this.byDir.delete(dir);
    }
  }
}

// ---------- Budgets (UA3) ----------

export type BudgetPolicy = {
  /** Limite cumulée de requêtes modèle pour la mission (jamais reset implicitement). */
  missionCalls?: number;
  /** Limite cumulée de tokens pour la mission (jamais reset implicitement). */
  missionTokens?: number;
  /** Gate quotidien de requêtes : reset automatique à minuit UTC uniquement. */
  dailyCalls?: number;
  /** Gate quotidien de tokens : reset automatique à minuit UTC uniquement. */
  dailyTokens?: number;
}

export interface UsageTotals {
  /** Requêtes modèle observées (depuis le début de la mission). */
  calls: number;
  /** Tokens totaux observés (depuis le début de la mission). */
  tokens: number;
}

/** Jour civil UTC `YYYY-MM-DD` — la SEULE frontière de reset automatique. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface BudgetBinding {
  /** Limite liante actuellement. */
  kind: "missionCalls" | "missionTokens" | "dailyCalls" | "dailyTokens";
  limit: number;
  used: number;
  /** Prochaine action affichable (UA3). */
  nextAction: string;
}

export type BudgetState = { status: "within" } | { status: "budget_paused"; binding: BudgetBinding };

function bindingFor(kind: BudgetBinding["kind"], limit: number, used: number, daily: boolean): BudgetBinding {
  const nextAction = daily
    ? "attendre le reset du gate quotidien à minuit UTC, ou relever la limite explicitement"
    : "relever la limite de mission explicitement, ou annuler la mission (aucun reset implicite)";
  return { kind, limit, used, nextAction };
}

/**
 * Évalue l'état budget. `dailyUsed` = consommation du jour civil UTC courant ;
 * `missionUsed` = cumul depuis le début de la mission. Un gate quotidien liant
 * se délie seul au passage à minuit UTC (frontière calculée par `utcDay`) ;
 * une limite de mission ne se délie JAMAIS sans action owner explicite.
 */
export function evaluateBudget(policy: BudgetPolicy, missionUsed: UsageTotals, dailyUsed: UsageTotals, _now: number): BudgetState {
  // Le reset UTC n'a rien à écrire : à minuit, le jour courant change et la
  // consommation « du jour » (calculée par dailyUsage) repart de zéro.
  const checks: Array<{ kind: BudgetBinding["kind"]; limit?: number; used: number; daily: boolean }> = [
    { kind: "missionCalls", limit: policy.missionCalls, used: missionUsed.calls, daily: false },
    { kind: "missionTokens", limit: policy.missionTokens, used: missionUsed.tokens, daily: false },
    { kind: "dailyCalls", limit: policy.dailyCalls, used: dailyUsed.calls, daily: true },
    { kind: "dailyTokens", limit: policy.dailyTokens, used: dailyUsed.tokens, daily: true },
  ];
  for (const check of checks) {
    if (check.limit !== undefined && check.used >= check.limit) {
      return { status: "budget_paused", binding: bindingFor(check.kind, check.limit, check.used, check.daily) };
    }
  }
  return { status: "within" };
}

/**
 * Résolution paresseuse de la consommation journalière : la mission persiste
 * son cumul (`missionUsed`) et le point de base du jour (`dayBaseline` =
 * cumul constaté au début du jour civil UTC courant). Consommation du jour =
 * cumul − base ; au passage à minuit UTC, l'appelant roule la base : reset
 * automatique, sans jamais toucher au cumul de mission.
 */
export function rollDailyBaseline(baseline: { day: string; calls: number; tokens: number }, totals: UsageTotals, now: number): { day: string; calls: number; tokens: number } {
  const day = utcDay(now);
  if (baseline.day === day) return baseline;
  return { day, calls: totals.calls, tokens: totals.tokens };
}

export function dailyUsage(baseline: { day: string; calls: number; tokens: number }, totals: UsageTotals, now: number): UsageTotals {
  const rolled = rollDailyBaseline(baseline, totals, now);
  return { calls: Math.max(0, totals.calls - rolled.calls), tokens: Math.max(0, totals.tokens - rolled.tokens) };
}
