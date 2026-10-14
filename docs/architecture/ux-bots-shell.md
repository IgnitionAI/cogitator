# UX — Bots shell

Plan 0004 / ADR-010 / ADR-011. Tokens = Cogitator `DESIGN.md` (not a new brand). Mockups: [`design/`](../../design/). Primary user: desk operator, daily, FR/EN. Viewport: **390px first** (existing drawer); ≥768px sidebar 220px — same destinations.

## D1 — Discovery (locked)

- First 5 minutes: open Cogitator → Majordome is already there → “crée-moi un agent veille…” → talk to that bot.
- Aha: a named teammate that keeps the thread, not a preset card.
- Density: ~3–12 bots, not 10k. Longest name: `Architecte de Skills IgnitionRAG`.
- When wrong: SSE drop / spawn fail — message + Retry, not a blank chrome.
- Languages: FR/EN catalogs already; mockups in French (longer).
- Dark only (v1). WCAG AA: `--fg` on `--bg`; `--muted` ≥4.5:1 on `--surface` (DESIGN.md).

## Critical journey

```mermaid
flowchart TD
    Open[Open Cogitator] --> Home[Home = Majordome 1-1]
    Home -->|NL create agent| BotCreated[New bot in sidebar]
    BotCreated --> Talk[Resume-last 1-1]
    Home -->|New group 2-6| Group[Group thread]
    Group -->|no @| Host[Host process]
    Group -->|@slug| Member[That process]
    Host -->|host @other| Member
    Talk -->|⚙| Editor[Existing AgentEditor]
    Home -->|cron in NL| Cron[Existing CronTask]
```

## Screen inventory

| Screen | Route | Purpose | States | Priority |
|---|---|---|---|---|
| Bot chat (home) | `/` bot selected | 1–1 resume-last | empty (only Majordome), loading, error, streaming | P0 |
| Group thread | `/groups/:id` | N bots, one composer | empty thread, loading, error, @ running | P0 |
| Cwd picker | dialog | First message if no `default_workspace_id` | default / none / error | P0 |
| Agents editor | `/agents` | ⚙ full preset | existing | P1 |
| Conversations list | `/conversations` | secondary global list | existing | P1 |
| Workspaces / Cron / Settings | unchanged | secondary | existing | P1 |

## Tokens

See `:root` in every `design/*.html` — byte-identical, copied from DESIGN.md. Accent only on primary actions and current nav. One primary action per screen: **Send** (chat) or **Créer le groupe**.

## UX notes → API

- Home must open a conversation without visiting Agents. S3.
- `@` completion needs `GET /api/groups/:id` member names/slugs.
- Cwd picker is the 400 from spawn-without-workspace (S1), not a silent home cwd.
