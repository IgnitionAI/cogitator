# ADR-010 — Bots as the primary Cogitator shell

- Status: accepted (shipped in tree; see Implementation)
- Date: 2026-10-14
- Related: Plan 0004, ADR-001, ADR-003, ADR-008, ADR-011

## Context

Grok Bot’s useful shape is named teammates you text, with compounding context and a later optional remote computer. Cogitator already has AgentPreset + Conversation + Workspace + a Linear-grade web shell on `pi --mode rpc`. A Pi TUI extension cannot host that UI. A second app would duplicate chrome.

Workspace already has `default_agent_id` (this folder → this agent). A bot still needs a cwd the other way (this agent → this folder).

## Decision

1. **No `Bot` table.** `AgentPreset` is the bot (`name`, `description` = job, `system_prompt` = standing rules).
2. **Primary nav is the bot list**, not Conversations. Clicking a bot resumes its latest conversation (`GET /api/conversations?agent_id=`); **New chat** still `POST`s. Existing Conversations/Agents screens remain, secondary.
3. **`agent_preset.default_workspace_id`** (FK, `ON DELETE SET NULL`). Spawn without `workspace_id` uses it. If null, the first message picks a workspace and persists. `workspace.default_agent_id` is unchanged.
4. **VPS later, same API, other host.** No computer/Watching pane in this slice. No Pi overlay, voice, or marketplace. Groups are **ADR-011** (N processes, one Cogitator thread) — not a Pi overlay and not a second app.

Open sessions stay frozen (ADR-001). Preset/workspace edits affect the next spawn only.

## Consequences

+ One product, shortest path to a Grok-like IA
+ Context compounds via the existing JSONL session
− Two default FKs can disagree; bot spawn follows the bot’s FK
− Resume-last is a behavior change vs always-new conversation

## Implementation (verified in `src/` / `web/src/`)

The product decision above is no longer “specified only”. The shipped slice matches the four points in **Decision**:

1. There is still no `Bot` table. Presets live in `agent_preset` (`src/agents.ts`, `src/db.ts`).
2. Primary nav starts with **Bots**; default screen is `bots`. Conversations / Agents remain separate items (`web/src/App.tsx`). Clicking a bot resumes its latest 1–1 conversation (`GET /api/conversations?agent_id=` via `listConversations`, which excludes `group_id IS NOT NULL` rows) or `POST`s a new one (`web/src/screens/Bots.tsx`). First load auto-opens the default agent (Majordome) when present.
3. `agent_preset.default_workspace_id` exists since schema **v4** (`MIGRATE_V3_TO_V4` in `src/db.ts`). Spawn without `workspace_id` uses it (`resolveConversationSpawn` in `src/server.ts`). `workspace.default_agent_id` is unchanged. Tests: `test/s0-s2.test.ts`.
4. No computer / Watching pane, Pi overlay, voice, or marketplace in this slice. Groups are **ADR-011**.

Out of this ADR (still true): VPS/host field is Plan 0002, not this shell. MCP tools still do not create groups (Majordome CRUD in `src/mcp-server.ts` covers agents/crons/workspaces/conversations only).

## Rejected

- Separate « Pi Bot » app — double chrome
- Pi TUI overlay — not the Grok-like interface
- Always standalone / pick workspace every chat — either breaks code agents or kills “one bot = one colleague”
