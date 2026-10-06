# AS-IS — Cogitator (baseline greenfield)

Date : 2026-10-06

## État

**M0 (squelette) terminé le 2026-10-06** — branche `dev`. Le serveur HTTP natif répond sur `127.0.0.1:5320` (health + placeholder), le schéma SQLite v1 est en place (`~/.cogitator/cogitator.db`), l'extension pi charge sans warning et la commande `/cogitator` démarre le serveur détaché (survit à la session pi). Vérifié : critères de sortie M0 + checklist items 1 et 10.

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
