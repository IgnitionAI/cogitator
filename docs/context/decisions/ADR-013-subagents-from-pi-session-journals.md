# ADR-013 — Live subagent visibility: read pi's own child session journals (no external daemon)

- Status: accepted — supersedes ADR-012
- Date: 2026-10-29
- Related: ADR-012 (herdr socket, abandoned), ADR-005, plan 0006

## Context

ADR-012 read subagent state from the herdr daemon socket. In practice the conversation pi processes are **not** herdr panes, herdr is an optional runtime (no daemon here: `herdr api snapshot` → `server_not_running`), and the real subagent path is pi's own extension `@gotgenes/pi-subagents` (tools `subagent`, `get_subagent_result`, `steer_subagent`). The panel therefore showed "herdr unavailable" for subagents that were actually running.

Verified facts (2026-10-29, live run):

- The extension writes each child session to `<dir of the parent session>/<parent session basename>/tasks/<child>.jsonl` (`src/session/session-dir.ts` of the extension).
- The child journal header carries `id`, `timestamp`, `cwd` and `parentSession` (the parent session id).
- Status is readable from the journal tail: last assistant entry with `stopReason: "toolUse"` (a tool call is pending) or a `toolResult` entry = still working; a closed assistant entry (`stop`) = done; `error` = unknown.
- The first user message in the child journal is the task prompt — the most readable label.

## Decision

1. **No external daemon, no parallel supervision.** The server derives the child directory from `conversation.session_file` and reads the journals directly — the same files pi writes.
2. **Bounded reads.** Parent header 16 KiB; child head 64 KiB, expanded to 1 MiB when needed to find the first prompt after a large system preamble, and tail 64 KiB (status). Windows use byte offsets before UTF-8 decoding, without loading the full journal. At most 20 child candidates, most recent first; non-files, malformed journals and unverifiable parent links are skipped.
3. **Isolation by construction** (directory derived from the parent's own name) **and** by re-checking `parentSession` in each child header, so a recycled directory never leaks another conversation's subagents.
4. **Statuses**: `working` | `done` | `unknown`. A child idle for more than an hour on a non-final entry is reported `unknown` (its process is gone without a final message).
5. **Read-only**, polling from the UI while the panel is open (unchanged from ADR-012).
6. **`live`** now means "this conversation has an inspectable pi session". Missing or unreadable parent header → `live: false, subagents: []`.

## Limits (stated, not hidden)

- Status is a journal inference, not a liveness probe: a killed child that never wrote a final message stays `working` for up to an hour, then `unknown`.
- A child that is *blocked on a question* is indistinguishable from a working one for now (the journal shows a pending tool call).
- Children spawned with `session_mode` that keeps no file under `tasks/` would not be listed; all modes observed write one.

## Rejected alternatives

- **Herdr socket (ADR-012)** — requires a daemon that is not part of this runtime; the panel was dead in practice.
- **Tracking spawns in the Cogitator DB** — duplicates the extension's registry and drifts on children spawned by nested agents.
- **Scanning `ps` for child processes** — platform-specific, and the journal already carries the state we need.
