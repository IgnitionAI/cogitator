# ADR-012 — Live subagent visibility: read the herdr socket, render a read-only side panel

- Status: accepted
- Date: 2026-10-19
- Related: ADR-005 (subagent setups → herdr definitions), ADR-001 (pi RPC processes), plan 0006

## Context

Subagent setups are configuration-only today (ADR-005: preset working copy → `~/.pi/agents/noo-*.md` on Apply). At runtime, a conversation's pi process may spawn herdr subagents; the owner wants to **see those live subagents in a side panel** of the conversation screen.

Established facts (verified 2026-10-19):

- Conversation pi processes are plain children (`pi --mode rpc`, pool — I3), **not** herdr panes.
- Subagents spawned via the pi herdr extension are herdr panes supervised by the herdr daemon (socket `~/.config/herdr/herdr.sock`), regardless of how the parent pi was launched.
- herdr exposes live runtime state over its socket. CLI: `herdr api snapshot` → JSON. Pane shape (from `herdr api schema --json`, protocol 22): `pane_id`, `label`, `agent`, `agent_status` ∈ `idle|working|blocked|done|unknown`, `agent_session: { source, agent, kind: "id"|"path", value } | null`, `cwd`, `tab_id`.
- Conversation ↔ pi session: `conversation.session_file` (UNIQUE, nullable) — the same `--session` file pi was launched with.
- **Not verified without a live daemon**: which `agent_session` field links a child pane to its parent pi session (`source` vs directory of `value` when `kind: "path"`). Plan 0006 step 1 is a live spike that settles this; the rule lives in one isolated function.

## Decision

1. **The server is the only reader of the herdr socket.** It shells out to `herdr api snapshot` (JSON) with a short timeout — same pattern as `pi --version` in `src/pi.ts`. No direct socket code, no new dependency, no browser→herdr path.
2. **Mapping is server-side and conversation-scoped**: panes whose reported agent-session identity matches the conversation's `session_file` are its subagents. The exact match rule is isolated in `linkBelongsToConversation()` and fixed by the spike.
3. **Graceful degradation**: daemon absent, timeout, or malformed output → `200 { live: false, subagents: [] }`. A missing herdr is never a 5xx.
4. **v1 is read-only**: list label + status (+ session). No focus/kill/input actions on panes — that is a separate future ADR.
5. **Polling, not SSE**: the UI polls the endpoint on a short interval while the panel is open. No herdr event subscription in v1.
6. **Isolation**: the snapshot is host-local and enumerates all panes, but the response only ever contains panes linked to the requested conversation. herdr sits in the same host trust domain as the server and already executes work for these conversations' children.

## Rejected alternatives

- **Tracking table in the cogitator DB** (record spawns ourselves) → duplicates herdr's supervision registry, drifts on CLI-spawned panes, misses panes spawned before cogitator restarts.
- **Direct socket access from the browser** → auth/trust boundary violation; the socket can control panes.
- **SSE push from herdr events in v1** → herdr event subscription adds a second long-lived connection for a 3-second poll use case.
- **Parsing pi session files to detect children** → children (standalone mode) carry no parent link; reading herdr's registry via its own API is the single source of truth (ADR-005 spirit).
