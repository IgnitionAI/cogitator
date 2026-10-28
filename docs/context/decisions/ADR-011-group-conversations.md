# ADR-011 — Group conversations as N processes, one Cogitator thread

- Status: accepted (shipped in tree; see Implementation)
- Date: 2026-10-14
- Related: Plan 0004, ADR-001, ADR-010, ADR-004

## Context

Grok-like teammates need a **group**: several named bots in one visible thread, `@` to direct, handoff between bots. Today a Conversation has one `agent_id` and one `pi --mode rpc` process. Pi cannot share a `.jsonl` across processes.

A single host + herdr subagents already exists (Chef de Projet). That is “chef + équipe”, not a Slack-like group. The owner chose N processes / one thread.

## Decision

1. **Group is a Cogitator aggregate**, not a pi session. Members = 2–6 AgentPresets. One **host** (`host_agent_id`) handles un-@ messages.
2. **Each member has a private Conversation** (existing row + jsonl + pool slot). `conversation.group_id` is set; those rows are not 1–1 “resume last” chats.
3. **The group thread is a bus log Cogitator owns** (`group_message` in the catalog DB). It is not a shared pi jsonl (I5 stays for 1–1; see I8).
4. **Routing**
   - `@Name` / `@slug` → that member’s process runs; the user text (and recent bus excerpt) is injected into its session.
   - No `@` → only the host runs. The host may `@` others (handoff).
   - Parallel: several mentioned members may run in the same turn, bounded by the pool cap of 8.
5. **Injection** uses the existing pool (`send` / user message), not a second spawn path (I3).
6. **Cron stays 1–1** (wakes one agent). Cron → group is out of this slice.
7. **Cwd** of member sessions = `group.default_workspace_id`, else the host preset’s `default_workspace_id`.

## Consequences

+ Real parallel work; each bot keeps compounding private memory
+ Matches Grok’s `@` model without N LLM calls on every unmentioned message
− Group of 6 uses 6 pool slots; idle recycling still applies
− Bus log in SQLite is a deliberate I5 exception (I8)
− Two FKs (bot vs group workspace) can still disagree; group spawn follows the group

## Implementation (verified in `src/`)

Groups landed with schema **v5** (`agent_group`, `conversation.group_id`) and the bus with schema **v6** (`group_message`) in `src/db.ts`. Catalog code is `src/groups.ts`; HTTP is `groupRoutes` in `src/server.ts`. Tests: `test/s4-groups.test.ts`, `test/s4-group-messages.test.ts`. UI: `web/src/screens/Bots.tsx` (group list + shared thread).

Shipped against the decision:

1. Aggregate is Cogitator-owned: 2–6 distinct presets (`GROUP_MIN` / `GROUP_MAX`), one `host_agent_id`. `POST /api/groups` creates the row then one idle `conversation` per member (`group_id` set), spawned through the existing pool (`I3`).
2. Member sessions are private conversations; `listConversations` hides them from 1–1 resume-last.
3. The visible thread is `group_message` in the catalog SQLite, not a shared pi jsonl. `GET/POST /api/groups/:id/messages` read/append the bus. Member tool/assistant activity is copied onto the bus (`persistGroupActivity`). One SSE stream: `GET /api/groups/:id/events`.
4. Routing (`routeGroupMessage` / `matchGroupMention`): only the **first** `@` mention in the text is examined; if that token is not a member name or slug, the host runs (`@foo @alice` therefore goes to the host even if `alice` is a member). No `@` also means host. Injection is `pool.prompt` on that conversation. A reply from **any** member that `@`mentions another member triggers a one-shot handoff (`handleHandoff`; no A↔B cascade). Cron stays 1–1 (`src/cron.ts` has no group path). Member cwd is `group.default_workspace_id`, else the host preset’s `default_workspace_id`.

Not in the tree (do not treat as done):

- Several `@` mentions in the **same** user turn (code comment: one target per line; parallel mentions are a later ticket).
- `PATCH /api/groups/:id` and `POST /api/groups/:id/stop` (no routes).
- Group MCP tools (`src/mcp-server.ts` has none).
- Cron → group.

`DELETE /api/groups/:id` evicts member pool slots then deletes the group; `conversation.group_id` is `ON DELETE CASCADE`, so member rows go with the group.

## Rejected

- One process roleplaying N bots — theatre, no parallel tools
- Shared pi `.jsonl` — races, unsupported
- “All bots decide” with no host — N completions per user line
- Herdr-only groups — not the chosen IA
