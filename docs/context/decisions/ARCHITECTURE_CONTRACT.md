# Architecture Contract — Cogitator

Machine-verifiable rules. Any PR that violates them fails review.

## Prohibitions

1. **I1** — No writes to `~/.pi/agent/settings.json` or `~/.pi/agent/auth.json` outside Registry endpoints (atomic write + `.bak` required).
2. **I2** — No writes to workspace directories (cogitator reads the filesystem; it does not modify it).
3. **I3** — No pi process spawns outside `PiProcessPool` (a single spawn point; flags materialized from the preset snapshot, never reconstructed ad hoc).
4. **I4** — The pi extension entry point must do nothing at load time except register the `/cogitator` command (no server started in the host process).
5. **I5** — No transcript data in the SQLite database (only metadata + configuration snapshot; transcripts live in pi's `.jsonl` files).

## Obligations

1. **O1** — Every agent preset write triggers Apply (generation/deletion of herdr `.md` files); the store and registry do not diverge.
2. **O2** — Generated herdr definitions carry the `noo-<agent-slug>-` prefix and are the only files cogitator deletes in `~/.pi/agents/` (never a file it did not generate).
3. **O3** — A cron run always creates a `CronRun` (success, failure or skip).
4. **O4** — The server listens on `127.0.0.1` only.
5. **O5** — Spawn flags include `--no-skills` whenever an explicit skills list is provided (never merge with global discovery).
6. **O6** — The configuration snapshot is frozen in `Conversation` at spawn; preset changes never alter an open session.

## Conventions

- Slugs: kebab-case, ≤64 characters, `noo-` prefix reserved for generated subagents.
- Ports: server 5320 (`COGITATOR_PORT` variable).
- Data: `~/.cogitator/` (db, temporary prompts, logs).
- API errors: JSON `{ "error": string }` + correct HTTP status code.
