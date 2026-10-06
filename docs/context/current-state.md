# AS-IS — Cogitator (baseline greenfield)

Date : 2026-10-06

## État

**M0 (squelette) et M1 (registry + agents) terminés le 2026-10-06** — branche `dev`.

- **M0** : serveur HTTP natif (health + placeholder), schéma SQLite v1, extension pi `/cogitator` (spawn détaché). Vérifié : critères de sortie + checklist items 1, 10.
- **M1** : read model pi (providers + statut auth via `pi auth check`, skills scannés, `mcp.json`), CRUD providers (models.json/auth.json atomiques + backup), CRUD AgentPresets + validation, Apply → définitions herdr `noo-*.md` (O1/O2), détection pi-mcp-adapter dans health. 13 tests au vert ; E2E live validé (création d'un preset openai/gpt-5.4 + subagent deepseek, validate 0 erreur, `.md` correct, cleanup propre). Checklist items 5, 6 verts.

Prochain : M2 (PiProcessPool + conversations).

## Environment cible de développement

- Machine du développeur : macOS, Node ≥22 (Homebrew node 26), pi 1.0.4 (global bun)
- pi installé avec extensions : herdr, pi-subagents, ponytail, context-mode, openwiki, pi-web-access, pi-mcp-adapter, rpiv-todo
- Providers configurés : kimi-coding (OAuth), openai (OAuth), xai (OAuth), deepseek (api_key)
- ~140 skills disponibles dans `~/.agents/skills` + `~/.pi/agent/skills`

## Points d'attention détectés

1. `pi-mcp-adapter` remplace le support MCP builtin → détection au démarrage de cogitator + avertissement UI (ADR-002)
2. Le modèle "agent" n'existe pas nativement dans pi → cogitator le matérialise en flags (ADR-001) ; le concept est propre à cogitator et documenté
3. Le cron dépend de la vie du serveur (ADR-004) — à réévaluer en v2 si besoin 24/7

## Prochaine étape

[`plans/active/0001-mvp.md`](plans/active/0001-mvp.md) — M0 (squelette) est le point d'entrée.
