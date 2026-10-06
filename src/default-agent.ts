import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, getAgent } from "./agents.js";
import type { Db } from "./db.js";
import { readJson } from "./json-files.js";
import type { Paths } from "./paths.js";

/** Remonte depuis le module jusqu'à la racine du paquet @ignitionai/cogitator. */
export function findPackageRoot(from = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const name = (readJson<{ name?: string }>(pkg, {}).name ?? "") as string;
        if (name === "@ignitionai/cogitator") return dir;
      } catch {
        /* continue */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const MAJORDOME_PROMPT = `Tu es le Majordome de Cogitator — l'agent opérateur du panneau de contrôle pi.

Tu manipules Cogitator via tes outils MCP (préfixe cogitator_) :
- CRUD des agents (presets), validation, définition de l'agent par défaut
- CRUD des tâches cron (planification, fire manuel, historique des runs)
- CRUD des workspaces (dossiers de projet)
- Création/liste des conversations, liste des providers et skills

Règles de conduite :
1. Avant toute action destructive (suppression), confirme explicitement avec l'utilisateur.
2. Quand tu crées un agent, propose de le valider (cogitator_validate_agent) après création.
3. Pour les expressions cron, propose du clair ("tous les jours à 9h" → "0 9 * * *").
4. Réponds en français, court et structuré.
5. Si un outil renvoie une erreur, explique-la et propose une correction.`;

/**
 * Seed du Majordome : si aucun agent n'existe, crée l'agent opérateur par défaut.
 * Provider/modèle repris des defaults pi (settings.json) ; MCP = le serveur Cogitator embarqué.
 */
export function seedDefaultAgent(db: Db, paths: Paths): { created: boolean; agentId?: string } {
  const count = db.prepare("SELECT COUNT(*) AS n FROM agent_preset").get() as { n: number };
  if (count.n > 0) return { created: false };

  const piSettings = readJson<{ defaultProvider?: string; defaultModel?: string }>(
    join(paths.piAgentDir, "settings.json"),
    {},
  );
  const provider = piSettings.defaultProvider ?? "openai";
  const model = piSettings.defaultModel ?? "gpt-5.4";

  const root = findPackageRoot();
  const script = root ? join(root, "dist", "src", "mcp-server.js") : null;
  const mcpServers = script && existsSync(script)
    ? [{ name: "cogitator", command: "node", args: [script] }]
    : [];

  const agent = createAgent(db, {
    name: "Majordome",
    description: "Agent opérateur Cogitator : crée des agents, des crons, gère workspaces et conversations via les outils MCP cogitator_.",
    provider,
    model,
    system_prompt: MAJORDOME_PROMPT,
    skills: [],
    mcp_servers: mcpServers,
  });
  db.prepare("UPDATE agent_preset SET is_default = 1 WHERE id = ?").run(agent.id);
  return { created: true, agentId: getAgent(db, agent.id)?.id };
}
