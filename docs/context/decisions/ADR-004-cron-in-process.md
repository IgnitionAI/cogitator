# ADR-004 — In-process cron with a busy-guard

- Status: accepted
- Date: 2026-10-06

## Context

Inspiration: the Scheduled Tasks system in [AionUi](https://github.com/iOfficeAI/AionUi) (CronService, CronStore, CronBusyGuard — a task that sends a predefined prompt to an agent at a set time, appending the result to a session). Possible executor: the cogitator server process, or native system jobs (launchd/cron → `pi -p`).

## Decision

Cron **inside the cogitator server process**:

- Spawn a transient conversation (the task's agent + workspace) at the scheduled time
- Append the result to a dedicated session (visible in the UI) + SSE event
- **Busy-guard**: never 2 simultaneous runs of the same task; configurable per-task policy: skip | queue | kill
- Optional **catchup**: 1 catch-up run if executions were missed
- **Accepted limitation, displayed in the UI**: cron runs only while the server is running

## Consequences

+ Full run history in the store (CronRun), native UI notifications
+ No duplicate source of truth (launchd output would end up outside the UI)
− No 24/7 execution if the machine/server is stopped (acceptable in v1, single-user, local)

## Rejected alternatives

- Native launchd jobs in v1 → output outside the UI, duplicate bookkeeping; can be reconsidered in v2 through export
