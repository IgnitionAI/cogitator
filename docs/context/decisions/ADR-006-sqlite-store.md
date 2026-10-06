# ADR-006 — Store SQLite unique

- Statut : accepté
- Date : 2026-10-06

## Contexte

Besoins de persistance : presets, workspaces, conversations (métadonnées), tâches cron + historique. Candidats : fichiers JSON, SQLite.

## Décision

**SQLite** (`better-sqlite3`), un seul fichier : `~/.cogitator/cogitator.db`. Colonnes `json` via JSON1. Les transcripts de conversation ne sont **pas** dans la base : ils vivent dans les `.jsonl` pi (source de vérité), cogitator ne stocke que les métadonnées + snapshot de config de spawn.

## Conséquences

+ Requêtes simples (runs récents, conversations par workspace), intégrité, un seul fichier à sauvegarder
+ Même choix qu'AionUi (précédent éprouvé pour ce profil d'usage)
− Dépendance native better-sqlite3 (prebuilt binaires, acceptable sur macOS/Linux cibles)

## Alternatives rejetées

- JSON multi-fichiers → requêtes historique cron pénibles, risque d'écriture partielle
