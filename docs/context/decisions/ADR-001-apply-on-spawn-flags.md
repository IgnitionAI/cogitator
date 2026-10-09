# ADR-001 — Apply-on-spawn via native pi flags

- Status: accepted
- Date: 2026-10-06

## Context

An agent's configuration (provider, model, thinking, skills, prompt, tools, MCP) must apply to pi sessions. pi cannot be reconfigured on the fly: it reads its configuration at process startup and exposes no reconfiguration RPC (pi-web-simple ran into this by writing directly to `settings.json`/`auth.json`).

## Decision

Each conversation is spawned with **native CLI flags** materialized from the preset:

- `--model <provider>/<id>:<thinking>`
- `--append-system-prompt <file>`
- `--no-skills` + repeated `--skill <path>` (exact skills, not global discovery)
- `--tools` / `--exclude-tools`
- MCP: `pi.registerMcpServer()` by the extension at `session_start`

An open session **keeps its configuration frozen**; preset changes affect only subsequent spawns.

## Consequences

+ Predictable, no uncontrolled mutation of ongoing sessions, no files written to workspaces
+ Benefits from pi improvements (new flags = new agent capabilities)
− An ongoing session does not see preset changes (intended behavior, documented in the UI)

## Rejected alternatives

- Write to global `settings.json` / `auth.json` → even pi-web-simple ran into trouble with this; risk of corruption; no notion of presets
- Generate a temporary project directory per agent → unnecessary since pi 1.0.4 exposes repeatable `--skill`
