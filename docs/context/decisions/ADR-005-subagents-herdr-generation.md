# ADR-005 — Subagent setups: generating native herdr definitions

- Status: accepted
- Date: 2026-10-06

## Context

An agent preset includes subagent setups (provider, model, thinking, skills, MCP, prompt). Cogitator could define its own schema and execution engine, or configure existing engines (herdr: `~/.pi/agents/*.md` + spawn gates/supervision; pi-subagents: registry).

## Decision

The cogitator store keeps a **working copy** of SubagentSetups (convenient UI editing, validation). On **Apply** (preset save), they are rendered as native herdr definitions: `~/.pi/agents/noo-<agent-slug>-<sub-slug>.md`. Execution reads only the herdr registry.

## Consequences

+ A single runtime source of truth; a subagent created in the UI is usable from the pi CLI, and vice versa
+ Inherits herdr improvements at no extra cost (gates, models, sessions)
− Store ↔ registry consistency must be maintained (resolved by: the UI writes ONLY through Apply; divergence can be detected by hash)

## Rejected alternatives

- Custom format + in-house engine → reimplements herdr (spawn gates, supervision, session resume) and creates CLI/UI drift
