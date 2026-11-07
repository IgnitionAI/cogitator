import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Db } from "./db.js";
import { getAgent, type AgentPreset } from "./agents.js";
import { createConversation, getConversation, type ConversationRow } from "./conversations.js";
import type { PiPool } from "./pool.js";
import type { ScheduleCreate, ScheduleUpdate } from "./schemas.js";
import { spawnConfigFromPreset } from "./spawn.js";
import type { Spawner } from "./spawner.js";
import {
  enqueue,
  originHop,
  type LaneDispatcher,
  type QueueItemRow,
  type QueueStatus,
} from "./team-queue.js";

export interface CronTaskRow {
  id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  agent_id: string | null;
  workspace_id: string;
  output_policy: string;
  busy_policy: string;
  catchup: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

export interface CronRunRow {
  id: string;
  task_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  session_file: string | null;
  error: string | null;
}

export type CronNotify = (event: Record<string, unknown>) => void;

/** Bornes du service (surchargeables par les options pour les tests). */
const DEFAULT_TICK_MS = 30_000;
/** busy_policy=queue : on attend la fin du run actif, avec garde-fou. */
const QUEUE_POLL_MS = 2_000;
const QUEUE_WAIT_MAX_MS = 10 * 60_000;

export interface CronServiceOptions {
  db: Db;
  pool: PiPool;
  spawner: Spawner;
  notify?: CronNotify;
  /** File durable partagée avec les messages UI (injectée par createApp). */
  team?: LaneDispatcher;
  /** Conservé pour compat ; le stall sans progrès est celui du LaneDispatcher (PR #35). */
  runTimeoutMs?: number;
}

const QUEUE_ITEM_POLL_MS = 20;
const TERMINAL_QUEUE: ReadonlySet<QueueStatus> = new Set(["done", "failed", "interrupted", "cancelled"]);

export function waitForQueueItem(db: Db, itemId: string, pollMs = QUEUE_ITEM_POLL_MS): Promise<QueueItemRow> {
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const row = db.prepare("SELECT * FROM queue_item WHERE id = ?").get(itemId) as QueueItemRow | undefined;
      if (!row) {
        reject(new Error("queue_item disparu"));
        return;
      }
      if (TERMINAL_QUEUE.has(row.status)) {
        resolve(row);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/** Met le prompt cron en file sur la lane de la conversation cible, puis attend le statut de l'item. */
export function queueCronRun(
  db: Db,
  team: LaneDispatcher,
  input: { conversationId: string; prompt: string; fromAgentId?: string | null; idempotencyKey?: string | null },
): Promise<QueueItemRow> {
  const inherited = originHop(db, input.conversationId);
  const { id, laneId } = enqueue(db, {
    conversationId: input.conversationId,
    body: input.prompt,
    fromAgentId: input.fromAgentId ?? null,
    hop: inherited.hop,
    chainId: inherited.chainId,
    idempotencyKey: input.idempotencyKey,
  });
  void team.kick(laneId).catch(() => undefined);
  return waitForQueueItem(db, id);
}

function cronStatusFromItem(item: QueueItemRow): { status: string; error?: string } {
  switch (item.status) {
    case "done":
      return { status: "ok" };
    case "failed": {
      const error = item.error ?? "livraison échouée";
      return { status: /timeout|stall|sans progrès|progress/i.test(error) ? "timeout" : "error", error };
    }
    case "interrupted":
      return { status: "error", error: item.error ?? "interrupted" };
    case "cancelled":
      return { status: "error", error: "cancelled" };
    case "queued":
    case "delivering":
      return { status: "error", error: `item encore ${item.status}` };
    default: {
      const _never: never = item.status;
      return _never;
    }
  }
}

// ---------- DB ops ----------

export function listTasks(db: Db): Array<CronTaskRow & { next_run_at: string | null }> {
  const rows = db.prepare("SELECT * FROM cron_task ORDER BY name").all() as unknown as CronTaskRow[];
  return rows.map((t) => ({ ...t, next_run_at: nextAfter(t)?.toISOString() ?? null }));
}

export function getTask(db: Db, id: string): CronTaskRow | null {
  return (db.prepare("SELECT * FROM cron_task WHERE id = ?").get(id) as CronTaskRow | undefined) ?? null;
}

export function validateCronExpr(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

export function nextAfter(task: CronTaskRow, from = new Date()): Date | null {
  try {
    const base = task.last_run_at ? new Date(task.last_run_at) : new Date(task.created_at);
    if (Number.isNaN(base.getTime())) return null;
    // itérateur positionné sur la dernière exécution ; next() donne l'occurrence suivante
    const it = CronExpressionParser.parse(task.cron_expr, { currentDate: base > from ? from : base });
    return it.next().toDate();
  } catch {
    return null;
  }
}

export type CronTaskInput = ScheduleCreate;

export function createTask(db: Db, input: ScheduleCreate): { task?: CronTaskRow; error?: string } {
  if (!input.name?.trim()) return { error: "name requis" };
  if (!validateCronExpr(input.cron_expr)) return { error: `expression cron invalide: ${input.cron_expr}` };
  if (!input.prompt?.trim()) return { error: "prompt requis" };
  if (!db.prepare("SELECT 1 FROM agent_preset WHERE id = ?").get(input.agent_id)) return { error: "agent introuvable" };
  if (!db.prepare("SELECT 1 FROM workspace WHERE id = ?").get(input.workspace_id)) return { error: "workspace introuvable" };
  const id = randomUUID();
  db.prepare(
    `INSERT INTO cron_task (id, name, cron_expr, prompt, agent_id, workspace_id, output_policy, busy_policy, catchup)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.name.trim(), input.cron_expr, input.prompt, input.agent_id, input.workspace_id,
    input.output_policy ?? "append_session",
    input.busy_policy ?? "skip",
    input.catchup ? 1 : 0,
  );
  return { task: getTask(db, id)! };
}

export function updateTask(db: Db, id: string, input: ScheduleUpdate): CronTaskRow | null {
  const t = getTask(db, id);
  if (!t) return null;
  if (input.cron_expr !== undefined && !validateCronExpr(input.cron_expr)) return null;
  db.prepare(
    `UPDATE cron_task SET name = ?, cron_expr = ?, prompt = ?, output_policy = ?, busy_policy = ?,
       catchup = ?, enabled = ?, last_run_at = ? WHERE id = ?`,
  ).run(
    input.name ?? t.name,
    input.cron_expr ?? t.cron_expr,
    input.prompt ?? t.prompt,
    input.output_policy ?? t.output_policy,
    input.busy_policy ?? t.busy_policy,
    input.catchup === undefined ? t.catchup : input.catchup ? 1 : 0,
    input.enabled === undefined ? t.enabled : input.enabled ? 1 : 0,
    input.cron_expr !== undefined || input.enabled !== undefined ? null : t.last_run_at, // reclock si expr change
    id,
  );
  return getTask(db, id);
}

export function deleteTask(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM cron_task WHERE id = ?").run(id).changes > 0; // runs en CASCADE (suppression = purge de l'historique de la tâche)
}

export function listRuns(db: Db, taskId: string, limit = 50): CronRunRow[] {
  return db
    .prepare("SELECT * FROM cron_run WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?")
    .all(taskId, limit) as unknown as CronRunRow[];
}

function runningRunFor(db: Db, taskId: string, currentRunId: string): CronRunRow | null {
  return (db.prepare("SELECT * FROM cron_run WHERE task_id = ? AND status = 'running' AND id != ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId, currentRunId) as CronRunRow | undefined) ?? null;
}

function createRun(db: Db, taskId: string): string {
  const id = randomUUID();
  db.prepare("INSERT INTO cron_run (id, task_id) VALUES (?, ?)").run(id, taskId);
  return id;
}

function finishRun(db: Db, runId: string, status: string, sessionFile?: string | null, error?: string): void {
  db.prepare(
    `UPDATE cron_run SET finished_at = datetime('now'), status = ?, session_file = COALESCE(?, session_file), error = ?
     WHERE id = ? AND status = 'running'`, // idempotent : un run déjà clos n'est pas rouvert
  ).run(status, sessionFile ?? null, error ?? null, runId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** busy_policy : un run 'running' déjà en base (crash, autre instance) bloque le nouveau.
 *  Renvoie false quand le run courant a été tracé comme `skipped` (il ne doit pas s'exécuter). */
async function applyBusyPolicy(db: Db, task: CronTaskRow, runId: string): Promise<boolean> {
  const stale = runningRunFor(db, task.id, runId);
  if (!stale) return true;
  if (task.busy_policy === "skip") {
    finishRun(db, runId, "skipped", null, `run ${stale.id} encore actif (policy skip)`);
    return false;
  }
  if (task.busy_policy === "kill") {
    finishRun(db, stale.id, "killed", null, "supplanté par un nouveau run");
  }
  // queue : attendre la fin du run actif (garde-fou : QUEUE_WAIT_MAX_MS)
  const deadline = Date.now() + QUEUE_WAIT_MAX_MS;
  while (runningRunFor(db, task.id, runId) && Date.now() < deadline) await sleep(QUEUE_POLL_MS);
  return true;
}

/** Dernière session connue de la tâche (output_policy=append_session la reprend). */
function lastSessionFile(db: Db, taskId: string): string | null {
  const last = db
    .prepare(`SELECT session_file FROM cron_run
              WHERE task_id = ? AND session_file IS NOT NULL
              ORDER BY started_at DESC, rowid DESC LIMIT 1`)
    .get(taskId) as { session_file: string } | undefined;
  return last?.session_file ?? null;
}

// ---------- Service ----------

export class CronService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing = new Set<string>(); // garde anti-recouvrement dans un tick
  private team: LaneDispatcher | undefined;
  private lastTickAt: Date | null = null;

  constructor(private opts: CronServiceOptions) {
    this.team = opts.team;
  }

  /** Branche le dispatcher créé par createApp (même instance que les messages UI). */
  attachTeam(team: LaneDispatcher): void {
    this.team = team;
  }

  private requireTeam(): LaneDispatcher {
    if (!this.team) throw new Error("file durable absente (LaneDispatcher)");
    return this.team;
  }

  /** Boucle de tick ; appelée par le timer et testable directement. */
  async tick(now = new Date()): Promise<void> {
    const { db } = this.opts;
    const previousTick = this.lastTickAt ?? now;
    this.lastTickAt = now;
    const tasks = db.prepare("SELECT * FROM cron_task WHERE enabled = 1").all() as unknown as CronTaskRow[];
    for (const task of tasks) {
      if (this.firing.has(task.id)) continue;
      const next = nextAfter(task, now);
      if (!next || next > now) continue;
      if (!task.catchup) {
        // Seul le retard antérieur à cette instance est ignoré. Une occurrence
        // tombée entre deux ticks du service reste une exécution normale.
        const regular = nextAfter({ ...task, last_run_at: previousTick.toISOString() }, now);
        if (!regular || regular > now) {
          db.prepare("UPDATE cron_task SET last_run_at = ? WHERE id = ?").run(now.toISOString(), task.id);
          continue;
        }
      }
      void this.fireNow(task.id, now).catch(() => undefined);
    }
  }

  start(intervalMs = DEFAULT_TICK_MS): void {
    if (this.timer) return;
    this.lastTickAt = new Date();
    this.timer = setInterval(() => this.tick().catch(() => undefined), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastTickAt = null;
  }

  /** Tire une exécution (manuelle ou planifiée). Crée toujours un CronRun (O3). */
  async fireNow(taskId: string, now = new Date()): Promise<CronRunRow | null> {
    const { db, pool } = this.opts;
    const task = getTask(db, taskId);
    if (!task) return null;
    if (this.firing.has(taskId)) {
      // déjà en cours dans ce process : skip tracé
      const runId = createRun(db, taskId);
      finishRun(db, runId, "skipped", null, "tâche déjà en cours dans ce process");
      return this.getRun(runId);
    }
    this.firing.add(taskId);
    const runId = createRun(db, taskId);
    db.prepare("UPDATE cron_task SET last_run_at = ? WHERE id = ?").run(now.toISOString(), taskId);
    this.opts.notify?.({ type: "cron_run_started", taskId, runId, name: task.name });

    let convId: string | null = null;
    try {
      if (!(await applyBusyPolicy(db, task, runId))) return this.getRun(runId);

      const preset = task.agent_id ? getAgent(db, task.agent_id) : null;
      if (!preset) {
        finishRun(db, runId, "error", null, "agent introuvable (supprimé ?)");
        return this.getRun(runId);
      }

      const conv = this.createRunConversation(task, preset);
      convId = conv.id;
      const item = await queueCronRun(db, this.requireTeam(), {
        conversationId: conv.id,
        prompt: task.prompt,
        fromAgentId: preset.id,
        idempotencyKey: `cron:${runId}`,
      });
      const mapped = cronStatusFromItem(item);
      const finalConv = db.prepare("SELECT session_file FROM conversation WHERE id = ?").get(conv.id) as { session_file: string | null };
      finishRun(db, runId, mapped.status, finalConv.session_file, mapped.error);
      this.opts.notify?.({ type: "cron_run_finished", taskId, runId, name: task.name, status: mapped.status, sessionFile: finalConv.session_file, error: mapped.error });
      return this.getRun(runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("timeout") ? "timeout" : "error";
      finishRun(db, runId, status, null, message);
      this.opts.notify?.({ type: "cron_run_finished", taskId, runId, name: task.name, status, error: message });
      return this.getRun(runId);
    } finally {
      // la conversation cron est éphémère : row supprimée (le .jsonl reste, I5),
      // ce qui libère aussi session_file UNIQUE pour la reprise append_session du prochain run
      if (convId) {
        await pool.evict(convId).catch(() => undefined);
        db.prepare("DELETE FROM conversation WHERE id = ?").run(convId);
      }
      this.firing.delete(taskId);
    }
  }

  /** Conversation éphémère du run, dans le workspace de la tâche (session reprise si append_session). */
  private createRunConversation(task: CronTaskRow, preset: AgentPreset): ConversationRow {
    const { db } = this.opts;
    const conv = createConversation(db, {
      workspaceId: task.workspace_id,
      agentId: preset.id,
      spawn: spawnConfigFromPreset(preset),
    });
    const resumeFile = task.output_policy === "append_session" ? lastSessionFile(db, task.id) : null;
    if (resumeFile) db.prepare("UPDATE conversation SET session_file = ? WHERE id = ?").run(resumeFile, conv.id);
    db.prepare("UPDATE conversation SET title = ? WHERE id = ?").run(`[cron] ${task.name}`, conv.id);
    return getConversation(db, conv.id)!;
  }

  private getRun(runId: string): CronRunRow {
    return this.opts.db.prepare("SELECT * FROM cron_run WHERE id = ?").get(runId) as unknown as CronRunRow;
  }
}
