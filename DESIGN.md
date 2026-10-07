# Design System — Cogitator

Style: **Linear-grade app shell** (sidebar + lists + chat). Canvas near-black, indigo accent, Inter. Motion: animations.dev (explicit transitions, ease-out, reduced-motion variants).

## Colors

| Token | Value | Role |
|---|---|---|
| `--bg` | `#08090a` | Canvas |
| `--surface` | `#0f1011` | Sidebar, lists, cards |
| `--raised` | `#1a1b1e` | Hover, inputs, selection |
| `--popover` | `#1c1d1f` | Modals, toasts |
| `--fg` | `#f7f8f8` | Body / titles |
| `--muted` | `#8a8f98` | Secondary text (≥4.5:1) |
| `--subtle` | `#80858d` | Meta, placeholders (≥4.5:1 on raised) |
| `--border` | `#1f2023` | Structure |
| `--border-strong` | `#2c2e33` | Hover / strong edge |
| `--accent` | `#5e6ad2` | Primary action, selection, user bubble |
| `--accent-hover` | `#606cd0` | Primary hover (white text ≥4.5:1) |
| `--accent-text` | `#8792ed` | Links / accent text on dark surfaces |
| `--todo` | `#e2a336` | Warning / pending |
| `--progress` | `#f2994a` | In progress |
| `--urgent` | `#eb5757` | Danger / error |
| `--success` | `#4cb782` | Success / ready |

Accent is for primary actions, current nav, and state indicators. Never as decoration. Status lives in a colored glyph plus a text label, never color alone.

## Typography

Inter 400 / 500 / 600, self-hosted. One family. Fixed rem scale, not fluid.

| Role | Size | Weight |
|---|---|---|
| Page title | 18px | 600, tracking -0.01em |
| Section | 14px | 600 |
| Body / controls | 13px | 400–500 |
| Meta / labels | 12px | 500 |
| Mono (ids, paths) | 12px | SFMono / ui-monospace |

## Layout

Sidebar 220px + main. Spacing scale: 4 / 8 / 12 / 16 / 24. Radius 6px chrome, 8px popovers. Shadows only on popovers. Break at 768px: sidebar becomes a drawer.

## Components

- **Nav**: instant, no motion. `aria-current`. SVG icons, 16px, stroke 1.75.
- **Buttons**: hairline or solid accent. Press `scale(0.97)` 150ms. Hover is color only.
- **Lists**: default for collections. Cards only for workspace units that carry nested fields.
- **Badge**: chip with a colored dot, never a filled pill.
- **Modal**: dialog semantics, Escape, focus trap, restore. Enter `scale(0.97)+fade` 180ms.
- **Empty**: title + one sentence + the primary action.
- **Toast**: live region, dismissible, no side stripe.

## Motion

| Interaction | Treatment |
|---|---|
| Nav, keyboard | Instant |
| Hover color | 100ms `ease` |
| Button press | 150ms `--ease-out-quad`, scale 0.97 |
| Modal / toast / panel | 180–220ms `--ease-out-expo`, transform+opacity |
| Chat message | 200ms fade + 6px rise |
| Running tool | opacity pulse, linear |

`prefers-reduced-motion: reduce` keeps opacity, drops movement. Hover scale gated on `(hover: hover) and (pointer: fine)`.

## Theme

Dark only in v1. Cogitator is a local control tool.
