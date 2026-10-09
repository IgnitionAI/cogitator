# Design — Cogitator UI

Applied style: **Linear** (`use-style`) — app shell (sidebar + lists + chat), near-black canvas, indigo accent.
Motion: **animations.dev** (`animate`) — explicit 100 ms transitions on base states, 180-220 ms ease-out entrances, `prefers-reduced-motion` respected.

## Tokens

| Role | Value |
|---|---|
| Canvas | `#08090a` |
| Surface (sidebar, cards) | `#0f1011` |
| Raised (hover, inputs, selection) | `#1a1b1e` |
| Popover (modals, toasts) | `#1c1d1f` + shadow `0 8px 24px rgba(0,0,0,.5)` (the only shadow) |
| Ink / muted / subtle | `#f7f8f8` / `#8a8f98` / `#80858d` |
| Borders | `#1f2023` (structure), `#2c2e33` (hover/focus) |
| Accent | `#5e6ad2` (hover `#606cd0`) — active, focus, user bubble; links/accented text `#8792ed` |
| Statuses (glyphs) | todo `#e2a336` · progress `#f2994a` · done `#5e6ad2` · urgent `#eb5757` · success `#4cb782` |

Typography: Inter 400/500/600 (@fontsource, self-hosted) — headings at 600 with `letter-spacing: -0.01em`; mono (SFMono) reserved for IDs/paths.

## Decisions

- **Badge = chip with a colored dot**, never a fill (a Linear anti-pattern).
- 6px radius throughout, 8px for popovers; no shadows on structural elements (lines only).
- Chat: indigo user bubble (primary action), assistant surface + hairline, tools in mono chips, subtle status line.
- Entrances: messages `fade + translateY(6px)` 200ms ease-out-expo; modal `scale(.97)+fade` 180ms; toast slides in from the right. Transitions on base states (never only `:hover`), explicit properties (no `all`).
- What does not animate: sidebar navigation (high frequency → instant), row hover (`transition-colors` 100ms only).
- Single theme (dark) — recorded decision: Cogitator is a local control tool, with no light variant in v1.
