# Cogitator

**Panneau de contrôle web pour [pi](https://pi.dev)** — l'agent de coding en CLI.

Cogitator orchestre tes processus pi comme l'Adeptus Mechanicus pilote ses cogitateurs : des agents composables, des workspaces, des conversations libres et un cron — le tout configurable depuis un navigateur, sans quitter l'écosystème pi.

## Ce que Cogitator fait

- **Agents composables** : un agent = `provider + modèle + thinking + skills + MCP + prompt de scope + subagents`. Chaque conversation pi est spawnée avec les flags natifs (`--model id:thinking`, `--no-skills --skill …`, `--append-system-prompt`, allowlist d'outils).
- **Workspaces** : un dossier sur disque = un workspace (aligné sur le modèle cwd-bound de pi), avec agent par défaut.
- **Conversations libres** : aucun workspace, provider/modèle ou agent choisi à la volée.
- **Cron** : tâches planifiées qui tirent un prompt contre un agent, résultat append dans une session dédiée, busy-guard anti-chevauchement.
- **Config pi complète** : providers (codex, claude, kimi…) lus/écrits via `models.json` / `auth.json`, skills scannés depuis les emplacements natifs, MCP user-level (`~/.pi/agent/mcp.json`).

## Installation (cible)

```sh
pi install npm:@ignitionai/cogitator
# puis dans pi :
/cogitator          # démarre l'UI sur http://127.0.0.1:5320
```

Ou standalone : `npx @ignitionai/cogitator`

## État du projet

🚧 **Phase spécification** — le package d'architecture est dans [`docs/`](docs/architecture/domain-model.md). Aucun code source pour l'instant. Voir [`docs/context/plans/active/0001-mvp.md`](docs/context/plans/active/0001-mvp.md).

## Documentation

| Document | Contenu |
|---|---|
| [Domain Model](docs/architecture/domain-model.md) | Bounded contexts, entités, invariants, diagramme ER |
| [Blueprint](docs/architecture/blueprint.md) | Composants, process pool, spawn flags, cron, apply |
| [API Contract](docs/architecture/api-contract.md) | Endpoints REST + SSE |
| [Décisions (ADRs)](docs/context/decisions/) | Pourquoi ce design (7 ADRs + stack decision record) |
| [Plan MVP](docs/context/plans/active/0001-mvp.md) | Jalons M0 → M6 |
| [Context Index](docs/context/README.md) | Index durable du projet |
