# ADR-007 — Full-stack TypeScript, official RpcClient, SSE, pi package distribution

- Status: accepted
- Date: 2026-10-06

## Context

Stack choices for: local Node server, real-time web UI, communication with pi, distribution.

## Decision

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript throughout | pi's official `RpcClient` is in TS = no glue code; team of 1 |
| Server | Node ≥22, native HTTP (no heavy framework) | Same runtime as the pi extension; trivial SSE |
| UI | React + Vite (static build served by the server) | Ecosystem, fast iteration |
| Real-time | SSE (Server-Sent Events) | Proven model (pi-web-simple): streaming pi tokens → browser |
| Persistence | SQLite (ADR-006) | — |
| Distribution | **pi package**: `pi install npm:@ignitionai/cogitator`, `/cogitator` command that starts the server detached; standalone executable `npx @ignitionai/cogitator` | The target usage is the pi ecosystem |

## Packaging footprint (validated against pi 1.0.4 docs/packages.md)

- Explicit `pi` manifest: `"pi": { "extensions": ["./extensions"] }` + `pi-package` keyword (visibility in the pi.dev/packages gallery)
- **`@earendil-works/pi-coding-agent` in `peerDependencies: "*"`** — provided by the pi host, never in `dependencies` (otherwise a warning + duplicate classes: this was pi-web-simple's flaw)
- `bin` allowed: `cogitator` starts the standalone server; the `/cogitator` command (via `pi.registerCommand()`) spawns the server **detached** — the extension entry point stays minimal (I4)
- better-sqlite3 in `dependencies`: pi installs package dependencies during `pi install`
- Target installation: `pi install npm:@ignitionai/cogitator` (version pinning supported: `@x.y.z`)

## Consequences

+ One language, direct reuse of the pi API, native packaging for pi users
− The pi extension is loaded in every pi session: the entry point must stay minimal (register `/cogitator`, do not start a server in the host process)

## Rejected alternatives

- Python/FastAPI → glue code for the TS RpcClient, two languages
- WebSocket → overkill; the flow is primarily server → client
