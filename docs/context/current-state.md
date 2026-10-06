# AS-IS — Cogitator (baseline greenfield)

Date : 2026-10-06

## État

Projet créé ce jour (repo `IgnitionAI/cogitator`, branche `dev`). **Aucun code source.** Seul contenu : le package d'architecture (domain model, blueprint, API contract, ADRs, contrat, checklist, plan MVP).

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
