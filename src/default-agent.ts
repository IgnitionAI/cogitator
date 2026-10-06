import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "./agents.js";
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

export const CHEF_DE_PROJET_PROMPT = `Tu es le Chef de Projet de ce workspace. Ton tableau de bord est le fichier cogitator.board.json à la racine du projet (format : { "version": 1, "cards": [...] } avec statuts backlog/todo/in_progress/done/canceled).

Tes responsabilités :
1. LIRE le board avant de répondre sur l'état du projet (read de cogitator.board.json, ou outils MCP cogitator_board_*).
2. Créer, déplacer, mettre à jour et commenter les cartes (via les outils MCP cogitator_board_create_card / move / update_card / comment).
3. Relier les cartes aux conversations de travail (conversation_ids) pour que l'activité fichiers se cumule sur la carte.
4. Repérer les cartes stagnantes (in_progress sans activité récente) et les blocages (blocked_by non résolus).
4bis. Lancer les agents sur leurs tickets : assigne la carte (assignee_agent_id = id d'un agent Cogitator) puis cogitator_board_start_work — la conversation spawnée dans le workspace est automatiquement liée à la carte (activité cumulée).
5. Proposer des priorités — ne jamais décider seul d'annuler une carte sans confirmation explicite.
6. Fournir des bilans : "où on en est", "qu'est-ce qui bloque", "prochaines étapes" — courts et factuels.

Règles : réponds en français, structure en listes courtes. Une carte = une unité de travail livrable. Le board est la source de vérité : si la réalité diverge du board, mets le board à jour (ou propose de le faire).`;

/** Seed du Chef de Projet (agent de gestion de projet, par workspace via son cwd). */
function seedChefDeProjet(db: Db, paths: Paths): { created: boolean; agentId?: string } {
  const existing = db.prepare("SELECT id FROM agent_preset WHERE slug = 'chef-de-projet'").get();
  if (existing) return { created: false };
  const piSettings = readJson<{ defaultProvider?: string; defaultModel?: string }>(
    join(paths.piAgentDir, "settings.json"),
    {},
  );
  const root = findPackageRoot();
  const script = root ? join(root, "dist", "src", "mcp-server.js") : null;
  const mcpServers = script
    ? [{ name: "cogitator", command: "node", args: [script] }]
    : [];
  const agent = createAgent(db, {
    name: "Chef de Projet",
    description: "Agent de gestion de projet : pilote le board kanban du workspace (cogitator.board.json), suit les cartes, détecte les blocages, relie conversations et activité. Skills complets.",
    provider: piSettings.defaultProvider ?? "openai",
    model: piSettings.defaultModel ?? "gpt-5.4",
    system_prompt: CHEF_DE_PROJET_PROMPT,
    skills: [],
    mcp_servers: mcpServers,
  });
  return { created: true, agentId: agent.id };
}

/**
 * Seed du Majordome : si aucun agent n'existe, crée l'agent opérateur par défaut.
 * Provider/modèle repris des defaults pi (settings.json) ; MCP = serveur Cogitator embarqué.
 */
export function seedDefaultAgent(db: Db, paths: Paths): { created: boolean; agentId?: string } {
  const count = db.prepare("SELECT COUNT(*) AS n FROM agent_preset").get() as { n: number };
  if (count.n > 0) return { created: false };
  const piSettings = readJson<{ defaultProvider?: string; defaultModel?: string }>(
    join(paths.piAgentDir, "settings.json"),
    {},
  );
  const root = findPackageRoot();
  const script = root ? join(root, "dist", "src", "mcp-server.js") : null;
  const mcpServers = script && existsSync(script)
    ? [{ name: "cogitator", command: "node", args: [script] }]
    : [];
  const agent = createAgent(db, {
    name: "Majordome",
    description: "Agent opérateur Cogitator : crée des agents, des crons, gère workspaces et conversations via les outils MCP cogitator_.",
    provider: piSettings.defaultProvider ?? "openai",
    model: piSettings.defaultModel ?? "gpt-5.4",
    system_prompt: MAJORDOME_PROMPT,
    skills: [],
    mcp_servers: mcpServers,
  });
  db.prepare("UPDATE agent_preset SET is_default = 1 WHERE id = ?").run(agent.id);
  return { created: true, agentId: agent.id };
}

/** Seed des agents par défaut : Majordome (si aucun agent) + Chef de Projet (si absent). */
export function seedDefaultAgents(db: Db, paths: Paths): { majordome: boolean; chef: boolean } {
  const m = seedDefaultAgent(db, paths);
  const c = seedChefDeProjet(db, paths);
  return { majordome: m.created, chef: c.created };
}
