# Recette UI avec backend réel

## Verdict : PASS

Les quatre parcours ont été exécutés dans Chrome avec l’UI de production servie par le backend sur `127.0.0.1:5320`, les vrais processus pi et le provider authentifié `kimi-coding/kimi-for-coding`. Aucune API, réponse SSE ou exécution de modèle n’a été simulée.

La préparation initiale utilisait Vite. Ce service a été arrêté pendant la recette ; les parcours ont ensuite été repris sur l’UI de production pour éviter ce proxy instable. Aucun correctif cosmétique n’a été ajouté.

## Résultats observés

| Critère | Résultat | Preuve autoritative |
| --- | --- | --- |
| Créer un agent | PASS | Création depuis l’éditeur UI, relecture API et validation serveur sans erreur |
| Ouvrir une conversation, envoyer et interrompre | PASS | Création et envoi depuis l’UI ; 43 événements `text_delta` réels ; Stop accepté ; `agent_end` observé ; réponse persistée dans le fichier de session pi |
| Créer une carte, assigner, enregistrer et lancer | PASS | Issue GitHub [#5](https://github.com/IgnitionAI/cogitator/issues/5), lancement désactivé avant sauvegarde puis activé ; assignation relue ; conversation liée à la carte ; statut `in_progress` |
| Commentaires actualisés | PASS | Commentaire envoyé depuis l’UI puis affiché dans le détail sans fermer/réouvrir la carte ; également enregistré sur GitHub |
| Fichiers et activité actualisés | PASS | L’agent réel a écrit `acceptance-result.txt` avec `COGITATOR_REAL_ACCEPTANCE_OK` ; fichier relu sur disque et dans l’arborescence UI ; fichiers conversation et activité workspace/carte présents dans les API et l’UI |
| Deux runs cron avec reprise | PASS | Tâche créée et lancée deux fois depuis l’UI ; statuts `ok` / `ok` ; même `session_file` non nul ; deux réponses assistant `CRON_REAL_OK` dans ce même `.jsonl` |
| Nettoyage | PASS | Agent, workspace, deux conversations et tâche de test absents après relecture API ; issue GitHub #5 confirmée `CLOSED` |

La planification automatique de la tâche de recette était désactivée. Aucun agent existant ni workspace existant n’a été modifié. L’écriture Board utilise l’implémentation normale GitHub, y compris son assurance des labels système.

L’issue de recette est **fermée, pas supprimée**. Le répertoire temporaire et les fichiers de session pi restent disponibles comme preuves ; ils ne font pas partie du commit.

## Preuves locales

Dossier : `/tmp/cogitator-real-acceptance-3KxLHE/`

- `state.json` : IDs de recette, assertions et chemins de sessions.
- `agent-created.png`
- `conversation-stopped-mobile.png`
- `board-comment.png`
- `workspace-activity.png`
- `workspace-file.png`
- `cron-two-runs.png`
- `workspace/acceptance-result.txt`

Ces fichiers temporaires ne sont pas des fixtures permanentes ni des credentials à versionner.

## Rejouer explicitement

Le script refuse de fonctionner sans opt-in : il consomme des appels modèle et crée une issue GitHub sur le remote `origin` du dépôt courant. Il faut le backend réel actif, un build frontend disponible, Chrome et le Puppeteer du skill browser-tools. `CHROME_PATH` remplace le chemin Chrome macOS par défaut.

```bash
export COGITATOR_REAL_TEST=1
export BROWSER_TOOLS_DIR=/path/to/browser-tools
node scripts/ui-real-acceptance.mjs setup
# Copier le dossier "output" affiché :
export ACCEPTANCE_DIR=/tmp/cogitator-real-acceptance-XXXXXX
node scripts/ui-real-acceptance.mjs conversation
node scripts/ui-real-acceptance.mjs board
node scripts/ui-real-acceptance.mjs cron
node scripts/ui-real-acceptance.mjs cleanup
```

Les paramètres `REAL_PROVIDER`, `REAL_MODEL`, `COGITATOR_API_URL` et `COGITATOR_UI_URL` permettent de choisir explicitement les services. Par défaut, l’UI est servie par le backend, sans dépendance à Vite. Ne pas relancer une phase de création déjà réussie : reprendre la phase suivante ou nettoyer ses ressources identifiées.

## Isolation Git

Le dépôt était propre au début. La passe UI précédente était déjà commitée dans `918932b`, puis intégrée à la release `52b3252`. Un autre commit (`b5cf258`) est arrivé pendant la recette ; il n’a pas été modifié ni réécrit.

Vérifications finales : `npm run build` réussi, `npm test` **69/69**, vérification syntaxique du script et `git diff --check` réussis.

Cette passe ne versionne que le script de recette réelle et ce compte rendu. Aucun état de base de données, sidecar Board, fichier de session, capture, secret ou modification étrangère n’est embarqué.

Cette validation couvre les parcours demandés avec un provider réel. Elle ne prétend pas certifier tous les providers, appareils ou lecteurs d’écran.
