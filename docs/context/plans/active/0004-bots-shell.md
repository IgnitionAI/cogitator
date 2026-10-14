# Plan 0004 — Bots shell (Grok-like mode on Cogitator)

Status: active (specified, not implemented)
Created: 2026-10-14
Updated: 2026-10-14 (groups + NL principal; ADR-011)
ADR: [ADR-010](../../decisions/ADR-010-bots-as-primary-shell.md), [ADR-011](../../decisions/ADR-011-group-conversations.md)
UX: [ux-bots-shell.md](../../../architecture/ux-bots-shell.md), mockups in [`design/`](../../../../design/)
Complexity: Architectural. Mode B: existing Cogitator.

## Objective

Make Cogitator’s home “text teammates”. Natural language with the **Majordome** creates agents, crons, and groups. Bots work via their MCP/tools. Groups are N pi processes on one Cogitator thread. VPS/computer pane later (Plan 0002).

## Product (locked)

| Want | How |
|---|---|
| Create an agent in NL | Talk to Majordome (`cogitator_create_agent` already) — home is that chat |
| Cron | Existing `CronTask`; Majordome already creates schedules |
| Connect / work | Per-preset MCP + pi tools. No universal connector marketplace |
| 1–1 bot | Resume last non-group conversation for that `agent_id` |
| Group + talk among bots | ADR-011: bus + N member sessions |
| Force de proposition | Prompt “propose then wait” + cron. No unsolicited turns outside a tick |

## AS-IS evidence

- Nav: `conversations | workspaces | agents | …` (`web/src/App.tsx`)
- `conversation.agent_id` is singular; pool = 1 process per conversation, cap 8
- Majordome + MCP CRUD already create agents/crons in French
- `workspace.default_agent_id` exists; presets have no workspace FK
- I5: no 1–1 transcript in SQLite

## Invariants

- No `Bot` table — AgentPreset is the bot
- 1–1 spawn cwd = `agent_preset.default_workspace_id` (null → picker, then persist)
- Group spawn cwd = `group.default_workspace_id` ?? host preset
- Resume-last ignores `group_id IS NOT NULL` conversations
- Member sessions still frozen (ADR-001)
- All pi spawns through `PiProcessPool` (I3)
- Group size 2–6; pool cap 8 unchanged

## Milestones

| Milestone | Change | Exit |
|---|---|---|
| **S0 — Schema v4** | `default_workspace_id` on `agent_preset` (group tables wait for S4) | ✅ v3→v4; existing presets null |
| **S1 — 1–1 API** | `GET /conversations?agent_id=`; spawn fills workspace from preset when set (else standalone) | ✅ `test/s0-s2.test.ts` |
| **S2 — Shell** | Nav **Bots** first; click = resume last / spawn; auto-open default agent | ✅ `web/src/screens/Bots.tsx` |
| **S3 — NL create** | Empty/first run opens Majordome; Agents CRUD secondary (⚙) | “Crée-moi un agent …” works from home without the Agents screen |
| **S4 — Groups** | `POST /groups`, `POST /groups/:id/messages` (@ vs host), SSE on the bus, inject into member sessions | 2 bots in one thread; `@` runs only that process; no `@` runs host |
| **S5 — Specs** | domain / API / blueprint / contract / guardian match shipped code | This package, then code follows it |

Then keep `domain-model.md` + `api-contract.md` in lockstep with S0–S4.

## Out of scope

Computer/Watching pane, VPS host field, voice, marketplace, cron→group, “connect to everything” beyond MCP, Pi TUI overlay, `bots` table, unsolicited LLM turns without cron/user/`@`.

## Effort / deps

S0–S3 are small (column + query + nav). S4 is the real work (bus, routing, injection, pool). Not blocked by 0002/0003. Does not certify remote 24/7 (cron still dies with the server unless Plan 0002).
