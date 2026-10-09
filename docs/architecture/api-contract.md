# API Contract — Cogitator

Base URL: `http://127.0.0.1:5320`. Everything is local, with no authentication (single-user machine — ADR-004/007).
Errors: JSON `{ "error": string }`, standard HTTP status codes. Sensitive writes: server-side atomic write + backup (`.bak`).

## Registry (pi configuration)

| Method | Route | Description |
|---|---|---|
| GET | `/api/providers` | Providers from the pi catalog + authentication status + models by provider |
| POST | `/api/providers` | Add a provider (writes `models.json` + `auth.json`) |
| PUT | `/api/providers/:id` | Update (merge, preserving unknown fields) |
| DELETE | `/api/providers/:id` | Delete + remove the key from `auth.json` |
| GET | `/api/skills` | Discovered skills (union of pi locations): name, description, path |
| GET | `/api/mcp` | User-level MCP servers (`~/.pi/agent/mcp.json`) |
| PUT | `/api/mcp` | Replace the file (validated before writing) |

## Agents

| Method | Route | Description |
|---|---|---|
| GET | `/api/agents` | List presets (without full prompts) |
| POST | `/api/agents` | Create + Apply (generates subagent `.md` files) |
| GET | `/api/agents/:id` | Full details |
| PUT | `/api/agents/:id` | Update + Apply |
| DELETE | `/api/agents/:id` | Delete + remove generated `.md` files |
| POST | `/api/agents/:id/validate` | Check provider/model/skills/MCP (existence, structure) |

## Workspaces

| Method | Route | Description |
|---|---|---|
| GET | `/api/workspaces` | List + conversation count |
| POST | `/api/workspaces` | Create `{ dir, name?, default_agent_id? }` — the directory must exist |
| PUT | `/api/workspaces/:id` | Rename, change the default agent |
| DELETE | `/api/workspaces/:id` | Delete (pi sessions remain on disk) |
| GET | `/api/fs/browse?path=` | Server-side file picker (rooted at home, entry by entry) |

## Conversations

| Method | Route | Description |
|---|---|---|
| GET | `/api/conversations?workspace_id=&include=all` | List (metadata from the database + title from the `.jsonl`) |
| POST | `/api/conversations` | Spawn. Body: `{ workspace_id? }` + either `{ agent_id }` or `{ provider, model, thinking?, system_prompt?, skills?, tools? }` (ad hoc), initial `prompt?` |
| GET | `/api/conversations/:id` | `{ conversation, live, streaming }`: details and snapshot, process presence, generation state read through the pool (`live` does not mean a turn is in progress) |
| GET | `/api/conversations/:id/events` | **SSE** — pi events (tokens, tool calls, status) |
| POST | `/api/conversations/:id/messages` | Send a message `{ text, images? }` |
| POST | `/api/conversations/:id/stop` | Interrupt the current turn |
| POST | `/api/conversations/:id/model` | Change the model during a session (native pi support) |
| DELETE | `/api/conversations/:id` | Close + remove from the pool (the `.jsonl` remains) |

Responses to interactive components use the same `POST /messages`: a `cogitator-response` envelope in `text`, with no action endpoint or additional execution authorization. The rendering contract and automatic presentation policy are supplied by the spawner at startup/resume, including for older sessions; their snapshots and transcripts are not rewritten. See [the generative UI contract](../chat-generative-ui.md).

## Schedules (cron)

| Method | Route | Description |
|---|---|---|
| GET | `/api/schedules` | Tasks + `last_run_at`, calculated `next_run_at` |
| POST | `/api/schedules` | Create `{ name, cron_expr, prompt, agent_id?, workspace_id?, output_policy, busy_policy, catchup }` |
| PUT | `/api/schedules/:id` | Update / enable / disable |
| DELETE | `/api/schedules/:id` | Delete (run history is retained) |
| POST | `/api/schedules/:id/run` | Trigger immediately by hand |
| GET | `/api/schedules/:id/runs?limit=` | History (most recent runs first) |

## Global events

| Method | Route | Description |
|---|---|---|
| GET | `/api/events` | **SSE** — session creation/termination, status changes, cron run completion (for UI badges/notifications) |

## Health

| Method | Route | Description |
|---|---|---|
| GET | `/api/health` | `{ ok, version, pi_version, sessions_active, db }` |
