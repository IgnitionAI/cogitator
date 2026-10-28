import { checkRequestAuthorization } from "./request-authorization.js";
import { reconcileConfiguration } from "./classic-configuration.js";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConversation, setConversationSession, type ConversationRow } from "./conversations.js";
import type { Db } from "./db.js";
import { UI_INSTRUCTIONS, UI_PRESENTATION_POLICY } from "./generative-ui.js";
import { MCP_ENV_VAR, encodeMcpEnv } from "./mcp-env.js";
import { OWNED_PI_ENV } from "./reap-orphans.js";
import type { Paths } from "./paths.js";
import { PiPool } from "./pool.js";
import { buildArgs, type SpawnConfig } from "./spawn.js";

export interface SpawnerOptions {
  db: Db;
  pool: PiPool;
  paths: Paths;
}

/** Identité d'environnement : l'agent sait qu'il tourne dans le web UI, pas dans le TUI pi. */
const ENVIRONMENT_NOTICE = "Environnement : tu t'exécutes dans Cogitator, un panneau de contrôle web pour pi. L'utilisateur interagit depuis un navigateur : ne lui demande jamais de changer de mode, d'appuyer sur une touche ou d'utiliser le TUI pi — tu as déjà accès complet aux outils, agis directement.";

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
      return pool.serial(conv.id, async () => {
        const current = getConversation(db, conv.id);
        if (!current) throw new Error("conversation not found");
        conv = current;
        // I3 (amendé Durable) : le pool classic ne spawn JAMAIS pour une conversation
        // durable — la runtime Durable du contrôleur est le seul mécanisme (point
        // de composition src/runtime.ts). Un spawn ici serait un processus non géré.
        if (conv.runtime_kind === "durable") {
          throw new Error("conversation durable : aucun processus pi classic (runtime.ts)");
        }
        const spawn = JSON.parse(conv.spawn_args || "{}") as SpawnConfig;
        const mcpEnv = encodeMcpEnv(spawn.mcpServers ?? []);
        const env: Record<string, string> = {
          [OWNED_PI_ENV]: "1",
          COGITATOR_HOME: paths.home,
          COGITATOR_CONVERSATION_ID: conv.id,
        };
        if (process.env.COGITATOR_URL) env.COGITATOR_URL = process.env.COGITATOR_URL;
        if (mcpEnv) env[MCP_ENV_VAR] = mcpEnv;
        const result = await pool.ensure(conv.id, {
          cwd: conv.workspace_dir ?? homedir(),
          // Host presentation capability: also available to legacy sessions, without rewriting their snapshot.
          args: buildArgs({ ...spawn, uiInstructions: `${spawn.uiInstructions ?? UI_INSTRUCTIONS}\n\n${UI_PRESENTATION_POLICY}\n\n${ENVIRONMENT_NOTICE}` }, tmpDir, conv.id),
          resumeSessionFile: conv.session_file,
          initialize: client => reconcileConfiguration(db, pool, conv.id, client),
          env,
        });
        try {
          checkRequestAuthorization();
          if (result.sessionFile) setConversationSession(db, conv.id, result.sessionFile);
        } catch (error) { await pool.evict(conv.id); throw error; }
        return result;
      });
    },
  };
}
