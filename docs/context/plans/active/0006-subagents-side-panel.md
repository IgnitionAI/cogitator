# Live subagents side panel (herdr enumeration)

## Request and decisions

User request: voir, dans un panneau latéral de l'écran conversation, les subagents herdr actifs d'une conversation. Décisions tranchées dans ADR-012 : le serveur lit l'état live via `herdr api snapshot` (socket herdr, shell-out, timeout court) ; le mapping pane → conversation se fait côté serveur par identité de session (`conversation.session_file`) ; dégradation gracieuse `live: false` ; v1 lecture seule ; polling UI, pas de SSE ; aucune nouvelle dépendance. Aucun déploiement.

Scope : conversations classic et membres de groupe (même mécanisme, une conversation à la fois). Hors scope : actions sur les panes (focus/kill/input), subagents spawnés hors herdr, panes d'autres origines que pi, cron (même endpoint réutilisable plus tard).

## Implementation

1. **Spike live (bloquant pour la règle de liaison uniquement)** : démarrer le démon herdr, lancer pi avec `--session <fichier>` comme le fait le pool, spawner un subagent via l'extension herdr, capturer `herdr api snapshot`. Déterminer quel champ de `agent_session` (`source` vs répertoire de `value` en `kind: "path"`) relie le pane enfant à la session parente. Figer la preuve (JSON d'exemple) dans `docs/proof/`. Mettre à jour `linkBelongsToConversation()` dans `src/subagents.ts` si la réalité diffère de l'hypothèse L1 (`source`).
2. `src/subagents.ts` :
   - `fetchHerdrSnapshot(runner)` — shell-out `herdr api snapshot`, timeout 3 s, parse JSON ; `null` sur toute erreur (daemon absent, JSON invalide).
   - `linkBelongsToConversation(pane, sessionFile)` — règle de liaison unique, isolée (résultat du spike).
   - `subagentsForConversation(snapshot, sessionFile)` — pur : filtre + projection `{ pane_id, label, agent, status, session }` ; status ∈ `idle|working|blocked|done` (`unknown` passé tel quel).
   - `listSubagents(sessionFile, runner)` — glue : snapshot nul → `{ live: false, subagents: [] }`.
3. Route `GET /api/conversations/:id/subagents` dans `conversationRoutes` : 404 si conversation absente ; sinon `200 { live, subagents }`. Runner injectable via `Deps` pour les tests (pattern du validateur d'agent).
4. UI : panneau `SubagentsPanel` dans `Conversations.tsx`, bascule à côté du panneau Fichiers (même pattern `filesPanel`), poll 3 s tant que le panneau est ouvert, arrêté à la fermeture. Locales fr/en, types, rendu accessible (liste + statut textuel), mobile ok.
5. Tests `test/subagents.test.ts` : mapping pur (snapshot factice : liés/non liés, sans `agent_session`, statuts), route (404, `live: false` si runner en échec, aucune fuite inter-conversations par `session_file` différente). Mock identifié comme mock — la preuve live reste le spike.
6. Vérifications : `npx tsx --test test/subagents.test.ts`, `npx tsc --noEmit`, `npm test`, build web.

## Shared API contract

- `GET /api/conversations/:id/subagents`
- `200` : `{ live: boolean, subagents: Array<{ pane_id: string, label: string | null, agent: string | null, status: "idle" | "working" | "blocked" | "done" | "unknown", session: string | null }> }`
- `live: false` ⇔ herdr injoignable ou snapshot invalide ; `subagents` toujours un tableau.
- `404` conversation inconnue. Jamais de 5xx pour une cause herdr.
- Lecture seule : aucune méthode d'écriture dans ce périmètre.

## Acceptance and verification

A1. Spike : le champ de liaison réel est identifié, preuve JSON conservée, `linkBelongsToConversation()` correspond à la réalité observée.
A2. Route : conversation sans `session_file` → `{ live: <selon herdr>, subagents: [] }` ; runner en échec → `live: false` ; deux conversations ne voient jamais les subagents l'une de l'autre.
A3. UI : le panneau liste label + statut, se rafraîchit tant qu'il est ouvert, se ferme proprement, FR/EN, aucune régression mobile.
A4. `npx tsc --noEmit`, `npm test` et build web passent (hors fichiers sales d'autres exécutants signalés à part).

## Review and repository boundaries

Ne pas modifier/stager `cogitator.board.json` ni `.bak`. Pas de push. `src/server.ts` est sujet à éditions concurrentes : garder le diff minimal et localisé. La règle de liaison est la seule partie conditionnée au spike ; tout le reste est implémentable et testable sans daemon herdr.
