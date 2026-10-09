# AS-IS — Cogitator (greenfield baseline)

Date: 2026-10-06

## Status

**M0 (skeleton) and M1 (registry + agents) completed on 2026-10-06** — branch `dev`.

- **M0**: native HTTP server (health + placeholder), SQLite v1 schema, pi `/cogitator` extension (detached spawn). Verified: exit criteria + checklist items 1, 10.
- **M1**: pi read model (providers + authentication status via `pi auth check`, scanned skills, `mcp.json`), provider CRUD (atomic models.json/auth.json + backup), AgentPreset CRUD + validation, Apply → herdr definitions `noo-*.md` (O1/O2), pi-mcp-adapter detection in health. 13 tests passing; live E2E validated (creation of an openai/gpt-5.4 preset + deepseek subagent, validate returned 0 errors, correct `.md`, clean cleanup). Checklist items 5, 6 passing.
- **M2**: `PiPool` (lazy spawn via injectable factory, cap of 8 with eviction of the oldest non-streaming process via `getState().isStreaming`, 10 min idle recycling, `--session` for resume), flags materialized in **space-separated form** (pi rejects `--flag=valeur`), full conversation routes (CRUD, messages, stop→abort, model switch, per-conversation SSE), frozen `spawn_args` snapshot (O6), v2 migration (nullable session_file + spawn_args, FK off during migration). 23 tests passing; **live E2E: real pi process (deepseek-flash) spawned by the API, 2 messages, exact responses streamed over SSE** (`agent_start → message_update → agent_settled`). Checklist items 1, 2, 8, 9 passing.
- **M3**: workspace CRUD (existing dir + canonicalized with `realpathSync` — unique dir invariant, macOS `/tmp` symlink), name derived from the directory, default agent (validated FK), deletion → orphaned conversations (SET NULL), server-side file picker `GET /api/fs/browse` (directories first, hidden entries excluded), default agent inherited at conversation creation. 31 tests passing. Checklist item 4 passing.
- **M4**: MCP transport via environment variables — the preset's `mcp_servers` in the frozen snapshot → encoded in `COGITATOR_MCP` → the extension registers them at `session_start` via `pi.registerMcpServer` (built-in support connects; pi-mcp-adapter coexisted without blocking, verified live). Filtering encode/decode (name + command|url required). Custom stdio MCP fixture (`test/fixtures/echo-mcp-server.mjs`). 37 tests passing; **live E2E: preset with echo server → conversation → the LLM actually called the tool (`ECHO: salut-cogitator`)**. Checklist item 3 passing.
- **M5**: `CronService` (`cron-parser` v5) — 30 s tick, validated 5/6-field expressions, skip|queue|kill busy-guard (in-process guard + 'running' run in the database), catchup (1 catch-up run; otherwise cursor advanced without execution), manual trigger (`POST /:id/run` 202), runs recorded in all cases (O3: ok/error/timeout/skipped), dedicated session per task (append_session resumes the last session via `--session`; the cron conversation is a transient row deleted at the end of the run — frees up the UNIQUE session_file), `cron_run_started/finished` notifications on global SSE `GET /api/events`. 45 tests passing; **live E2E: manually triggered task → real pi → `CRON-RUN-OK`, successful run recorded with its session**. Checklist item 7 passing.
- **M6c — Skill import**: `POST /api/skills/import` (GitHub URL → codeload main/master tarball → extraction with system tar — ponytail: no npm dependency; local path also supported) → copy SKILL.md directories to `~/.agents/skills` (skip by name, optional overwrite, path-traversal sanitization, scan depth ≤ 2). MCP tool `cogitator_import_skills` + UI modal (Agents). 57 tests; **live E2E: “Importe les skills de badlogic/pi-skills” (import the skills from badlogic/pi-skills) sent to Majordome → 8 skills actually imported and listed**.**
- **M6b — Majordome (operator agent)**: embedded MCP server (`src/mcp-server.ts`, MCP SDK, 17 tools = the entire API); **Majordome** preset seeded at startup if there are no agents (provider/model taken from pi defaults, cogitator MCP attached); **global default agent** (`is_default` column, v3 migration, transactional uniqueness, `POST /api/agents/:id/default` route); conversation resolution: explicit > workspace > global default. UI: ★ badge + "Définir défaut" (set as default) button. 51 tests passing; **live E2E: conversation with nothing specified → Majordome → natural-language request "crée un agent Veille RAG…" (create a Veille RAG agent…) → real MCP calls (create + validate) → agent created and validated, report in French.**
- **M6**: React+Vite UI (6 screens: Conversations with SSE streaming chat + `.jsonl` history, Workspaces + file picker, full Agents editor with validation + Apply, Providers, Cron with real-time runs, Settings with user-level MCP JSON). `GET /:id/history` (.jsonl reading, I5). Static server with upward search for `web/dist` (dev `src/` ≠ prod `dist/src/`) + SPA fallback. `react`/`vite` in devDependencies (deliverable = static build). 45/45 tests; UI verified live (index + bundle + fallback). **npm publication pending: authentication expired (`npm login` required).**

Next: M2 (PiProcessPool + conversations).

## Target development environment

- Developer's machine: macOS, Node ≥22 (Homebrew node 26), pi 1.0.4 (global bun)
- pi installed with extensions: herdr, pi-subagents, ponytail, context-mode, openwiki, pi-web-access, pi-mcp-adapter, rpiv-todo
- Configured providers: kimi-coding (OAuth), openai (OAuth), xai (OAuth), deepseek (api_key)
- ~140 skills available in `~/.agents/skills` + `~/.pi/agent/skills`

## Identified concerns

1. `pi-mcp-adapter` replaces built-in MCP support → detection at cogitator startup + UI warning (ADR-002)
2. The "agent" model does not exist natively in pi → cogitator materializes it as flags (ADR-001); the concept is specific to cogitator and documented
3. Cron depends on the server's lifetime (ADR-004) — reassess in v2 if 24/7 operation is needed

## Next step

[`plans/active/0001-mvp.md`](plans/active/0001-mvp.md) — M0 (skeleton) is the entry point.
