# ADR-003 — Directory-based workspaces

- Status: accepted
- Date: 2026-10-06

## Context

A workspace can be a logical grouping (specific to cogitator) or a filesystem directory. pi's native model is cwd-bound: sessions, project skills, project settings and MCP approvals are attached to the working directory.

## Decision

A workspace = **an existing directory on disk** (unique) + cogitator metadata (name, default agent). Cogitator does not duplicate pi's discovery mechanism; it relies on it.

## Consequences

+ A workspace's sessions, skills and project configuration work natively in pi (including the CLI)
+ Simple server-side file picker, no mapping to maintain
− No "virtual" workspace detached from the filesystem (not requested)

## Rejected alternatives

- Purely logical workspaces → needlessly reimplements pi's cwd discovery
