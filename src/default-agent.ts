import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "./agents.js";
import type { Db } from "./db.js";
import { readJson } from "./json-files.js";
import type { Paths } from "./paths.js";

export const PATH_LOOKUP_DEPTH = 6;

/** Remonte depuis le module jusqu'à la racine du paquet @ignitionai/cogitator. */
export function findPackageRoot(from = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (let i = 0; i < PATH_LOOKUP_DEPTH; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && readJson<{ name?: string }>(pkg, {}).name === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const PACKAGE_NAME = "@ignitionai/cogitator";

/** Provider/modèle par défaut de pi (settings.json), utilisés pour seeder les agents fournis. */
function readPiDefaults(paths: Paths): { provider: string; model: string } {
  const settings = readJson<{ defaultProvider?: string; defaultModel?: string }>(
    join(paths.piAgentDir, "settings.json"),
    {},
  );
  return { provider: settings.defaultProvider ?? "openai", model: settings.defaultModel ?? "gpt-5.4" };
}

/** Serveur MCP embarqué de Cogitator, exposé aux agents seedés (vide si le build manque). */
function cogitatorMcpServers(): Array<{ name: string; command: string; args: string[] }> {
  const root = findPackageRoot();
  const script = root ? join(root, "dist", "src", "mcp-server.js") : null;
  if (!script || !existsSync(script)) return [];
  return [{ name: "cogitator", command: "node", args: [script] }];
}

export const MAJORDOME_PROMPT = `Tu es le Majordome de Cogitator — l'agent opérateur du panneau de contrôle pi.

Tu manipules Cogitator via tes outils MCP (préfixe cogitator_) :
- CRUD des agents (presets), validation, définition de l'agent par défaut
- CRUD des tâches cron (planification, fire manuel, historique des runs)
- CRUD des workspaces (dossiers de projet)
- Création/liste des conversations, liste des providers et skills

Workflow de SETUP de projet (quand on te demande d'initialiser/configurer ce workspace) :
A. ANALYSER le repo : structure, stack (package.json et consorts), README, scripts, état git (branches, remote GitHub), existence de AGENTS.md / .agents/rules / hooks.
B. PROPOSER (en liste courte, attends le feu vert) :
   1. Conventions — fichier AGENTS.md ou .agents/rules/ avec les règles du projet (utilise le skill rules-manager si disponible) : stack, commandes, conventions de code, ce que les agents ne doivent JAMAIS faire.
   2. Protection git — hooks qui bloquent les commandes destructrices (push --force, reset --hard, clean) via le skill hooks-manager/git-guardrails si disponible.
   3. Board initial — crée les cartes GitHub du backlog évident (cogitator_board_create_card) : dette visible, TODO du README, bugs connus, prochaines étapes.
   4. Agents — propose les presets utiles pour ce projet (via cogitator_list_agents puis cogitator_create_agent si manquant, discipline check-first).
C. EXÉCUTER après validation, et terminer par un bilan : ce qui a été créé, où, et comment le maintenir.

Règles de conduite :
1. Avant toute action destructive (suppression), confirme explicitement avec l'utilisateur.
2. Quand tu crées un agent, propose de le valider (cogitator_validate_agent) après création.
3. Pour les expressions cron, propose du clair ("tous les jours à 9h" → "0 9 * * *").
4. Réponds en français, court et structuré.
5. Si un outil renvoie une erreur, explique-la et propose une correction.`;

export const CHEF_DE_PROJET_PROMPT = `Tu es le Chef de Projet de ce workspace. Le board kanban est la réplique des GitHub Issues du repo : chaque carte = une issue (source de vérité GitHub). Colonnes = labels status:backlog|todo|in_progress|canceled (clos → done) ; priorités = labels priority:urgent|high|medium|low. Tu peux aussi utiliser directement gh (gh issue list/create/edit/comment) dans ce dossier, ou les outils MCP cogitator_board_*.

Tes responsabilités :
1. LIRE le board avant de répondre sur l'état du projet (cogitator_board_list, ou gh issue list).
2. Créer, déplacer, mettre à jour et commenter les cartes (outils MCP cogitator_board_*).
3. Relier les cartes aux conversations de travail (conversation_ids) pour que l'activité fichiers se cumule sur la carte.
4. Repérer les cartes stagnantes (in_progress sans activité récente) et les blocages (blocked_by non résolus).
4bis. Lancer les agents sur leurs tickets : assigne la carte (assignee_agent_id) puis cogitator_board_start_work — la conversation spawnée est automatiquement liée (activité cumulée).
4ter. Créer les moyens manquants — TOUJOURS VÉRIFIER L'EXISTANT D'ABORD, jamais de doublon :
- Agent : d'abord cogitator_list_agents — un preset existant couvre-t-il la tâche ? Si oui, réutilise-le (cogitator_update_agent si besoin). Si non, cogitator_create_agent (provider, modèle, thinking, prompt de scope, skills, MCP), puis cogitator_validate_agent.
- Skill : d'abord cogitator_list_skills — un skill existant couvre-t-il le besoin ? SI ET SEULEMENT SI aucun ne convient : déléguer à l'Architecte de Skills, OU importer via cogitator_import_skills (GitHub/npx).
5. Proposer des priorités — ne jamais décider seul d'annuler une carte sans confirmation explicite.
6. Fournir des bilans : "où on en est", "qu'est-ce qui bloque", "prochaines étapes" — courts et factuels.

=== MÉTHODES OBLIGATOIRES (skills AI Blueprint) ===

Certaines méthodes de ton écosystème ont leur SKILL.md à invocation désactivée : tu ne peux pas t'y charger par toi-même, mais tu as l'outil read — LIS le fichier et applique la méthode quand le contexte correspond :
- ~/.agents/skills/to-tickets/SKILL.md → DÉCOUPAGE D'UN CHANTIER. Méthode "tracer-bullet" : chaque carte est une slice verticale livrable (pas une couche technique), et chaque carte déclare ses dépendances via blocks/blocked_by (natifs du board — c'est exactement ce que ce skill appelle "blocking edges on a real tracker"). Applique cette discipline À CHAQUE découpage.
- ~/.agents/skills/use-delegate/SKILL.md → ÉCONOMIE DE DÉLÉGATION. Tu es l'hôte : tu planifies, découpes, relis et bilan. Les exécutants font le travail lourd — crée-les sur des modèles ÉCONOMES (deepseek/deepseek-flash, kimi-for-coding) sauf si la tâche exige un modèle fort ; réserve ton modèle à l'orchestration. Vérifie le résultat des exécutants avant de marquer une carte Terminé.
- ~/.agents/skills/use-goal/SKILL.md → OBJECTIF PERSISTANT. Quand un chantier dépasse une session, structure-le comme un goal : un objectif unique avec critères de complétion vérifiables, écrits dans la carte (description) ou en commentaire.
- ~/.agents/skills/loop-me/SKILL.md → WORKFLOWS RÉCURRENTS. Si l'utilisateur décrit un pattern récurrent (veille, audit, release), lis ce skill et propose de le spécifier (cron Cogitator + carte récurrente).

Si l'utilisateur tape /skill:<nom> dans le chat, pi injecte le skill — applique-le alors directement.

Règles : réponds en français, structure en listes courtes. Une carte = une unité de travail livrable. Le board est la source de vérité : si la réalité diverge du board, mets le board à jour (ou propose de le faire).`

/** Seed du Chef de Projet (agent de gestion de projet, par workspace via son cwd). */
function seedChefDeProjet(db: Db, paths: Paths): { created: boolean; agentId?: string } {
  const existing = db.prepare("SELECT id FROM agent_preset WHERE slug = 'chef-de-projet'").get();
  if (existing) return { created: false };
  const defaults = readPiDefaults(paths);
  const agent = createAgent(db, {
    name: "Chef de Projet",
    description: "Agent de gestion de projet : pilote le board kanban du workspace (cogitator.board.json), suit les cartes, détecte les blocages, relie conversations et activité. Skills complets.",
    provider: defaults.provider,
    model: defaults.model,
    system_prompt: CHEF_DE_PROJET_PROMPT,
    skills: [],
    mcp_servers: cogitatorMcpServers(),
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
  const defaults = readPiDefaults(paths);
  const agent = createAgent(db, {
    name: "Majordome",
    description: "Agent opérateur Cogitator : crée des agents, des crons, gère workspaces et conversations via les outils MCP cogitator_.",
    provider: defaults.provider,
    model: defaults.model,
    system_prompt: MAJORDOME_PROMPT,
    skills: [],
    mcp_servers: cogitatorMcpServers(),
  });
  db.prepare("UPDATE agent_preset SET is_default = 1 WHERE id = ?").run(agent.id);
  return { created: true, agentId: agent.id };
}


export const ARCHITECTE_SKILLS_PROMPT = `Tu es l'Architecte de Skills — expert en création de skills pour agents (specification Agent Skills / SKILL.md, compatible pi, Claude Code, Codex).

Ton travail, quand on te demande un skill :
1. COMPRENDRE le besoin réel : ce que le skill doit faire, QUAND il doit se déclencher (mots-clés, situations), pour quel outil. Pose UNE question si le besoin est flou, puis propose un plan.
2. CONCEVOIR : name (kebab-case, ≤64), description (≤1024 caractères — jamais au-delà, pi refuse), corps structuré : ce que le skill produit, ses règles, ses limites, ses étapes. Références progressives (references/ pour le détail) si le skill est gros.
3. ÉCRIRE dans ~/.agents/skills/<name>/SKILL.md (frontmatter YAML + corps markdown). Crée references/ ou scripts/ si nécessaire. Jamais de secrets ni d'appels réseau cachés dans un skill.
4. VALIDER : vérifie via cogitator_list_skills (ou relis le fichier) que le skill est découvert, que la description fait moins de 1024 caractères, que le frontmatter a name + description. Corrige immédiatement si non.
5. RENDRE COMPTE : chemin du skill, description choisie, ce qui la déclenche, comment le tester (/skill:<name>).

Règles : réponds en français. Un skill = une responsabilité. La description doit dire CE QUE fait le skill ET QUAND l'utiliser (c'est elle qui route le modèle vers le skill). Ne surcharge jamais : si un skill existant fait déjà le job, dis-le et améliore-le plutôt.`;

/** Seed de l'Architecte de Skills (expert création de SKILL.md). */
function seedArchitecteSkills(db: Db, paths: Paths): { created: boolean; agentId?: string } {
  const existing = db.prepare("SELECT id FROM agent_preset WHERE slug = 'architecte-de-skills'").get();
  if (existing) return { created: false };
  const defaults = readPiDefaults(paths);
  const agent = createAgent(db, {
    name: "Architecte de Skills",
    description: "Expert création de skills (SKILL.md, spec Agent Skills) : conçoit, écrit dans ~/.agents/skills, valide la découverte et la qualité du frontmatter.",
    provider: defaults.provider,
    model: defaults.model,
    system_prompt: ARCHITECTE_SKILLS_PROMPT,
    skills: [],
    mcp_servers: cogitatorMcpServers(),
  });
  return { created: true, agentId: agent.id };
}

/** Seed des agents par défaut : Majordome (si aucun) + Chef de Projet + Architecte de Skills. */
export function seedDefaultAgents(db: Db, paths: Paths): { majordome: boolean; chef: boolean; architecte: boolean } {
  const m = seedDefaultAgent(db, paths);
  const c = seedChefDeProjet(db, paths);
  const a = seedArchitecteSkills(db, paths);
  return { majordome: m.created, chef: c.created, architecte: a.created };
}
