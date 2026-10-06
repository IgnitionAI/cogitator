import Database from "better-sqlite3";

// Schéma courant (v2) — conversation.session_file devient nullable et un snapshot
// spawn_args (JSON du SpawnConfig figé, O6) est ajouté.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS agent_preset (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  tools_allowlist TEXT,
  mcp_servers TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subagent_setup (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent_preset(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  mcp_servers TEXT NOT NULL DEFAULT '[]',
  UNIQUE (agent_id, name)
);

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  dir TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  default_agent_id TEXT REFERENCES agent_preset(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent_preset(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT,
  session_file TEXT UNIQUE,
  spawn_args TEXT NOT NULL DEFAULT '{}',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cron_task (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  prompt TEXT NOT NULL,
  agent_id TEXT REFERENCES agent_preset(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  output_policy TEXT NOT NULL DEFAULT 'append_session',
  busy_policy TEXT NOT NULL DEFAULT 'skip',
  catchup INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cron_run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES cron_task(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  session_file TEXT,
  error TEXT
);
`;

// v1 → v2 : rebuild de conversation (SQLite ne permet pas de lever un NOT NULL)
const MIGRATE_V1_TO_V2 = `
CREATE TABLE conversation_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent_preset(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT,
  session_file TEXT UNIQUE,
  spawn_args TEXT NOT NULL DEFAULT '{}',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO conversation_v2 (id, workspace_id, agent_id, provider, model, thinking, session_file, title, status, created_at, updated_at)
  SELECT id, workspace_id, agent_id, provider, model, thinking, session_file, title, status, created_at, updated_at FROM conversation;
DROP TABLE conversation;
ALTER TABLE conversation_v2 RENAME TO conversation;
`;

export type Db = Database.Database;

export function openDb(dbPath: string): { db: Db; version: number } {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < 1) {
    db.exec(SCHEMA_V2);
    db.pragma("user_version = 2");
    return { db, version: 2 };
  }
  if (version < 2) {
    // FK OFF pendant la migration (pratique SQLite standard ; les parents peuvent être créés plus tard)
    db.pragma("foreign_keys = OFF");
    db.exec(MIGRATE_V1_TO_V2);
    db.pragma("foreign_keys = ON");
    db.pragma("user_version = 2");
  }
  return { db, version: 2 };
}
