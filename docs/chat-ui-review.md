# Revue consolidée — chat enrichi et UI générative

## Périmètre et couverture

Conversations principales et chat « Chef de projet » des workspaces. React 19, TypeScript, CSS natif et tokens existants ; thème sombre, Inter, accent indigo. Références : `PRODUCT.md`, `DESIGN.md`, `docs/context/decisions/ARCHITECTURE_CONTRACT.md`, `docs/chat-generative-ui.md` et les six guides du skill `better`.

La revue porte sur le rendu réellement observé dans Chrome, complété par les sources et les tests. Les appels API des parcours navigateur sont interceptés : aucune conversation, commande ou donnée utilisateur réelle n'a été créée par ces scénarios. Les limites de lecture historique et d'identification des messages sont explicitées dans le document du contrat.

| Domaine | Preuves inspectées | Résultat |
| --- | --- | --- |
| Accessibility | Contrôles natifs/labels/fieldset dans `web/src/GenerativeUI.tsx:43`, focus erreur/succès à `:75`, ordre de tabulation du composeur, tableaux défilants, en-tête unique du workspace, mouvement réduit | Clear après corrections ; lecteur d'écran réel non testé |
| Layout | Captures 1440/768/390/320 px, chat embarqué, viewport 720 × 450 ; mesures de débordement et de visibilité du composeur ; `web/src/chat.css:12`, `:68`, `:167` | Clear après corrections |
| Writing | États français, erreurs récupérables, avertissement sur les secrets, distinction transmission/exécution, libellés d'outils et interface invalide ; `web/src/GenerativeUI.tsx:66`, `src/generative-ui.ts:67` | Clear |
| Typography | Hiérarchie inspectée sur captures, colonne de lecture 760 px, prose 75ch, code monospace, saisie mobile 16 px ; `web/src/chat.css:16`, `:32`, `web/src/markdown.tsx:106` | Clear |
| Colors | Contrastes mesurés sur tokens réellement chargés ; sélection radio native + bordure, états texte + icône ; `web/src/chat.css:94`, `web/src/ToolResult.tsx:54` | Clear |
| UI | Formulaire/choix/checklist/tableau, copie de code, outils, chargement/erreur/retry/résumé, source invalide, historique, coupures SSE ; scripts et tests ci-dessous | Clear sur les scénarios contrôlés |

## Constats corrigés

Tous les constats ci-dessous sont **résolus** dans cette passe. Ils documentent les causes observées et leurs corrections, pas du travail restant.

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| MEDIUM | UI | `web/src/screens/Conversations.tsx:132`, `:339`, `:386` | Une coupure pouvait conserver un résultat partiel, un formulaire désactivé ou une clôture JSON manquante ; la première hydratation pouvait dupliquer une réponse en insérant le raisonnement | Relecture chronologique, outils associés par ID, état réel `isStreaming`, réparation des trous testés et clés locales stables | Une reconnexion doit rétablir l'état exploitable et préserver une saisie existante |
| MEDIUM | UI | `web/src/GenerativeUI.tsx:122` | Un bloc non clôturé restait en préparation après interruption/rechargement | Préparation seulement pendant le streaming ; sinon erreur lisible, source et demande de correction | Un état d'attente doit avoir une sortie en cas d'échec |
| MEDIUM | Accessibility | `web/src/GenerativeUI.tsx:75`, `web/src/screens/Conversations.tsx:614` | Remplacer le formulaire pouvait perdre le focus ; ordre DOM du composeur différent de l'ordre visuel | Focus explicite sur erreur/résumé ; saisie puis outils puis envoi | Le clavier doit conserver un point de reprise prévisible |
| MEDIUM | Layout | `web/src/chat.css:13`, `:68` | Des outils pouvaient être comprimés en une ligne vide ; le bouton de retour aux derniers messages recouvrait une action | Enfants du fil non compressibles ; bouton dans le flux normal, hors de la zone de défilement | Les contenus techniques et les actions doivent rester visibles et atteignables |
| MEDIUM | Layout | `web/src/chat.css:2`, `:167` | Une petite hauteur laissait trop peu de place au fil ; le défilement du workspace pouvait déplacer la page derrière la barre supérieure | Chrome compact en faible hauteur, défilement interne borné, hauteur minimale du chat embarqué | Le reflow doit conserver un fil lisible, le titre et le composeur sans recouvrement |
| LOW | Typography | `web/src/markdown.tsx:106`, `web/src/chat.css:32` | Une réponse débutant par `##` sautait directement à un petit niveau de titre ; prose trop large | Premier titre rendu au niveau de section et prose limitée à 75ch | Hiérarchie et longueur de ligne facilitent la lecture des réponses longues |

