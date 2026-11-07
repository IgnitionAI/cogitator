# Context Index — Cogitator

A lightweight, durable index. Updated with each architectural change. Sources of truth: this file, [`current-state.md`](current-state.md), [`decisions/`](decisions/) and [`plans/`](plans/).

## What is Cogitator

A local web control panel for [pi](https://pi.dev): named bots (AgentPreset), directory workspaces, 1–1 conversations, group threads (specified), cron with a busy-guard. Single-owner, loopback TCP (`127.0.0.1:5320`), with preserved trusted-local mode and an optional native password/MFA boundary.

## Current state

Authentication policy update: [ADR-014](decisions/ADR-014-simple-owner-login.md) makes email/password the default for each independently installed Cogitator, with MFA explicitly optional. It supersedes the older mandatory-MFA wording; historical verification records still describe the original MFA slice.

The package baseline is **0.5.2**, catalog schema **v10**, with French/English UI, native owner authentication, bots/groups, classic persisted queues and a bounded Durable mission runtime. Local `dev` includes upstream changes through `daf3d37` and the local GitHub import/subagent panel. Production worker isolation and full VPS acceptance remain unproven. See [`current-state.md`](current-state.md).

The owner approved personal public-HTTPS access and autonomous recovery through [Plan 0002](plans/active/0002-secure-vps-durable.md). [Issue #7](https://github.com/IgnitionAI/cogitator/issues/7) remains open for the full migration/release gates. [Plan 0003](plans/active/0003-native-owner-auth.md)'s login/MFA is implemented with bounded local verification; historical test counts are not the current suite count. Deployed P1 and full P2–P5 acceptance remain unproven. The owner selected Firetower and delegated the operational choices on 2026-11-07; see [readiness and selected defaults](../firetower-readiness.md). The old Authelia administrator handoff remains obsolete.

## Documents

| Document | Role |
|---|---|
| [Domain Model](../architecture/domain-model.md) | Bounded contexts, entities, invariants, ER |
| [Blueprint](../architecture/blueprint.md) | Components, pool, flags, cron, apply |
| [API Contract](../architecture/api-contract.md) | REST + SSE |
| [Decisions](decisions/) | ADRs, stack record, contract and checklist; ADR-009 adopted locally, ADR-008's Durable/isolation amendments remain prospective |
| [MVP Plan](plans/active/0001-mvp.md) | Historical milestones M0→M6 |
| [Secure VPS and Durable Plan](plans/active/0002-secure-vps-durable.md) | Confirmed scope, target boundaries, decisions, review and acceptance gates |
| [ADR-008 proposal](decisions/ADR-008-secure-vps-durable.md) | Separate authenticated remote execution from the existing local runtime; its external-IdP choice is superseded |
| [Native owner-auth plan](plans/active/0003-native-owner-auth.md) | Product-owned login/MFA, local compatibility, design review and proof gates |
| [Accepted ADR-009](decisions/ADR-009-native-owner-auth.md) | Locally reviewed native authentication, private Unix capability and explicit limits |
| [Bots shell plan](plans/active/0004-bots-shell.md) | Nav = bots, NL Majordome, groups N-process; implementation and remaining gaps listed in the current state and ADRs |
| [ADR-010](decisions/ADR-010-bots-as-primary-shell.md) | Bot = AgentPreset; `default_workspace_id`; no Bot table / Pi overlay |
| [ADR-011](decisions/ADR-011-group-conversations.md) | Group = Cogitator bus + N member sessions; host vs `@` |
| [UX bots shell](../architecture/ux-bots-shell.md) | Flows, screen inventory, tokens |
| [HTML mockups](../../design/index.html) | `design/` gallery (bot chat + group) |
| [Native-auth operator guide](../native-auth.md) | Offline initialization, enrollment, recovery and private state |
| [Native-auth verification](../native-auth-verification.md) | Exact evidence matrix, review corrections and remaining deployment gates |

## Key architectural decisions (quick reference)

1. Agent configuration **materialized as native pi flags** at each spawn — never hot-mutated pi configuration (ADR-001)
2. Per-agent MCP via **`registerMcpServer`** (built-in) (ADR-002)
3. Workspace = **unique directory on disk** (ADR-003)
4. **In-process** cron with a busy-guard; the "server must be running" limitation is accepted (ADR-004)
5. Preset apply generates herdr definitions `noo-*.md` (ADR-005); live child visibility reads pi session journals without a daemon (ADR-013)
6. Single **SQLite catalog** `~/.cogitator/cogitator.db`; private authentication state is separate and classic transcripts stay pi JSONL (ADR-006/009)
7. **Full-stack TypeScript**, React+Vite, SSE, distributed as the pi package `@ignitionai/cogitator` (ADR-007)
8. Native one-owner password/MFA, private per-session assurance and fail-closed protected mode; trusted local IPC is not remote-worker authorization (ADR-009)
9. Bot = AgentPreset; primary nav is the bot list; `default_workspace_id` on the preset (ADR-010) — implemented
10. Group thread = SQLite bus + one pi process per member; no `@` → host only (ADR-011) — implemented, with remaining gaps recorded in the ADR

## Non-negotiable conventions

- Never write to workspaces; never write to `settings.json`/`auth.json` outside Registry (atomic + backup)
- Spawn pi only through `PiProcessPool` with a frozen snapshot
- Bind all TCP to `127.0.0.1`; only the reviewed owner-only Unix IPC exception is allowed (O4)
- The `noo-` prefix is reserved for generated herdr definitions
