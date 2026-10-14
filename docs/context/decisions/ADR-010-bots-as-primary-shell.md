# ADR-010 — Bots as the primary Cogitator shell

- Status: accepted (product decision; not implemented)
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

## Rejected

- Separate « Pi Bot » app — double chrome
- Pi TUI overlay — not the Grok-like interface
- Always standalone / pick workspace every chat — either breaks code agents or kills “one bot = one colleague”
