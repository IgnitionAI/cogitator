# Architecture Contract — Cogitator

Règles vérifiables par la machine. Toute PR qui les enfreint échoue la review.

## Interdictions

1. **I1** — Aucune écriture dans `~/.pi/agent/settings.json` ou `~/.pi/agent/auth.json` hors des endpoints Registry (atomic write + `.bak` obligatoires).
2. **I2** — Aucune écriture dans les dossiers des workspaces (cogitator lit le filesystem ; il ne le modifie pas).
3. **I3** — Aucun spawn de process pi en dehors de `PiProcessPool` (un seul point de spawn ; flags matérialisés depuis le snapshot de preset, jamais reconstruits ad hoc).
4. **I4** — L'entry de l'extension pi ne doit rien exécuter au load si ce n'est enregistrer la commande `/cogitator` (pas de serveur démarré dans le process hôte).
5. **I5** — Aucune donnée de transcript dans la base SQLite (uniquement métadonnées + snapshot de config ; les transcripts vivent dans les `.jsonl` pi).

## Obligations

1. **O1** — Toute écriture de preset d'agent déclenche l'Apply (génération/suppression des `.md` herdr) ; le store et le registre ne divergent pas.
2. **O2** — Les définitions herdr générées portent le préfixe `noo-<agent-slug>-` et sont les seules fichiers que cogitator supprime dans `~/.pi/agents/` (jamais un fichier non généré par lui).
3. **O3** — Un run cron crée toujours un `CronRun` (succès comme échec comme skip).
4. **O4** — Le serveur écoute sur `127.0.0.1` uniquement.
5. **O5** — Les flags de spawn passent `--no-skills` dès qu'une liste de skills explicite est fournie (jamais de fusion avec la découverte globale).
6. **O6** — Le snapshot de config est figé dans `Conversation` au spawn ; les modifications de preset n'altèrent jamais une session ouverte.

## Conventions

- Slugs : kebab-case, ≤64 caractères, préfixe `noo-` réservé aux subagents générés.
- Ports : serveur 5320 (variables `COGITATOR_PORT`).
- Données : `~/.cogitator/` (db, tmp prompts, logs).
- Erreurs API : JSON `{ "error": string }` + code HTTP correct.
