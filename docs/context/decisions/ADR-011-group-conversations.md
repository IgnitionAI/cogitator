# ADR-011 — Group conversations as N processes, one Cogitator thread

- Status: accepted (product decision; not implemented)
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

## Rejected

- One process roleplaying N bots — theatre, no parallel tools
- Shared pi `.jsonl` — races, unsupported
- “All bots decide” with no host — N completions per user line
- Herdr-only groups — not the chosen IA
