# API Contract — Cogitator

Default trusted-local URL: `http://127.0.0.1:5320` (ADR-004/007). The native protected-mode increment uses a fixed canonical HTTPS browser origin through a trusted TLS terminator; TCP remains loopback-only. Its [verification status](../native-auth-verification.md) is separate from public remote-deployment approval.

Errors: JSON `{ "error": string }`, standard HTTP status codes. Sensitive registry-file writes use atomic replacement + backup (`.bak`); authentication has its own private SQLite/library lifecycle, not that registry-file contract.

## Native owner authentication

In protected mode, every application route below—including detailed health, files, history and both SSE feeds—requires a fresh owner session with per-session MFA assurance. Public access is limited to minimal status, the exact selected authentication routes and login-shell/build assets. An enrolled account does not promote password-only sessions. See [operator guidance](../native-auth.md) and [Plan 0003's complete browser contract](../context/plans/active/0003-native-owner-auth.md#browser-http-contract-for-implementation).

| Method | Route | Request / safe response |
|---|---|---|
| GET | `/api/status` | `{ service: "cogitator", authentication: "local" \| "required" }` |
| GET | `/api/auth/status` | Explicit local mode, or protected `anonymous`/`enrollment`/`reauthenticate`/`authenticated` state; validated-session email/expiry and enrollment requirements only |
| POST | `/api/auth/sign-in/email` | `{ email, password }` → `{ twoFactorRequired }` |
| POST | `/api/auth/sign-out` | `{}` → `{ ok: true }` only after successful current authentication-state revocation |
| POST | `/api/auth/two-factor/enable` | `{ password, setupKey? }` → `{ totpURI, backupCodes }`; selected restricted enrollment only |
| POST | `/api/auth/two-factor/verify-totp` | `{ code }` → `{ ok: true }`; enrollment still requires logout and fresh sign-in |
| POST | `/api/auth/two-factor/verify-backup-code` | `{ code }` → `{ ok: true }`; temporary login challenge only |
| POST | `/api/auth/two-factor/generate-backup-codes` | `{ password }` → `{ backupCodes }`; full MFA only |

Browser transport is cookies-only: no JSON session token. Auth responses are `no-store`; errors expose stable codes plus optional `retryAfter`/`retryAt`, never raw library objects. Auth POST bodies are strict bounded JSON. Protected application mutations also require JSON Content-Type, including otherwise bodyless POST/DELETE requests. Canonical Host and mutation Origin are validated; arbitrary forwarding headers confer no authority.

Protected local stdio MCP uses a private owner-only Unix HTTP socket with the same route/event registration. Server-owned request identity—not a header—identifies that existing OS-owner capability. Explicit `COGITATOR_URL` overrides never acquire it. This is not a remote-worker credential or isolation mechanism.

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
| GET | `/api/conversations?workspace_id=&agent_id=&include=all` | List metadata + title. `agent_id` = 1–1 only (`group_id IS NULL`). Omit group member sessions from bot resume-last |
| POST | `/api/conversations` | Spawn. Body: `{ workspace_id? }` + either `{ agent_id }` or ad hoc `{ provider, model, … }`, initial `prompt?`. If `workspace_id` omitted and `agent_id` set, use that preset’s `default_workspace_id`. If still null, `400` with a workspace-required code (UI picker then `PUT` preset) |
| GET | `/api/conversations/:id` | `{ conversation, live, streaming }`: details and snapshot, process presence, generation state read through the pool (`live` does not mean a turn is in progress) |
| GET | `/api/conversations/:id/events` | **SSE** — pi events (tokens, tool calls, status) |
| POST | `/api/conversations/:id/messages` | Send a message `{ text, images? }` |
| POST | `/api/conversations/:id/stop` | Interrupt the current turn |
| POST | `/api/conversations/:id/model` | Change the model during a session (native pi support) |
| DELETE | `/api/conversations/:id` | Close + remove from the pool (the `.jsonl` remains) |

## Groups (specified, not implemented — ADR-011)

| Method | Route | Description |
|---|---|
| GET | `/api/groups` | List `{ id, name, host_agent_id, member_ids, updated_at }` |
| POST | `/api/groups` | `{ name?, member_ids[2..6], host_agent_id?, workspace_id? }` — host default = first member; spawn one Conversation per member (`group_id` set) |
| GET | `/api/groups/:id` | Group + members + last messages |
| PATCH | `/api/groups/:id` | Rename, host, members (2–6), workspace |
| DELETE | `/api/groups/:id` | Drop bus rows; member conversations stay on disk (same as 1–1 DELETE) |
| GET | `/api/groups/:id/messages?after=` | Bus log page |
| POST | `/api/groups/:id/messages` | `{ text, images? }`. Parse `@slug`/`@name`; those members run. No mention → host only. Body is stored as `author=user` then injected into the target session(s) |
| GET | `/api/groups/:id/events` | **SSE** of bus messages + per-member tool/status (one stream, not N raw pi feeds) |
| POST | `/api/groups/:id/stop` | Interrupt running member turns |

Handoff: a member reply that `@` another member is stored on the bus and injected into that process (same as a user mention). Generative-UI replies stay on the member’s 1–1-style `POST /conversations/:id/messages` and are copied onto the bus as that agent’s message.

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
| GET | `/api/health` | `{ ok, version, pi_version, sessions_active, db }` — private in protected mode; use minimal `/api/status` for public liveness |
