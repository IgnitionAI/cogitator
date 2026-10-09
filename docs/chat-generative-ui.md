# Chat enrichi et UI générative

## Périmètre validé

Les conversations principales et le chat de workspace reçoivent le même rendu. Le propriétaire a confirmé les deux volets : enrichissement automatique des messages/outils et composants interactifs proposés par les agents. L'identité sombre, dense et française reste inchangée.

Objectifs : lecture confortable, détails techniques consultables, saisie compacte, réponses interactives conservées dans l'historique. Usage local, sans service externe. Aucun HTML, JavaScript ou style arbitraire provenant du modèle n'est exécuté. Une soumission transmet un message à l'agent, elle ne constitue jamais une autorisation d'exécuter une commande ou une opération destructive.

## Décisions

| Choix | Alternatives écartées | Raison |
| --- | --- | --- |
| Catalogue React fini, JSON validé avec Zod déjà installé | SDK génératif externe ; exécution de JSX/HTML généré | Indépendance des fournisseurs, surface de sécurité bornée, maintenance locale |
| Blocs `cogitator-ui` dans le texte assistant | Nouveau transport SSE et seconde base d'historique | Réutiliser le streaming et les JSONL pi, source de vérité existante |
| Réponses dans des messages utilisateur `cogitator-response` | État exclusivement local ou transcript dans SQLite | Relecture des soumissions après rechargement, respect de I5 |
| Copie du contrat de rendu dans le snapshot des nouvelles conversations | Modification rétroactive des presets/sessions | Respect du snapshot O6 ; le spawner complète à l’exécution les anciennes sessions dépourvues de contrat, sans modifier leurs données figées |
| Styles CSS et composants natifs | Nouvelle librairie de composants ou d'animation | Réutiliser les tokens, focus, contrôles et conventions existants |

## Choix automatique du format

L’agent choisit spontanément le format utile, sans bouton dédié : texte par défaut, formulaire/choix pour des informations structurées, checklist pour une sélection multiple, tableau pour une comparaison. Il doit accepter une réponse en texte libre et ne pas imposer un composant. Seule la présentation est automatique ; une soumission exige toujours une action explicite.

Le spawner commun aux conversations et aux tâches planifiées transmet cette politique dans le contexte système à chaque démarrage/reprise. Il conserve le contrat figé s’il existe et fournit le contrat v1 aux anciennes sessions qui n’en ont pas. Aucun message utilisateur artificiel, appel de modèle préalable ou changement de preset n’est nécessaire. Après mise à jour du serveur, les processus sont recréés paresseusement au prochain envoi avec le même fichier de session.

## Contrat v1

Un bloc clôturé `cogitator-ui` contient un objet strict : `version: 1`, `id` unique à l'étape, `kind`, `title`, `description` optionnelle.

- `form` : `fields` (id, label, type text/textarea/number/select, required optionnel ; options pour select), `submitLabel` optionnel.
- `choices` : `options` (id, label, description optionnelle), `submitLabel` optionnel. Une sélection.
- `checklist` : `items` (id, label, description optionnelle), `submitLabel` optionnel. Plusieurs sélections, dont aucune si approprié.
- `table` : `columns` (id, label), `rows` (valeurs scalaires par colonne). Filtre et tri locaux ; aucune écriture.

Les limites de taille, nombre de champs, options et lignes sont validées à l'entrée. Seuls les messages assistant peuvent déclencher ce rendu. Un bloc incomplet pendant le streaming affiche une préparation non interactive. Un bloc resté incomplet après interruption ou rechargement passe en erreur avec une demande de correction. Un bloc invalide garde son texte source consultable et propose de demander une correction. Les blocs de code ordinaires ne sont jamais interprétés comme une interface.

Une réponse contient `version: 1`, `request` (la spécification validée exacte) et `values` (valeurs validées contre cette spécification). Cette référence complète évite une corrélation fragile par position dans la timeline ou un ID réutilisé. Elle est bornée par les limites du schéma. Le libellé humain accompagne le bloc JSON ; dans le chat il s'affiche comme un récapitulatif. Le serveur reçoit un message utilisateur normal. Pas de nouvelle permission, commande, URL d'action ou secret à saisir dans une interface générée.

