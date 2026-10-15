# ADR-006 — Single SQLite store

- Status: accepted
- Date: 2026-10-06

## Context

Persistence needs: presets, workspaces, conversations (metadata), cron tasks + history. Candidates: JSON files, SQLite.

## Decision

**SQLite** (`better-sqlite3`), a single file: `~/.cogitator/cogitator.db`. `json` columns via JSON1. Conversation transcripts are **not** in the database: they live in pi's `.jsonl` files (source of truth); cogitator stores only metadata + the spawn configuration snapshot.

## Scope clarification — 2026-10-10

“Single store” applies to the application catalog above. [ADR-009](ADR-009-native-owner-auth.md) adds a separate private `auth/auth.sqlite` for library authentication state and application authorization policy; `owner-lock.sqlite` is an exclusive runtime/administration lock, not a second catalog. Neither contains classic transcripts. A complete protected installation's backup also needs the auth secret/configuration and the other application/pi files; the catalog alone is insufficient.

## Amendment — Durable-owned transcripts (I5, 2026-10-11, ticket #15 / Plan 0002 §6)

New conversations may be created with a frozen `runtime_kind = 'durable'` (Plan 0002 §6, ADR-008 D2/D3/D4). A durable mission's transcript, task checkpoints, approvals/effect records and frozen mission profile are **owned by the Pi Durable runtime storage** (`~/.cogitator/durable/<conversationId>/`, SQLite in FULL synchronous mode under an OS-exclusive runtime lease) — **not** in this catalog and **not** in pi `.jsonl` files. The catalog keeps only conversation metadata and configuration references (including the frozen `runtime_kind`); no transcript data is duplicated into the catalog, and Durable JSONL/entries are never treated as pi-session JSONL. Classic conversations are unchanged: their transcripts remain pi `.jsonl` files (I5 original). Conversations never switch runtime kind after creation.

## Consequences

+ Simple queries (recent runs, conversations by workspace), integrity, a single catalog file to back up
+ Same choice as AionUi (proven precedent for this usage profile)
− Native better-sqlite3 dependency (prebuilt binaries, acceptable on the target macOS/Linux platforms)

## Rejected alternatives

- Multiple JSON files → cumbersome cron history queries, risk of partial writes
