<div align="center">

<img src="web/public/icon.png" width="120" alt="Cogitator — engrenage-nébuleuse" />

# Cogitator

**Panneau de contrôle web pour [pi](https://pi.dev)** — agents composables, workspaces, kanban GitHub natif, cron.

[![npm version](https://img.shields.io/npm/v/@ignitionai/cogitator)](https://www.npmjs.com/package/@ignitionai/cogitator)
[![pi package](https://img.shields.io/badge/pi-package-5e6ad2)](https://pi.dev/packages)
[![license](https://img.shields.io/npm/l/@ignitionai/cogitator)](./LICENSE)

</div>

Cogitator orchestre tes processus pi depuis un navigateur : tu composes des agents (provider + modèle + thinking + skills + MCP + subagents), tu pilotes des workspaces projets, tu dispatch du travail sur un board kanban dont la source de vérité est **GitHub Issues**, et tout le développement est tracé (fichiers modifiés, diffs, feed chronologique).

## Installation

```sh
pi install npm:@ignitionai/cogitator
```

Puis dans pi :

```text
/cogitator          # démarre le serveur détaché et ouvre http://127.0.0.1:5320
```

Ou standalone : `npx @ignitionai/cogitator` (Node ≥ 22).

## Ce que Cogitator fait

- **Agents composables** — un preset = provider + modèle + thinking + skills exactes + serveurs MCP + prompt de scope + subagents. Matérialisé en flags natifs pi à chaque spawn (`--model id:thinking`, `--no-skills --skill …`, `--append-system-prompt`).
- **La trinité seedée** — Majordome (opérateur, agent par défaut), Chef de Projet (board, dispatch, méthodes to-tickets/use-delegate), Architecte de Skills (création de SKILL.md). Skills complets, MCP Cogitator (28 outils).
- **Workspaces projets** — page dédiée par dossier : board, activité fichiers (+/−), feed chronologique, arborescence read-only, équipe (qui fait quoi), chat Chef de Projet, setup de projet en un clic.
- **Kanban = GitHub Issues** — chaque carte est une issue (labels `status:`/`priority:`), blocking edges natifs, write-through via `gh`. Zéro sync, une seule vérité, visible sur github.com.
- **Dispatch** — « 🚀 Lancer l'agent » sur un ticket : conversation spawnée dans le workspace, carte liée (activité cumulée), passage en cours.
- **Conversations** — streaming SSE avec reprise après coupure, code copiable, outils structurés et diffs, images (collage), historique et skills via `/skill:nom`.
- **UI interactive automatique** — l’agent choisit entre texte, formulaires, choix, checklists et tableaux selon le besoin, dans les conversations et les workspaces. Réponses transmises explicitement et conservées dans les JSONL pi ; aucun HTML/JavaScript généré exécuté. [Contrat et limites](docs/chat-generative-ui.md).
- **Cron** — tâches planifiées (busy-guard, catchup), runs tracés, notifications.
- **Providers & skills** — read model de la config pi (auth par `pi auth check`), écritures atomiques + backup, import de skills (GitHub, local, npx).

## Architecture

Specs complètes dans [`docs/`](docs/) : [domain model](docs/architecture/domain-model.md), [blueprint](docs/architecture/blueprint.md), [API contract](docs/architecture/api-contract.md), [ADRs](docs/context/decisions/) (apply-on-spawn, MCP par `registerMcpServer`, board GitHub single-writer…). TypeScript strict partout, zod aux frontières, 92 tests.

```text
Browser (React) → REST + SSE → serveur Node → pool de processus `pi --mode rpc`
                                    ↕ SQLite ~/.cogitator + fichiers pi natifs
```

## Licence

MIT — © IgnitionAI
