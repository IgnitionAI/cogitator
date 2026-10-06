# ADR-001 — Apply-on-spawn via flags natifs pi

- Statut : accepté
- Date : 2026-10-06

## Contexte

La config d'un agent (provider, modèle, thinking, skills, prompt, outils, MCP) doit s'appliquer aux sessions pi. pi ne peut pas être reconfiguré à chaud : il lit sa config au démarrage du processus et n'expose pas de RPC de reconfiguration (pi-web-simple s'en est heurté en écrivant directement `settings.json`/`auth.json`).

## Décision

Chaque conversation est spawnée avec des **flags CLI natifs** matérialisés depuis le preset :

- `--model <provider>/<id>:<thinking>`
- `--append-system-prompt <fichier>`
- `--no-skills` + `--skill <path>` répété (skills exactes, pas la découverte globale)
- `--tools` / `--exclude-tools`
- MCP : `pi.registerMcpServer()` par l'extension au `session_start`

Une session ouverte **garde sa config figée** ; les modifications de preset n'affectent que les spawns suivants.

## Conséquences

+ Prévisible, pas de mutation sauvage de sessions en cours, zéro fichier écrit dans les workspaces
+ Bénéficie des évolutions de pi (nouveaux flags = nouvelles capacités d'agent)
− Une session en cours ne voit pas les changements de preset (comportement voulu, documenté dans l'UI)

## Alternatives rejetées

- Écrire dans `settings.json` / `auth.json` globaux → même pi-web-simple s'y est brûlé ; risque de corruption ; pas de notion de preset
- Générer un dossier projet temporaire par agent → inutile depuis que pi 1.0.4 expose `--skill` repeatable
