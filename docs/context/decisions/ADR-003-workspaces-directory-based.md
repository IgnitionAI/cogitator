# ADR-003 — Workspaces directory-based

- Statut : accepté
- Date : 2026-10-06

## Contexte

Un workspace peut être un regroupement logique (propre à cogitator) ou un dossier du filesystem. Le modèle natif de pi est cwd-bound : sessions, skills projet, settings projet et approvals MCP sont rattachés au répertoire de travail.

## Décision

Un workspace = **un dossier existant sur disque** (unique) + métadonnées cogitator (nom, agent par défaut). Cogitator ne duplique pas le mécanisme de découverte de pi ; il s'appuie dessus.

## Conséquences

+ Sessions, skills et config projet d'un workspace fonctionnent nativement dans pi (CLI comprise)
+ File-picker serveur simple, pas de mapping à maintenir
− Pas de workspace "virtuel" détaché du filesystem (non demandé)

## Alternatives rejetées

- Workspaces purement logiques → réimplémente la découverte cwd de pi pour rien
