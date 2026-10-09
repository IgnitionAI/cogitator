# ADR-006 — Single SQLite store

- Status: accepted
- Date: 2026-10-06

## Context

Persistence needs: presets, workspaces, conversations (metadata), cron tasks + history. Candidates: JSON files, SQLite.

## Decision

**SQLite** (`better-sqlite3`), a single file: `~/.cogitator/cogitator.db`. `json` columns via JSON1. Conversation transcripts are **not** in the database: they live in pi's `.jsonl` files (source of truth); cogitator stores only metadata + the spawn configuration snapshot.

## Consequences

+ Simple queries (recent runs, conversations by workspace), integrity, a single file to back up
+ Same choice as AionUi (proven precedent for this usage profile)
− Native better-sqlite3 dependency (prebuilt binaries, acceptable on the target macOS/Linux platforms)

## Rejected alternatives

- Multiple JSON files → cumbersome cron history queries, risk of partial writes
