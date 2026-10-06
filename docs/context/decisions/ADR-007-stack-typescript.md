# ADR-007 — TypeScript fullstack, RpcClient officiel, SSE, packaging pi package

- Statut : accepté
- Date : 2026-10-06

## Contexte

Choix de stack pour : serveur Node local, UI web temps réel, communication avec pi, distribution.

## Décision

| Couche | Choix | Justification |
|---|---|---|
| Langage | TypeScript partout | `RpcClient` officiel de pi en TS = zéro glue ; team de 1 |
| Serveur | Node ≥22, HTTP natif (pas de framework lourd) | Même runtime que l'extension pi ; SSE trivial |
| UI | React + Vite (build statique servi par le serveur) | Écosystème, itération rapide |
| Temps réel | SSE (Server-Sent Events) | Modèle éprouvé (pi-web-simple) : streaming tokens pi → navigateur |
| Persistance | SQLite (ADR-006) | — |
| Distribution | **pi package** : `pi install npm:@ignitionai/cogitator`, commande `/cogitator` qui démarre le serveur détaché ; bin standalone `npx @ignitionai/cogitator` | La cible d'usage est l'écosystème pi |

## Empreinte packaging (validée contre docs/packages.md de pi 1.0.4)

- Manifeste `pi` explicite : `"pi": { "extensions": ["./extensions"] }` + keyword `pi-package` (visibilité galerie pi.dev/packages)
- **`@earendil-works/pi-coding-agent` en `peerDependencies: "*"`** — fourni par l'hôte pi, jamais en `dependencies` (sinon warning + classes dupliquées : c'était le défaut de pi-web-simple)
- `bin` autorisé : `cogitator` démarre le serveur standalone ; la commande `/cogitator` (via `pi.registerCommand()`) spawn le serveur **détaché** — l'entry de l'extension reste minimale (I4)
- better-sqlite3 en `dependencies` : pi installe les dépendances du paquet lors de `pi install`
- Install cible : `pi install npm:@ignitionai/cogitator` (pin de version supporté : `@x.y.z`)

## Conséquences

+ Une seul langage, réutilisation directe de l'API pi, packaging natif pour les utilisateurs pi
− Extension pi chargée dans chaque session pi : l'entry doit rester minimal (enregistrer `/cogitator`, pas démarrer de serveur dans le process hôte)

## Alternatives rejetées

- Python/FastAPI → glue avec le RpcClient TS, deux langages
- WebSocket → surdimensionné ; le flux est essentiellement serveur → client
