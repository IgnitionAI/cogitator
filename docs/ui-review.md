# Cogitator : passage UI/UX Impeccable

## Périmètre

Les six pages principales et les composants frontend ont été examinés par deux évaluations indépendantes (design et preuves techniques), puis corrigés. L’identité sombre, Inter, les tokens existants et le CSS natif sont conservés. Aucune dépendance applicative ajoutée.

Les corrections privilégient les parcours et les états, pas la décoration. Les principales décisions : préserver les brouillons, garder le composer visible, utiliser des contrôles natifs, distinguer chargement/erreur/vide et exiger une carte enregistrée avant lancement.

## Couverture

| Surface | Corrections / examen |
| --- | --- |
| Conversations / Chat | Brouillon et images conservés en cas d’échec ; garde contre envois répétés ; composition IME ; interruption d’une session active rouverte ; suivi du flux seulement près du bas ; reconnexion visible ; historique avec erreur/reprise ; disclosures nommés |
| Workspaces | Chargement/erreur/reprise ; choix de dossier au clavier ; navigation parent et ouverture explicite ; réponses feed obsolètes ignorées |
| Agents | Chargement/erreur/reprise ; changements rapides annoncés comme immédiatement enregistrés ; changement de provider réinitialisant le modèle ; recherche de skills ; groupes fieldset ; champs MCP/subagents nommés ; lignes incomplètes signalées ; transport URL/commande distingué ; persistance avant validation annoncée honnêtement |
| Providers | Chargement/erreur/reprise ; état de sauvegarde ; prévention des soumissions répétées ; indications d’authentification |
| Cron | Chargement/erreur/reprise ; checkbox d’activation nommée ; état de sauvegarde ; choix workspace/agent vérifié ; distinction fuseau serveur / affichage navigateur ; historique défilable |
| Settings | Chargement explicite ; conservation du brouillon JSON et erreur de parsing déjà présents |
| WorkspacePage | Onglets au clavier et panneaux associés ; conversations ouvertes par boutons natifs ; chargement limité aux dépendances de l’onglet choisi ; reprise ; erreur explicite si Chef de Projet absent |
| Board | Chargement distinct d’un tableau vide ; reprise/actualisation ; détail réconcilié après modification ; garde des requêtes ; lancement désactivé tant que la carte est modifiée sans sauvegarde |
| FileViews | Réponses obsolètes ignorées ; chargement/erreur/reprise ; état ouvert des dossiers exposé ; classes W/E cohérentes avec les styles |
| FeedList / Markdown | Dates séparées par année ; titres et listes sémantiques ; protocoles des liens contrôlés |
| Shell / UI / CSS | Navigation Workspaces reste active dans son détail ; agents actualisés à l’ouverture ; focus du menu restauré ; chargement partagé annoncé ; flex chat borné ; cartes mobiles sans largeur minimale débordante ; cibles mobiles conservées à 44 px ; contraste primaire au survol corrigé |

## Constats consolidés

| Sévérité initiale | Domaine | Location actuelle | Avant | Après | Pourquoi |
| --- | --- | --- | --- | --- | --- |
| P0 | Layout | `web/src/styles.css:322`, `:603` | Composer à environ 12 688 px dans un historique mobile chargé | Transcript borné, composer visible ; chaîne flex également corrigée dans le chat workspace | Permet de lire et d’envoyer sur mobile |
| P1 | Récupération | `web/src/screens/Conversations.tsx:382` | Brouillon/images supprimés avant succès | Conservation en cas d’échec, nettoyage limité au contenu soumis après succès | Évite la perte de travail et respecte les nouvelles saisies |
| P1 | Récupération | `web/src/screens/Conversations.tsx:284` | Une reprise réussie pouvait laisser l’ancien historique absent | Hydratation suivie indépendamment du contenu live, fusion et rebasage des indices | Récupère l’historique sans supprimer les événements live |
| P1 | Accessibilité | `web/src/WorkspacePage.tsx:170`, `:195`, `:259` | Tabs incomplets et cartes click-only | Flèches/Home/End, focus roving, panneaux associés, boutons natifs | Parcours clavier prévisible |
| P1 | Colors | `web/src/styles.css:14` | Blanc sur hover primaire : 3,85:1 | `#606cd0` : 4,61:1 ; token séparé pour texte accentué | Conformité du petit texte au survol |
| P1 | État / confiance | `web/src/Board.tsx:219`, `:393` | Lancement possible depuis un brouillon non enregistré | Explication et lancement désactivé tant que la carte est dirty | Configuration exécutée identifiable |
| P1 | État / confiance | `web/src/WorkspacePage.tsx:57` | Lectures groupées susceptibles de propager une erreur entre onglets | Dépendances limitées à l’onglet sélectionné et erreurs isolées | Une panne Board ne masque pas Feed ou Conversations |
| P2 | État / confiance | `web/src/screens/Workspaces.tsx:32` | Une réponse tardive pouvait afficher le feed d’un autre workspace | Génération de requête invalidée au changement et à la fermeture | Empêche les données croisées |
| P2 | Writing / prévention | `web/src/screens/Agents.tsx:244`, `:268` | Lignes incomplètes supprimées silencieusement ; issue de validation ambiguë | Erreurs explicites ; résultat sauvegardé/appliqué/validé distingué ; ID créé conservé | Pas de faux échec ni recréation après validation indisponible |
| P2 | Layout / reconnaissance | `web/src/screens/Agents.tsx:328` | Catalogue de 134 skills sans recherche | Recherche par nom/description et groupes sémantiques | Réduit le coût de sélection |

