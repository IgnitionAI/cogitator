# ADR-002 — MCP via registerMcpServer (built-in support), not pi-mcp-adapter

- Status: accepted
- Date: 2026-10-06

## Context

Agent presets carry a list of MCP servers. Two possible mechanisms are available to the target user: pi's **built-in** MCP support (`mcp.json` + `pi.registerMcpServer()` API), or the `pi-mcp-adapter` extension (which *replaces* built-in support and provides `--mcp-config`). The target user has pi-mcp-adapter installed.

## Decision

Cogitator uses the **built-in API** `pi.registerMcpServer(name, config)` at `session_start` for each session it spawns, with the preset's entries (`mcpServers` structure). The user-level MCP server (`~/.pi/agent/mcp.json`) remains managed through a dedicated configuration screen.

## Consequences

+ No dependency on having pi-mcp-adapter installed; official, stable structure
+ Exact per-agent MCP configuration, no leakage between presets
− If the user keeps pi-mcp-adapter, it replaces built-in support: the combination must be detected at startup and reported in the UI (health check)

## Rejected alternatives

- `--mcp-config <generated file>` (pi-mcp-adapter flag) → couples cogitator to a third-party extension that is not required
