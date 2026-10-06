# ADR-005 — Subagent setups : génération de définitions herdr natives

- Statut : accepté
- Date : 2026-10-06

## Contexte

Un preset d'agent inclut des setups de subagents (provider, modèle, thinking, skills, MCP, prompt). Cogitator pourrait définir son propre schéma et moteur d'exécution, ou configurer les moteurs existants (herdr : `~/.pi/agents/*.md` + spawn gates/supervision ; pi-subagents : registry).

## Décision

Le store cogitator garde une **copie de travail** des SubagentSetups (édition UI confortable, validation). Au **Apply** (save du preset), elles sont rendues en définitions herdr natives : `~/.pi/agents/noo-<agent-slug>-<sub-slug>.md`. L'exécution ne lit que le registre herdr.

## Conséquences

+ Une seule vérité à l'exécution ; un subagent créé dans l'UI est utilisable depuis pi en CLI, et vice versa
+ Hérite gratuitement des évolutions de herdr (gates, modèles, sessions)
− Cohérence store ↔ registre à maintenir (résolu par : l'UI n'écrit QUE via Apply ; une divergence est détectable par hash)

## Alternatives rejetées

- Format propre + moteur maison → réimplémente herdr (spawn gates, supervision, reprise de session) et crée une dérive CLI/UI
