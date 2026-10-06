# Context Index — Cogitator

Index durable et léger. Mis à jour à chaque changement architectural. Les sources de vérité : ce fichier, [`current-state.md`](current-state.md), [`decisions/`](decisions/) et [`plans/`](plans/).

## Qu'est-ce que Cogitator

Panneau de contrôle web local pour [pi](https://pi.dev) : agents composables (provider + modèle + thinking + skills + MCP + subagents + prompt de scope), workspaces directory-based, conversations libres ou par workspace, cron avec busy-guard. Solo, local (`127.0.0.1:5320`), sans auth.

## État courant

Greenfield — phase spécification terminée (commit initial). Aucun code source encore. Voir [`current-state.md`](current-state.md).

## Documents

| Document | Rôle |
|---|---|
| [Domain Model](../architecture/domain-model.md) | Bounded contexts, entités, invariants, ER |
| [Blueprint](../architecture/blueprint.md) | Composants, pool, flags, cron, apply |
| [API Contract](../architecture/api-contract.md) | REST + SSE |
| [Décisions](decisions/) | 7 ADRs + stack decision record + contrat + checklist |
| [Plan MVP](plans/active/0001-mvp.md) | Jalons M0→M6 |

## Décisions structurantes (raccourci)

1. Config agents **matérialisée en flags natifs pi** à chaque spawn — jamais de config pi mutable à chaud (ADR-001)
2. MCP par agent via **`registerMcpServer`** (builtin) (ADR-002)
3. Workspace = **dossier disque** unique (ADR-003)
4. Cron **in-process** avec busy-guard ; limite "serveur allumé" assumée (ADR-004)
5. Subagents = **génération de définitions herdr** `noo-*.md` ; une seule vérité d'exécution (ADR-005)
6. Store **SQLite** unique `~/.cogitator/cogitator.db` (ADR-006)
7. **TypeScript fullstack**, React+Vite, SSE, packaging pi package `@ignitionai/cogitator` (ADR-007)

## Conventions inviolables

- Jamais d'écriture dans les workspaces ; jamais dans `settings.json`/`auth.json` hors Registry (atomic + backup)
- Spawns pi uniquement via `PiProcessPool` avec snapshot figé
- Binding `127.0.0.1` uniquement
- Préfixe `noo-` réservé aux définitions herdr générées
