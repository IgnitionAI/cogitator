# Cogitator: Impeccable UI/UX pass

## Scope

The six main pages and frontend components underwent two independent assessments (design and technical evidence), followed by corrections. The dark identity, Inter, existing tokens, and native CSS are preserved. No application dependency was added.

The corrections prioritize flows and states, not decoration. Key decisions: preserve drafts, keep the composer visible, use native controls, distinguish loading/error/empty states, and require a saved card before launch.

## Coverage

| Surface | Corrections / review |
| --- | --- |
| Conversations / Chat | Draft and images preserved on failure; guard against repeated sends; IME composition; interruption of a reopened active session; follow the stream only when near the bottom; visible reconnection; history error/retry states; named disclosures |
| Workspaces | Loading/error/retry; keyboard folder selection; parent navigation and explicit opening; stale feed responses ignored |
| Agents | Loading/error/retry; quick changes announced as immediately saved; provider changes reset the model; skill search; fieldset groups; named MCP/subagent fields; incomplete rows flagged; URL/command transport distinguished; persistence before validation communicated honestly |
| Providers | Loading/error/retry; save status; prevention of repeated submissions; authentication guidance |
| Cron | Loading/error/retry; named activation checkbox; save status; workspace/agent selection checked; distinction between server time zone and browser display; scrollable history |
| Settings | Explicit loading; JSON draft preservation and parsing error already present |
| WorkspacePage | Keyboard tabs and associated panels; conversations opened with native buttons; loading limited to the selected tab's dependencies; retry; explicit error if “Chef de Projet” (project manager) is absent |
| Board | Loading distinguished from an empty board; retry/refresh; detail reconciled after modification; request guards; launch disabled while the card has unsaved changes |
| FileViews | Stale responses ignored; loading/error/retry; folders' open state exposed; W/E classes consistent with styles |
| FeedList / Markdown | Dates separated by year; semantic headings and lists; link protocols checked |
| Shell / UI / CSS | Workspaces navigation remains active in its detail view; agents refreshed on opening; menu focus restored; shared loading announced; bounded chat flex layout; mobile cards without overflowing minimum widths; mobile targets kept at 44 px; primary hover contrast corrected |

## Consolidated findings

| Initial severity | Domain | Current location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| P0 | Layout | `web/src/styles.css:322`, `:603` | Composer at approximately 12,688 px in loaded mobile history | Bounded transcript, visible composer; flex chain also corrected in workspace chat | Enables reading and sending on mobile |
| P1 | Recovery | `web/src/screens/Conversations.tsx:382` | Draft/images deleted before success | Preserved on failure, cleanup limited to submitted content after success | Prevents lost work and respects new input |
| P1 | Recovery | `web/src/screens/Conversations.tsx:284` | A successful retry could leave old history missing | Hydration tracked independently of live content, merging and index rebasing | Recovers history without deleting live events |
| P1 | Accessibility | `web/src/WorkspacePage.tsx:170`, `:195`, `:259` | Incomplete tabs and click-only cards | Arrow keys/Home/End, roving focus, associated panels, native buttons | Predictable keyboard flow |
| P1 | Colors | `web/src/styles.css:14` | White on primary hover: 3.85:1 | `#606cd0`: 4.61:1; separate token for accented text | Small-text compliance on hover |
| P1 | State / trust | `web/src/Board.tsx:219`, `:393` | Launch possible from an unsaved draft | Explanation and launch disabled while the card is dirty | Identifiable execution configuration |
| P1 | State / trust | `web/src/WorkspacePage.tsx:57` | Grouped reads could propagate an error between tabs | Dependencies limited to the selected tab and isolated errors | A Board failure does not hide Feed or Conversations |
| P2 | State / trust | `web/src/screens/Workspaces.tsx:32` | A late response could display another workspace's feed | Request generation invalidated on change and close | Prevents cross-workspace data mix-ups |
| P2 | Writing / prevention | `web/src/screens/Agents.tsx:244`, `:268` | Incomplete rows silently removed; ambiguous validation outcome | Explicit errors; saved/applied/validated outcomes distinguished; created ID retained | No false failure or recreation when validation is unavailable |
| P2 | Layout / recognition | `web/src/screens/Agents.tsx:328` | Catalog of 134 skills without search | Search by name/description and semantic groups | Reduces selection effort |

## Verification

Latest complete application verification pass:

- `npm run typecheck`: passed.
- `npm run build:web`: passed.
- `npm test`: **69/69 passed in two consecutive full runs**.
- `scripts/ui-smoke.mjs`: modal focus/input/Escape, invalid JSON preserved, mobile menu inert and closed with Escape.
- `scripts/ui-regression.mjs`: eight groups of browser checks, including long history at 320 px, draft after failure, keyboard tabs/panels, Board launch after saving, visible embedded PM chat, hover contrast, history error, and late feed response.
- `scripts/ui-stream-recovery.mjs`: two browser flows at 320 px, initial history unavailable followed by recovery of an assistant response shorter or longer than the live text; a single bubble retained and the next delta applied to that same bubble.
- `test/m5.test.ts`: **9/9 in five consecutive repetitions**, with session resume, same-second history, and a guard against an older run still being active.

The browser scripts use an isolated headless Chrome, Puppeteer supplied by browser-tools, and no addition to the application package. The smoke test blocks mutations; the regression test intercepts all APIs and simulates send failure, without real backend writes.

```bash
BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-smoke.mjs
BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-regression.mjs
BROWSER_TOOLS_DIR=/Users/salimlaimeche/.pi/agent/skills/browser-tools node scripts/ui-stream-recovery.mjs
```

Prerequisites: Vite on `:5321`, Chrome installed. `CHROME_PATH` overrides the default macOS path.

The six pages were also inspected with local data and screenshots at 320 px, with no overall overflow observed. Temporary screenshots: `/tmp/cogitator-final-*.png`. This does not certify all states.

## Independent review and limitations

The blockers reported during review (error propagation between tabs and history recovery) are corrected and covered by regressions. The two closing reservations are also resolved:

- **Partially streamed assistant**: overlap detection recognizes a shorter or longer prefix only for the active assistant bubble. Live text is preserved, and subsequent deltas continue to target the correct bubble. The scenario failed before the correction; component and browser tests pass afterward.
- **Intermittent cron**: the fake test client always created a new session, even with `--session`. Sorting only to the second sometimes hid this error by returning the first run. The mock now respects resume behavior, and the test checks all sessions, not just the first row. Shared code in `src/cron.ts` breaks equal-timestamp ties with `rowid DESC` for history and the latest session. The concurrent-run lookup excludes the current run so that an older active run cannot be hidden. Three scenarios failed deterministically before the correction and now pass.

These cron changes are targeted: no schema change or migration. Chat merging remains based on order and text, without inventing identifiers absent from the current contract.

**Final independent review of the reservation fixes: Approve**, with no blocking findings. The reservations identified in this pass are closed. Screenshot of the mobile recovery scenario: `/tmp/cogitator-stream-recovered.png` (simulated API and events, real interface).

Not verified: real screen reader, native 200% zoom, touch hardware, all providers/protocols, and all real network/streaming states. Automated checks prove neither exhaustive accessibility nor perfect visual quality.
