# Stack Decision Record — Cogitator

| Layer | Choice | Rationale | Rejected alternatives |
|---|---|---|---|
| Language | TypeScript | Official pi RpcClient in TS, team of 1 | Python (glue code), Go (slower iteration) |
| Server | Node ≥22, native HTTP | Same runtime as the pi extension | Hono/Express (unnecessary), FastAPI |
| UI | React + Vite, static build | Ecosystem, speed | HTMX (less capable for the agent editor) |
| Real-time | SSE | Server→client flow, proven | WebSocket (overkill) |
| Persistence | SQLite (`better-sqlite3`) `~/.cogitator/cogitator.db` | History queries, single file | Multiple JSON files |
| pi processes | Official `RpcClient`, pool of 1/session, 10 min idle recycling, max 8 | Proven model | Shell `pi -p` (no streaming or fine-grained control) |
| pi configuration | Read model from `models-store.json`/`auth.json`/`mcp.json` + atomic writes with backup | Single source of truth | Duplicate configuration in the store |
| Subagents | Generate herdr `.md` files (`~/.pi/agents/noo-*.md`) | Existing engine, CLI/UI consistency | In-house engine |
| Cron | In-process, busy-guard | Native history, UI notifications | launchd (output outside the UI) |
| Packaging | pi package `@ignitionai/cogitator` + standalone executable | Target = pi ecosystem | Electron (heavy, unnecessary) |
