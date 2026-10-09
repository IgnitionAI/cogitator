# Context Index — Cogitator

A lightweight, durable index. Updated with each architectural change. Sources of truth: this file, [`current-state.md`](current-state.md), [`decisions/`](decisions/) and [`plans/`](plans/).

## What is Cogitator

A local web control panel for [pi](https://pi.dev): composable agents (provider + model + thinking + skills + MCP + subagents + scope prompt), directory-based workspaces, standalone or workspace conversations, cron with a busy-guard. Single-user, local (`127.0.0.1:5320`), no authentication.

## Current state

The current implementation baseline is **0.3.0** (`bd128d2`), including independently delivered French/English UI support. The application remains a local, single-user RPC-based control panel without remote authentication or durable task recovery. Earlier release test reports are not VPS security or crash-recovery certification. See [`current-state.md`](current-state.md).

The owner has approved the requirements for personal public-HTTPS access and autonomous recovery and has invoked implementation of [Plan 0002](plans/active/0002-secure-vps-durable.md). [Issue #7](https://github.com/IgnitionAI/cogitator/issues/7) tracks the full migration and release gates. Remote deployment is not complete; the specific target and identity configuration still require designation.

## Documents

| Document | Role |
|---|---|
| [Domain Model](../architecture/domain-model.md) | Bounded contexts, entities, invariants, ER |
| [Blueprint](../architecture/blueprint.md) | Components, pool, flags, cron, apply |
| [API Contract](../architecture/api-contract.md) | REST + SSE |
| [Decisions](decisions/) | Existing ADRs, stack record, contract and checklist; proposed ADR-008 is not yet an active-contract amendment |
| [MVP Plan](plans/active/0001-mvp.md) | Historical milestones M0→M6 |
| [Secure VPS and Durable Plan](plans/active/0002-secure-vps-durable.md) | Confirmed scope, target boundaries, decisions, review and acceptance gates |
| [ADR-008 proposal](decisions/ADR-008-secure-vps-durable.md) | Separate authenticated remote execution from the existing local runtime |

## Key architectural decisions (quick reference)

1. Agent configuration **materialized as native pi flags** at each spawn — never hot-mutated pi configuration (ADR-001)
2. Per-agent MCP via **`registerMcpServer`** (built-in) (ADR-002)
3. Workspace = **unique directory on disk** (ADR-003)
4. **In-process** cron with a busy-guard; the "server must be running" limitation is accepted (ADR-004)
5. Subagents = **generated herdr definitions** `noo-*.md`; a single runtime source of truth (ADR-005)
6. Single **SQLite** store `~/.cogitator/cogitator.db` (ADR-006)
7. **Full-stack TypeScript**, React+Vite, SSE, distributed as the pi package `@ignitionai/cogitator` (ADR-007)

## Non-negotiable conventions

- Never write to workspaces; never write to `settings.json`/`auth.json` outside Registry (atomic + backup)
- Spawn pi only through `PiProcessPool` with a frozen snapshot
- Bind to `127.0.0.1` only
- The `noo-` prefix is reserved for generated herdr definitions
