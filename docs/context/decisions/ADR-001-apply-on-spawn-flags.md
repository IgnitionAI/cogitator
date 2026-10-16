# ADR-001 — Apply-on-spawn via native pi flags

- Status: accepted
- Date: 2026-10-06

## Context

An agent's configuration (provider, model, thinking, skills, prompt, tools, MCP) must apply to pi sessions. Startup flags remain the configuration boundary for skills, prompt, tools and MCP. Correction (2026-10-16, #21): pi does expose session-scoped model and thinking RPC setters; the original claim that no reconfiguration RPC exists was too broad. These setters do not require writes to global `settings.json` or `auth.json`.

## Decision

Each conversation is spawned with **native CLI flags** materialized from the preset:

- `--model <provider>/<id>:<thinking>`
- `--append-system-prompt <file>`
- `--no-skills` + repeated `--skill <path>` (exact skills, not global discovery)
- `--tools` / `--exclude-tools`
- MCP: `pi.registerMcpServer()` by the extension at `session_start`

Preset changes affect only **new conversations**, not existing snapshots or their later process respawns. Amendment (2026-10-16, Plan 0005 / #21): the owner may explicitly override provider/model/thinking for a classic conversation at a settled response boundary. The runtime's verified effective tuple is persisted in that conversation's snapshot for resume. Updating bot defaults is a separate explicit scope and never propagates to sibling conversations. Skills, prompt, tools and MCP remain frozen. Durable missions are excluded and keep their entire frozen profile.

## Consequences

+ Predictable, no uncontrolled mutation of ongoing sessions, no files written to workspaces
+ Benefits from pi improvements (new flags = new agent capabilities)
− An ongoing session does not see preset changes (intended behavior, documented in the UI)

## Rejected alternatives

- Write to global `settings.json` / `auth.json` → even pi-web-simple ran into trouble with this; risk of corruption; no notion of presets
- Generate a temporary project directory per agent → unnecessary since pi 1.0.4 exposes repeatable `--skill`
