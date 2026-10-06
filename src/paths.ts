import { join } from "node:path";

export interface Paths {
  /** Dossier de données cogitator (~/.cogitator) */
  home: string;
  db: string;
  /** Dossier agent pi (~/.pi/agent) : models-store.json, auth.json, mcp.json */
  piAgentDir: string;
  piModelsJson: string;
  piAuthJson: string;
  piMcpJson: string;
  /** Registre global herdr (~/.pi/agent/agents) */
  piAgentsDir: string;
  /** Emplacements de skills scannés */
  skillsDirs: string[];
}

// Tous overridables par env pour les tests : COGITATOR_HOME, COGITATOR_PI_AGENT_DIR,
// COGITATOR_AGENTS_DIR, COGITATOR_SKILLS_DIRS (séparés par ":")
export function getPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.COGITATOR_HOME ?? join(env.HOME ?? "~", ".cogitator");
  const piAgentDir = env.COGITATOR_PI_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  const piAgentsDir = env.COGITATOR_AGENTS_DIR ?? join(piAgentDir, "agents");
  const skillsDirs = (env.COGITATOR_SKILLS_DIRS ?? [
    join(env.HOME ?? "~", ".agents", "skills"),
    join(piAgentDir, "skills"),
  ].join(":")).split(":").filter(Boolean);
  return {
    home,
    db: join(home, "cogitator.db"),
    piAgentDir,
    piModelsJson: join(piAgentDir, "models.json"),
    piAuthJson: join(piAgentDir, "auth.json"),
    piMcpJson: join(piAgentDir, "mcp.json"),
    piAgentsDir,
    skillsDirs,
  };
}
