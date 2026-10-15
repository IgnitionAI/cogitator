# Architecture Contract — Cogitator

Machine-verifiable rules. Any PR that violates them fails review.

## Prohibitions

1. **I1** — No writes to `~/.pi/agent/settings.json` or `~/.pi/agent/auth.json` outside Registry endpoints (atomic write + `.bak` required).
2. **I2** — No writes to workspace directories (cogitator reads the filesystem; it does not modify it).
3. **I3** — No pi process spawns outside `PiProcessPool` (a single spawn point; flags materialized from the preset snapshot, never reconstructed ad hoc). Durable conversations never spawn a pi process: their runtime is the controller-owned Durable harness, reachable only through the composition point `src/runtime.ts` (ticket #15, Plan 0002 §6).
4. **I4** — The pi extension entry point must do nothing at load time except register the `/cogitator` command (no server started in the host process).
5. **I5** — No **1–1** transcript data in the SQLite database (only metadata + configuration snapshot; those transcripts live in pi's `.jsonl` files). Durable-mission transcripts instead live in the Durable runtime's own storage per conversation (ADR-006 amendment, ticket #15) — still never in the catalog.
6. **I8** — A group thread is a Cogitator bus (`group_message` rows), not a shared pi `.jsonl`. Each member still has a private session file. Do not invent a multi-writer pi session (ADR-011).

## Obligations

1. **O1** — Every agent preset write triggers Apply (generation/deletion of herdr `.md` files); the store and registry do not diverge.
2. **O2** — Generated herdr definitions carry the `noo-<agent-slug>-` prefix and are the only files cogitator deletes in `~/.pi/agents/` (never a file it did not generate).
3. **O3** — A cron run always creates a `CronRun` (success, failure or skip).
4. **O4** — All server TCP listeners bind to `127.0.0.1` only. Protected mode may additionally expose an owner-only Unix socket (`0600` beneath the private `0700` auth directory), sharing the same route/event registration. Private identity comes from server-owned request objects, never a TCP header; this trusted local OS capability must not reach remote workers (ADR-009).
5. **O5** — Spawn flags include `--no-skills` whenever an explicit skills list is provided (never merge with global discovery).
6. **O6** — The configuration snapshot is frozen in `Conversation` at spawn; preset changes never alter an open session. For durable missions, the frozen snapshot's digest, the classified toolchain, the selected extensions and the pinned Durable SDK version are additionally frozen in the mission profile (Durable storage) and verified on every open; a mismatch fails closed (ticket #15).
7. **O7** — Protected browser/TCP application access requires a freshly validated owner session with that session's MFA assurance; account enrollment alone never grants access. Protected-state loss fails closed, never silently selecting local mode. Only the exact public authentication/status/static surface is exempt (ADR-009).
8. **O8** — Group messages without `@` run only the host process. `@` runs only mentioned members. All member spawns go through `PiProcessPool` with a frozen snapshot (I3, ADR-001/011).
9. **O9** — 1–1 spawn without `workspace_id` uses `agent_preset.default_workspace_id`. Group member spawn uses `agent_group.default_workspace_id` else the host preset’s cwd (ADR-010/011).

## Conventions

- Slugs: kebab-case, ≤64 characters, `noo-` prefix reserved for generated subagents.
- Ports: server 5320 (`COGITATOR_PORT` variable).
- Data: `~/.cogitator/` (db, temporary prompts, logs).
- API errors: JSON `{ "error": string }` + correct HTTP status code.