## Vérification

Dernier passage complet des vérifications applicatives :

- `npm run typecheck` : réussi.
- `npm run build:web` : réussi.
- `npm test` : **69/69 réussis sur deux passages complets consécutifs**.
- `scripts/ui-smoke.mjs` : focus/saisie/Échap de la modale, JSON invalide conservé, menu mobile inert et fermé par Échap.
- `scripts/ui-regression.mjs` : huit groupes de contrôles navigateur, dont historique long à 320 px, brouillon après échec, tabs/panneaux au clavier, lancement Board après sauvegarde, chat PM intégré visible, contraste hover, erreur d’historique et réponse feed tardive.
- `scripts/ui-stream-recovery.mjs` : deux parcours navigateur à 320 px, historique initial indisponible puis récupération d’une réponse assistant plus courte ou plus longue que le texte live ; une seule bulle conservée et delta suivant appliqué à cette même bulle.
- `test/m5.test.ts` : **9/9 sur cinq répétitions consécutives**, avec reprise de session, historique de même seconde et garde contre un ancien run encore actif.

Les scripts navigateur utilisent un Chrome headless isolé, le Puppeteer fourni par browser-tools et aucun ajout au package applicatif. Le smoke bloque les mutations ; le regression intercepte toutes les API et simule l’échec d’envoi, sans écriture backend réelle.

```bash
BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-smoke.mjs
BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-regression.mjs
BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-stream-recovery.mjs
```

Prérequis : Vite sur `:5321`, Chrome installé. `CHROME_PATH` permet de remplacer le chemin macOS par défaut.

Les six pages ont également été inspectées avec données locales et captures à 320 px, sans débordement global observé. Captures temporaires : `/tmp/cogitator-final-*.png`. Cela ne vaut pas certification de tous les états.

## Revue indépendante et limites

Les blocages signalés pendant la revue (propagation des erreurs entre onglets et récupération d’historique) sont corrigés et couverts par des régressions. Les deux réserves de clôture sont également résolues :

- **Assistant partiellement streamé** : le chevauchement reconnaît un préfixe plus court ou plus long uniquement pour la bulle assistant active. Le texte live est conservé, puis les deltas suivants continuent à cibler la bonne bulle. Le scénario échouait avant correction ; tests de composant et navigateur réussissent après correction.
- **Cron intermittent** : le faux client de test créait toujours une nouvelle session même avec `--session`. Le tri limité à la seconde masquait parfois cette erreur en renvoyant le premier run. Le mock respecte désormais la reprise et le test vérifie toutes les sessions, pas seulement la première ligne. Le code partagé `src/cron.ts` départage les timestamps égaux par `rowid DESC` pour l’historique et la dernière session. La recherche d’un run concurrent exclut le run courant, afin qu’un ancien run actif ne soit pas masqué. Trois scénarios échouaient de façon déterministe avant correction et réussissent maintenant.

Ces changements cron sont ciblés : aucun changement de schéma ni migration. La fusion du chat reste fondée sur l’ordre et le texte, sans inventer des identifiants absents du contrat actuel.

**Revue indépendante finale des corrections de réserve : Approve**, sans constat bloquant. Les réserves identifiées dans cette passe sont clôturées. Capture du scénario de reprise mobile : `/tmp/cogitator-stream-recovered.png` (API et événements simulés, interface réelle).

Non vérifiés : lecteur d’écran réel, zoom natif 200 %, matériel tactile, tous les providers/protocoles et tous les états réseau/streaming réels. Les contrôles automatisés ne prouvent ni une accessibilité exhaustive ni une qualité visuelle parfaite.
