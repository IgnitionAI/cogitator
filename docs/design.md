# Design — Cogitator UI

Style appliqué : **Linear** (`use-style`) — app shell (sidebar + listes + chat), canvas near-black, accent indigo.
Motion : **animations.dev** (`animate`) — transitions explicites 100 ms sur les états de base, entrées ease-out 180-220 ms, `prefers-reduced-motion` respecté.

## Tokens

| Rôle | Valeur |
|---|---|
| Canvas | `#08090a` |
| Surface (sidebar, cartes) | `#0f1011` |
| Raised (hover, inputs, sélection) | `#1a1b1e` |
| Popover (modales, toasts) | `#1c1d1f` + ombre `0 8px 24px rgba(0,0,0,.5)` (seule ombre) |
| Encre / mutée / subtile | `#f7f8f8` / `#8a8f98` / `#80858d` |
| Bordures | `#1f2023` (structure), `#2c2e33` (hover/focus) |
| Accent | `#5e6ad2` (hover `#6e79de`) — actif, liens, focus, bulle utilisateur |
| Statuts (glyphes) | todo `#e2a336` · progress `#f2994a` · done `#5e6ad2` · urgent `#eb5757` · success `#4cb782` |

Typo : Inter 400/500/600 (@fontsource, self-hosted) — titres 600 avec `letter-spacing: -0.01em` ; mono (SFMono) réservé aux IDs/chemins.

## Décisions

- **Badge = chip à point coloré**, jamais de remplissage (anti-pattern Linear).
- Radius 6px partout, 8px popovers ; aucune ombre sur la structure (lignes uniquement).
- Chat : bulle user indigo (action primaire), assistant surface + hairline, outils en chips mono, ligne de statut subtile.
- Entrées : messages `fade + translateY(6px)` 200ms ease-out-expo ; modale `scale(.97)+fade` 180ms ; toast slide-in droite. Transitions sur les états de base (jamais `:hover` seul), propriétés explicites (pas de `all`).
- Ce qui n'anime pas : la nav sidebar (fréquence élevée → instantané), le survol de lignes (`transition-colors` 100ms uniquement).
- Thème unique (dark) — choix enregistré : Cogitator est un outil local de contrôle, pas de variante light en v1.
