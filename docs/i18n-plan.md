# Complete English / French interface — implementation plan

## Problem and evidence

The interface is predominantly hardcoded French, with English status identifiers, CSS-generated French instructions, mixed locale formatting, and backend-originated French diagnostics. The analysis read all 22 web source files and all 26 backend modules. Baseline: commit `65a5393ae9e5eb20b6b28e4e1e3b9d7bad350eac`, 92 tests passing.

## Desired behavior and scope

Every Cogitator-owned interface surface is available in English and French: shell, six screens, workspace tabs, board, chat, tools, markdown controls, generative UI wrappers, file views, feed, forms, dialogs, confirmations, empty/loading/error/success states, notifications, accessibility text, statuses and locale formatting.

Content is not interface chrome: preserve user/agent-authored names, descriptions, prompts, messages, generated UI specification labels, skills, files/code, GitHub content and third-party diagnostics. Translate Cogitator-owned context around diagnostics; retain raw external detail. Preserve technical IDs, protocol names, JSON keys, API enums and persisted data. Existing French interactive response envelopes remain compatible. Built-in editable agent names/prompts are persisted content, not to be rewritten by switching language.

## Decisions and assumptions

- Browser-local preference (`cogitator.locale`), supported values `en` / `fr` only. Detect French browser preferences initially, otherwise English. Invalid preferences fall back safely. Storage denial must not break the app.
- Visible accessible language selector in shell; switch immediately without reload, remount, lost drafts, changed sessions or altered data. Update document `lang`. Synchronize valid cross-tab changes.
- Small typed bilingual catalogs and interpolation, native `Intl` formatting, React subscription for updates; no new runtime dependency. Domain catalogs separate concurrent ownership, not a new framework.
- Localize labels, not enum values. Date/time display follows locale, retaining browser timezone; cron scheduling stays server-local. Handle zero/one/many counts and file-size units.
- Translate all owned runtime diagnostics at the display boundary, including parameterized messages, validation arrays and cron failures. Retain API validation `issues` rather than dropping them. Generated transcript/diff truncation suffixes use a language-neutral ellipsis; unnamed tools use an empty metadata value so the frontend supplies its localized fallback. Unknown third-party errors retain original detail with localized context. No translation of arbitrary transcript/file text.
- Keep historical response serialization compatible; localize its rendered summary and newly generated application prompts without changing request identity or stored user content.
- Remove language-bearing CSS `content` in favor of localized markup/attributes.
- Preserve existing behavior/security/accessibility; do not migrate the database, reconfigure pi, contact models or mutate real workspace/GitHub board data during verification.

## Implementation units (in order of dependency)

1. Foundation and shell: typed catalogs, interpolation, locale store/subscription, formatting/status helpers, preference selector/document language, shared components and runtime-diagnostic translation seam.
2. Screens: agents/providers/settings/cron/workspace list, every nested modal/control/state, enum display labels and formatting.
3. Workspace and board: workspace page/team/PM wrappers, board dialogs/comments/dependencies, files and feed, locale-sensitive dates/counts.
4. Chat: conversations and composer, attachments, markdown/tool rendering, interactive forms/tables/response wrappers and errors, backward-compatible history.
5. Coverage: catalog parity and placeholders, locale selection/storage/formatting, source-literal coverage guard, existing harness adaptation without weakening assertions, bilingual rendered/runtime cases. Update README language support.

## Acceptance criteria

- **AC1 Coverage:** all owned copy in every listed surface has FR and EN entries, including accessibility and CSS instructions; automated catalog parity/interpolation and source-copy coverage checks pass.
- **AC2 Locale behavior:** selecting either language updates current UI and document language immediately, preserves drafts/open state, survives reload; browser default/invalid locale/denied storage/cross-tab behavior tested.
- **AC3 Presentation:** dates/times/numbers/plurals/sizes and enum labels follow locale while raw identifiers, persisted values, timezone semantics and user content are unchanged.
- **AC4 Diagnostics:** local and server-owned error/validation/status wrappers work in both languages; raw external diagnostics remain available; save-failure drafts and pending operation safeguards remain intact.
- **AC5 Chat integrity:** FR legacy interactive responses still parse and associate correctly; all four generated UI kinds and invalid/incomplete/submitting/submitted/error states have localized wrappers; switching language does not lose form values or grant execution authorization.
- **AC6 Regression/runtime:** typecheck, build and complete tests pass; real browser exercise both languages across all top-level screens, workspace tabs and representative dialogs/chat/interactions; mobile navigation and overflow checks pass with no unexpected page errors. Use isolated fixtures, not live data mutations.

## Verification and workflow

Implementation -> parallel Standards and Spec code reviews against the pinned baseline -> fix findings and repeat review -> verification. Preserve commands/results and current screenshots (display every captured screenshot inline). Browser fixture checks are distinct from authenticated external integrations; no provider/GitHub action is required to prove translation.

This plan has more than three units and spans frontend/backend display contracts, so a GitHub issue is required by `$plan`. Create/read back the issue, implement and commit on the current branch, then comment with acceptance evidence and commit SHA and close/read back CLOSED only after all criteria PASS. No push, deployment or unrelated GitHub mutations are requested.
