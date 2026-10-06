# ADR-004 — Cron in-process avec busy-guard

- Statut : accepté
- Date : 2026-10-06

## Contexte

Inspiration : le système de Scheduled Tasks d'[AionUi](https://github.com/iOfficeAI/AionUi) (CronService, CronStore, CronBusyGuard — tâche qui tire un prompt prédéfini contre un agent à heure fixe, résultat append dans une session). Exécuteur possible : processus du serveur cogitator, ou jobs système natifs (launchd/cron → `pi -p`).

## Décision

Cron **dans le processus serveur cogitator** :

- Spawn d'une conversation éphémère (agent + workspace de la tâche) à l'heure H
- Résultat append dans une session dédiée (visible dans l'UI) + événement SSE
- **Busy-guard** : jamais 2 runs simultanés d'une même tâche ; politique configurable par tâche : skip | queue | kill
- **Catchup** optionnel : 1 run de rattrapage si des exécutions ont été manquées
- **Limite assumée et affichée dans l'UI** : le cron ne tourne que si le serveur tourne

## Conséquences

+ Historique complet des runs dans le store (CronRun), notifications UI natives
+ Pas de double source de vérité (les sorties launchd finiraient hors de l'UI)
− Pas d'exécution 24/7 si la machine/serveur est arrêté (acceptable en v1, solo, local)

## Alternatives rejetées

- Jobs launchd natifs en v1 → sorties hors UI, double bookkeeping ; réévaluable en v2 via export