Les contrôles sont désactivés pendant l'envoi et le travail de l'agent. Une reconnexion relit l'état `isStreaming` du processus pi via le pool et l'historique JSONL ; un processus vivant n'est pas nécessairement en train de produire une réponse. Les clés locales des messages restent stables quand la relecture insère du raisonnement, afin de ne pas réinitialiser les formulaires. L'échec reste inline, conserve les valeurs et permet de réessayer. Après succès, le récapitulatif est en lecture seule. Le texte saisi dans le composeur n'est pas remplacé par une réponse de formulaire. Les réponses ne sont considérées comme présentes que lorsqu'elles figurent dans les messages utilisateur, jamais dans un résultat d'outil ou un message assistant.

## Composition visuelle

- En-tête compact : titre, fournisseur/modèle, état compréhensible, accès aux fichiers et actions secondaires.
- Colonne de lecture centrée, réponses sur le fond du chat, utilisateur dans une surface discrète. Pas de carte autour de chaque paragraphe.
- Métadonnées et activité secondaires ; raisonnement et arguments bruts restent repliables.
- Code avec langage et copie ; tableaux à défilement explicite ; outils avec état textuel, résumé et résultat adapté (texte, JSON, diff).
- UI générative comme une section de réponse : titre et contexte, contrôles natifs, validation, action de transmission et récapitulatif.
- Composeur à deux niveaux : texte, puis pièces jointes/skills et envoi. Raccourcis hors du placeholder. Retour au dernier message quand le lecteur remonte le fil.
- Animations réservées au feedback ; aucune animation d'entrée répétée sur l'historique rechargé. Mouvement réduit respecté.

## Vérification et limites

`npm run build` et les 92 tests passent. `scripts/ui-generative.mjs` vérifie les quatre composants, le refus d'HTML arbitraire, les sorties interrompues, l'échec puis la nouvelle tentative, le focus, le rechargement, les événements manqués et la conservation d'un formulaire pendant une insertion d'historique. Chrome a été testé à 1440, 768, 390 et 320 px, ainsi qu'à 720 × 450 px (viewport CSS équivalent à un zoom de 200 % sur 1440 × 900). Toutes les requêtes API de ces scénarios sont interceptées. Rapport consolidé : `docs/chat-ui-review.md`.

Limites explicites : JSON d'interface de 64 Kio maximum, enveloppe JSON de réponse de 128 Kio, 20 champs/colonnes, 50 choix, 200 lignes. La relecture garde la fenêtre existante de 300 entrées sur les 2000 dernières lignes JSONL ; elle ne charge pas un transcript arbitrairement ancien. Les résultats d'outils historiques restent soumis au plafond serveur existant de 4000 caractères, signalé par « tronqué ». Les diffs affichent la modification demandée, pas une preuve d'écriture. Les valeurs non transmises survivent aux échecs et aux réconciliations testées, mais pas au rechargement de la page. Les soumissions transmises, elles, sont persistées par pi.

La réconciliation textuelle reste une correspondance chronologique dans cette fenêtre bornée : elle ne remplace pas des identifiants de message autoritatifs. Les scripts couvrent les scénarios d'événements manqués décrits dans le rapport, pas toutes les ambiguïtés possibles de messages textuels identiques. Aucun test avec un fournisseur de modèle réel, VoiceOver ou un appareil mobile physique n'a été effectué dans cette passe.

La génération dépend de l'agent : une instruction documentée n'est pas une garantie de conformité du modèle. Le texte brut et les erreurs de validation restent accessibles. Les snapshots et transcriptions des anciennes sessions ne sont pas réécrits ; seule la capacité de présentation du contexte système est complétée à la reprise. Pas de migration de transcript, pas de dashboard arbitraire ni d'exécution d'artefacts.
