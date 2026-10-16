import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { applyAgent, getAgent } from "./agents.js";
import { getConversation, type ConversationRow, type PendingConfiguration } from "./conversations.js";
import type { Db } from "./db.js";
import type { Paths } from "./paths.js";
import { PiPool, type PiClientLike } from "./pool.js";
import { checkRequestAuthorization } from "./request-authorization.js";
import { THINKING_LEVELS, type ModelSwitch } from "./schemas.js";

export class ConfigurationError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
interface Dependencies {
  db: Db;
  pool: PiPool;
  paths: Paths;
  ensure(conv: ConversationRow): Promise<unknown>;
  onPresetChanged?: () => void;
}
interface Tuple { provider: string; model: string; thinking: string | null }

function conversation(db: Db, id: string): ConversationRow {
  const conv = getConversation(db, id);
  if (!conv) throw new ConfigurationError("conversation not found", 404);
  if (conv.runtime_kind === "durable") throw new ConfigurationError("Durable configuration is immutable", 409);
  return conv;
}

async function readTuple(client: PiClientLike): Promise<Tuple> {
  const state = await client.getState();
  if (!state.model || !state.thinkingLevel) throw new ConfigurationError("RPC configuration readback unavailable");
  return { provider: state.model.provider, model: state.model.id, thinking: state.thinkingLevel };
}

async function select(client: PiClientLike, target: Tuple): Promise<Tuple> {
  const before = await readTuple(client);
  const thinking = target.thinking ?? before.thinking;
  if (!(await client.getAvailableModels()).some(m => m.provider === target.provider && m.id === target.model)) {
    throw new ConfigurationError("unsupported model", 422);
  }
  if (before.provider !== target.provider || before.model !== target.model) await client.setModel(target.provider, target.model);
  const levels = await client.getAvailableThinkingLevels();
  if (!thinking || !THINKING_LEVELS.includes(thinking as ThinkingLevel) || !levels.includes(thinking as ThinkingLevel)) {
    throw new ConfigurationError("unsupported thinking level for target model", 422);
  }
  await client.setThinkingLevel(thinking as ThinkingLevel);
  const actual = await readTuple(client);
  if (actual.provider !== target.provider || actual.model !== target.model || actual.thinking !== thinking) {
    throw new ConfigurationError("RPC configuration readback mismatch");
  }
  return actual;
}

function writeTuple(db: Db, conv: ConversationRow, tuple: Tuple): void {
  const spawn = { ...JSON.parse(conv.spawn_args), ...tuple };
  db.prepare("UPDATE conversation SET provider = ?, model = ?, thinking = ?, spawn_args = ?, updated_at = datetime('now') WHERE id = ?")
    .run(tuple.provider, tuple.model, tuple.thinking, JSON.stringify(spawn), conv.id);
}

function publish(db: Db, pool: PiPool, id: string): void {
  pool.emit(id, { type: "configuration_changed", conversation: getConversation(db, id) });
}

function pending(db: Db, pool: PiPool, id: string, value: PendingConfiguration | null): void {
  db.prepare("UPDATE conversation SET pending_configuration = ? WHERE id = ?").run(value ? JSON.stringify(value) : null, id);
  publish(db, pool, id);
}

/** Called inside pool startup lock, before the handle becomes usable. */
export async function reconcileConfiguration(db: Db, pool: PiPool, id: string, client: PiClientLike): Promise<void> {
  const conv = conversation(db, id);
  const actual = await select(client, conv);
  checkRequestAuthorization();
  writeTuple(db, conv, actual);
  publish(db, pool, id);
}

/** Restart cannot recreate the original authorization check: retain visible, retryable failure. */
export function recoverConfigurations(db: Db): void {
  const rows = db.prepare("SELECT id FROM conversation WHERE pending_configuration IS NOT NULL AND runtime_kind = 'classic'").all() as Array<{ id: string }>;
  for (const { id } of rows) {
    const p = getConversation(db, id)?.pending_configuration;
    if (p?.status === "pending") db.prepare("UPDATE conversation SET pending_configuration = ? WHERE id = ?")
      .run(JSON.stringify({ ...p, status: "failed", error: "Controller restarted; renew authorization by retrying this change" }), id);
  }
}

export async function changeConfiguration(deps: Dependencies, id: string, input: ModelSwitch): Promise<{ status: number; conversation: ConversationRow }> {
  const { db, pool, paths } = deps;
  // Reserve synchronously, so competing HTTP calls cannot wait out an applying request.
  const conv = conversation(db, id);
  const scope = input.scope ?? "conversation";
  if (scope !== "conversation" && scope !== "preset") throw new ConfigurationError("invalid scope", 409);
  if (conv.pending_configuration?.status === "pending") throw new ConfigurationError("configuration outstanding", 409);
  if (scope === "preset" && !conv.agent_id) throw new ConfigurationError("preset scope requires a linked preset", 409);
  if (scope === "preset" && !getAgent(db, conv.agent_id!)) throw new ConfigurationError("preset not found", 404);
  checkRequestAuthorization();
  const request: PendingConfiguration = { request_id: randomUUID(), provider: input.provider, model: input.id, thinking: input.thinking ?? conv.thinking, scope, status: "pending" };
  pending(db, pool, id, request);
  let applied = false;
  try {
    await pool.serial(id, async () => {
      await deps.ensure(conversation(db, id));
      applied = await pool.configure(id, async () => {
        const client = pool.client(id);
        let old: Tuple | undefined;
        let previousPreset: ReturnType<typeof getAgent> = null;
        try {
          checkRequestAuthorization();
          old = await readTuple(client);
          const actual = await select(client, request);
          checkRequestAuthorization();
          db.transaction(() => {
            const current = conversation(db, id);
            writeTuple(db, current, actual);
            if (scope === "preset") {
              previousPreset = getAgent(db, conv.agent_id!);
              if (!previousPreset) throw new ConfigurationError("preset not found", 404);
              db.prepare("UPDATE agent_preset SET provider = ?, model = ?, thinking = ?, updated_at = datetime('now') WHERE id = ?")
                .run(actual.provider, actual.model, actual.thinking, conv.agent_id);
              applyAgent(paths, getAgent(db, conv.agent_id!)!);
            }
            db.prepare("UPDATE conversation SET pending_configuration = NULL WHERE id = ?").run(id);
          })();
        } catch (error) {
          try {
            if (!old) throw error;
            await select(client, old);
            if (previousPreset) applyAgent(paths, previousPreset);
          } catch { await pool.evict(id); }
          pending(db, pool, id, { ...request, status: "failed", error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        publish(db, pool, id);
        if (scope === "preset") deps.onPresetChanged?.();
      }, () => pending(db, pool, id, { ...request, status: "failed", error: "Session stopped before configuration applied; retry required" }));
    });
  } catch (error) {
    if (getConversation(db, id)?.pending_configuration?.status === "pending") pending(db, pool, id, { ...request, status: "failed", error: String(error) });
    throw error;
  }
  return { status: applied ? 200 : 202, conversation: conversation(db, id) };
}

export function dismissConfiguration(db: Db, pool: PiPool, id: string): ConversationRow {
  const conv = conversation(db, id);
  if (conv.pending_configuration?.status !== "failed") throw new ConfigurationError("only failed configuration can be dismissed", 409);
  checkRequestAuthorization();
  pending(db, pool, id, null);
  return conversation(db, id);
}