Aucun constat d'interface actionnable restant dans le périmètre contrôlé.

## Vérification

### Réussie

- `npm run build` : typechecks web/serveur, bundle Vite et compilation serveur.
- `npm test` : **92 tests, 92 réussis**. Schémas stricts, limites, contenu inerte, réponses corrélées, snapshots figés, lecture JSONL, outils, récupération de texte et absence de duplication dans les cas ajoutés.
- `BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-generative.mjs` :
  - bouton dédié supprimé du composeur ; capacité automatique vérifiée côté spawner pour les nouvelles et anciennes sessions, sans réécriture de snapshot ni message synthétique ;
  - quatre composants à 1440, 768, 390 et 320 px ; aucun débordement de page ; outils non écrasés ; composeur visible ;
  - échec 503, valeurs conservées, nouvelle tentative, focus sur l'erreur puis sur le résumé ; brouillon du composeur intact ;
  - formulaires, choix et checklists relus après rechargement ; filtrage et tri de tableau sans envoi ;
  - UI partielle non interactive, activation après fin de génération, contenu utilisateur jamais interprété comme une interface, HTML arbitraire refusé ;
  - reconnexion avec clôture, résultat d'outil et `agent_end` manqués ; réponse utilisateur d'un autre client récupérée ; saisie maintenue malgré l'insertion de raisonnement ;
  - chat embarqué à 1440/390/320 px et 720 × 450 px ; un seul h1 de page ; titre non masqué par la barre d'application ;
  - aucune erreur JavaScript ; quatre requêtes de soumission simulées, aucune envoyée au backend réel.
- `BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-stream-recovery.mjs` : récupération après échec initial de l'historique, snapshot plus court ou plus long que le flux ; pas de doublon et prochain delta dans la bonne bulle.
- `BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-polish.mjs` : six pages, sept onglets workspace, drawer, dialogs, états vides/erreur et clavier ; aucune erreur JavaScript.
- `BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-regression.mjs` : fil long mobile, saisie, échec d'envoi, historique indisponible, navigation workspace et chat embarqué.
- Contrastes mesurés : texte secondaire/surface **5,86:1**, métadonnées/surface **5,13:1**, blanc/accent **4,70:1**, bordure de contrôle/fond **3,08:1**.
- Captures inspectées dans `/tmp/cogitator-generative/`, notamment `conversation-1440.png`, `choices-390.png`, `form-1440.png`, `form-error-320.png`, `table-320.png`, `workspace-320.png`, `tool-error.png`, `zoom-200.png`, `workspace-zoom-200.png`.

### Not verified

- Génération par un modèle réel et pertinence des composants qu'il choisirait : fixtures navigateur et clients pi factices uniquement.
- VoiceOver/NVDA, Safari/Firefox et appareil mobile physique/clavier virtuel.
- Zoom navigateur natif : le test utilise un viewport CSS de 720 × 450, équivalent au reflow à 200 % d'un écran de 1440 × 900.
- Toutes les ambiguïtés de rapprochement de messages sans identifiants autoritatifs, les transcriptions dépassant la fenêtre historique et les sorties de modèles arbitraires.

## Verdict

**Approve** — pour la couverture déclarée et les scénarios reproductibles ci-dessus. Aucun constat HIGH restant. Ce verdict ne certifie ni le comportement d'un modèle réel ni les environnements non testés.
