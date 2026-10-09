import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setConversationSession, type ConversationRow } from "./conversations.js";
import type { Db } from "./db.js";
import { UI_INSTRUCTIONS, UI_PRESENTATION_POLICY } from "./generative-ui.js";
import { MCP_ENV_VAR, encodeMcpEnv } from "./mcp-env.js";
import type { Paths } from "./paths.js";
import { PiPool } from "./pool.js";
import { buildArgs, type SpawnConfig } from "./spawn.js";

export interface SpawnerOptions {
  db: Db;
  pool: PiPool;
  paths: Paths;
}

export interface Spawner {
  /** Spawn paresseux : (re)démarre le process pi de la conversation si besoin (I3 : tout passe par le pool). */
  ensure(conv: ConversationRow): Promise<{ sessionFile?: string }>;
  tmpDir: string;
}

/** Fabrique unique du mécanisme de spawn, partagé par le serveur HTTP et le CronService. */
export function makeSpawner(opts: SpawnerOptions): Spawner {
  const { db, pool, paths } = opts;
  const tmpDir = join(paths.home, "tmp");
  mkdirSync(tmpDir, { recursive: true });

  return {
    tmpDir,
    async ensure(conv) {
      const spawn = JSON.parse(conv.spawn_args || "{}") as SpawnConfig;
      const mcpEnv = encodeMcpEnv(spawn.mcpServers ?? []);
      const result = await pool.ensure(conv.id, {
        cwd: conv.workspace_dir ?? homedir(),
        // Host presentation capability: also available to legacy sessions, without rewriting their snapshot.
        args: buildArgs({ ...spawn, uiInstructions: `${spawn.uiInstructions ?? UI_INSTRUCTIONS}\n\n${UI_PRESENTATION_POLICY}` }, tmpDir, conv.id),
        resumeSessionFile: conv.session_file,
        env: mcpEnv ? { [MCP_ENV_VAR]: mcpEnv } : undefined,
      });
      if (result.sessionFile) setConversationSession(db, conv.id, result.sessionFile);
      return result;
    },
  };
}
