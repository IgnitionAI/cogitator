# API Contract — Cogitator

Base URL : `http://127.0.0.1:5320`. Tout est local, sans auth (solo machine — ADR-004/007).
Erreurs : JSON `{ "error": string }`, codes HTTP standards. Écritures sensibles : atomic write + backup (`.bak`) côté serveur.

## Registry (config pi)

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/providers` | Providers du catalogue pi + statut auth + modèles par provider |
| POST | `/api/providers` | Ajouter un provider (écrit `models.json` + `auth.json`) |
| PUT | `/api/providers/:id` | Modifier (merge, champs préservés inconnus) |
| DELETE | `/api/providers/:id` | Supprimer + retirer la clé d'`auth.json` |
| GET | `/api/skills` | Skills découverts (union des emplacements pi) : name, description, path |
| GET | `/api/mcp` | Serveurs MCP user-level (`~/.pi/agent/mcp.json`) |
| PUT | `/api/mcp` | Remplace le fichier (validé avant écriture) |

## Agents

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/agents` | Liste des presets (sans prompts complets) |
| POST | `/api/agents` | Créer + Apply (génère les `.md` subagents) |
| GET | `/api/agents/:id` | Détail complet |
| PUT | `/api/agents/:id` | Modifier + Apply |
| DELETE | `/api/agents/:id` | Supprimer + retirer les `.md` générés |
| POST | `/api/agents/:id/validate` | Vérifie provider/modèle/skills/MCP (existence, shape) |

## Workspaces

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/workspaces` | Liste + nb de conversations |
| POST | `/api/workspaces` | Créer `{ dir, name?, default_agent_id? }` — le dossier doit exister |
| PUT | `/api/workspaces/:id` | Renommer, changer l'agent par défaut |
| DELETE | `/api/workspaces/:id` | Supprimer (les sessions pi survivent sur disque) |
| GET | `/api/fs/browse?path=` | File-picker serveur (home racine, entrée par entrée) |

## Conversations

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/conversations?workspace_id=&include=all` | Liste (métadonnées depuis la base + titre depuis le `.jsonl`) |
| POST | `/api/conversations` | Spawn. Body : `{ workspace_id? }` + soit `{ agent_id }` soit `{ provider, model, thinking?, system_prompt?, skills?, tools? }` (ad hoc), `prompt?` initial |
| GET | `/api/conversations/:id` | Détail + snapshot de config de spawn |
| GET | `/api/conversations/:id/events` | **SSE** — événements pi (tokens, tool calls, status) |
| POST | `/api/conversations/:id/messages` | Envoyer un message `{ text, images? }` |
| POST | `/api/conversations/:id/stop` | Interrompre le tour en cours |
| POST | `/api/conversations/:id/model` | Changer de modèle en cours de session (natif pi) |
| DELETE | `/api/conversations/:id` | Fermer + retirer du pool (le `.jsonl` reste) |

## Schedules (cron)

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/schedules` | Tâches + `last_run_at`, `next_run_at` calculé |
| POST | `/api/schedules` | Créer `{ name, cron_expr, prompt, agent_id?, workspace_id?, output_policy, busy_policy, catchup }` |
| PUT | `/api/schedules/:id` | Modifier / enable / disable |
| DELETE | `/api/schedules/:id` | Supprimer (l'historique des runs est conservé) |
| POST | `/api/schedules/:id/run` | Fire manuel immédiat |
| GET | `/api/schedules/:id/runs?limit=` | Historique (runs récents d'abord) |

## Events global

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/events` | **SSE** — naissance/mort de sessions, changements de statut, fins de run cron (pour badges/notifs UI) |

## Health

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/health` | `{ ok, version, pi_version, sessions_active, db }` |
