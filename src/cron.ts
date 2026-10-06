import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Db } from "./db.js";
import { getAgent } from "./agents.js";
import { createConversation, type ConversationRow } from "./conversations.js";
import type { PiPool } from "./pool.js";
import type { ScheduleCreate, ScheduleUpdate } from "./schemas.js";
import type { SpawnConfig } from "./spawn.js";
import type { Spawner } from "./spawner.js";

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

export interface CronServiceOptions {
  db: Db;
  pool: PiPool;
  spawner: Spawner;
  notify?: CronNotify;
  /** Timeout d'un run en ms (défaut 15 min) */
  runTimeoutMs?: number;
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
    if (isNaN(base.getTime())) return null;
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
    .prepare("SELECT * FROM cron_run WHERE task_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(taskId, limit) as unknown as CronRunRow[];
}

function runningRunFor(db: Db, taskId: string): CronRunRow | null {
  return (db.prepare("SELECT * FROM cron_run WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1").get(taskId) as CronRunRow | undefined) ?? null;
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

// ---------- Service ----------

export class CronService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing = new Set<string>(); // garde anti-recouvrement dans un tick

  constructor(private opts: CronServiceOptions) {}

  /** Boucle de tick ; appelée par le timer et testable directement. */
  async tick(now = new Date()): Promise<void> {
    const { db } = this.opts;
    const tasks = db.prepare("SELECT * FROM cron_task WHERE enabled = 1").all() as unknown as CronTaskRow[];
    for (const task of tasks) {
      if (this.firing.has(task.id)) continue;
      const next = nextAfter(task, now);
      if (!next || next > now) continue;
      if (!task.catchup) {
        // rattrapage désactivé : on avance au prochain créneau sans exécuter
        db.prepare("UPDATE cron_task SET last_run_at = ? WHERE id = ?").run(now.toISOString(), task.id);
        continue;
      }
      void this.fireNow(task.id).catch(() => undefined);
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => undefined), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Tire une exécution (manuelle ou planifiée). Crée toujours un CronRun (O3). */
  async fireNow(taskId: string): Promise<CronRunRow | null> {
    const { db, spawner, pool } = this.opts;
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
    db.prepare("UPDATE cron_task SET last_run_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    this.opts.notify?.({ type: "cron_run_started", taskId, runId, name: task.name });

    let convId: string | null = null;
    try {
      // busy-guard : un run 'running' en base (ex. crash, autre instance)
      const stale = runningRunFor(db, taskId);
      if (stale && stale.id !== runId) {
        if (task.busy_policy === "skip") {
          finishRun(db, runId, "skipped", null, `run ${stale.id} encore actif (policy skip)`);
          return this.getRun(runId);
        }
        if (task.busy_policy === "kill") {
          finishRun(db, stale.id, "killed", null, "supplanté par un nouveau run");
        }
        // queue : attendre la fin du run actif (garde fous : 10 min)
        const deadline = Date.now() + 10 * 60_000;
        while (runningRunFor(db, taskId) && Date.now() < deadline) await sleep(2_000);
      }

      const preset = task.agent_id ? getAgent(db, task.agent_id) : null;
      if (!preset) {
        finishRun(db, runId, "error", null, "agent introuvable (supprimé ?)");
        return this.getRun(runId);
      }

      const spawn: SpawnConfig = {
        provider: preset.provider, model: preset.model, thinking: preset.thinking,
        systemPrompt: preset.system_prompt || undefined,
        skills: preset.skills, tools: preset.tools_allowlist, mcpServers: preset.mcp_servers,
      };

      // session dédiée : append_session reprend la dernière session de la tâche si connue
      let resumeFile: string | null = null;
      if (task.output_policy === "append_session") {
        const last = db
          .prepare("SELECT session_file FROM cron_run WHERE task_id = ? AND session_file IS NOT NULL ORDER BY started_at DESC LIMIT 1")
          .get(taskId) as { session_file: string } | undefined;
        resumeFile = last?.session_file ?? null;
      }

      const conv: ConversationRow = createConversation(db, {
        workspaceId: task.workspace_id, agentId: preset.id, spawn,
      });
      convId = conv.id;
      if (resumeFile) {
        db.prepare("UPDATE conversation SET session_file = ? WHERE id = ?").run(resumeFile, conv.id);
        conv.session_file = resumeFile;
      }
      db.prepare("UPDATE conversation SET title = ? WHERE id = ?").run(`[cron] ${task.name}`, conv.id);

      await spawner.ensure(conv);
      // s'abonner AVANT de prompt : un LLM rapide peut settled avant l'abonnement sinon
      const settled = pool.waitForSettled(conv.id, this.opts.runTimeoutMs ?? 15 * 60_000);
      await pool.prompt(conv.id, task.prompt);
      await settled;
      const finalConv = db.prepare("SELECT session_file FROM conversation WHERE id = ?").get(conv.id) as { session_file: string | null };
      finishRun(db, runId, "ok", finalConv.session_file);
      this.opts.notify?.({ type: "cron_run_finished", taskId, runId, name: task.name, status: "ok", sessionFile: finalConv.session_file });
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

  private getRun(runId: string): CronRunRow {
    return this.opts.db.prepare("SELECT * FROM cron_run WHERE id = ?").get(runId) as unknown as CronRunRow;
  }
}
