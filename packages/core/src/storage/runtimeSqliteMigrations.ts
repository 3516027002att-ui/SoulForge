import {
  APP_DB_MIGRATIONS,
  SQLITE_MIGRATIONS,
  type SqlMigration
} from './sqliteSchema.js';

const WORKSPACE_RUNTIME_MIGRATION: SqlMigration = {
  id: 7,
  name: 'v0_5_runtime_launch_session_authority',
  sql: `
CREATE TABLE IF NOT EXISTS runtime_launch_sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_path TEXT NOT NULL,
  operation_id TEXT,
  related_operation_id TEXT,
  verification_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  pid INTEGER,
  started_at TEXT NOT NULL,
  exited_at TEXT,
  exit_code INTEGER,
  exit_signal TEXT,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  output_truncated INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_launch_sessions_workspace_started
  ON runtime_launch_sessions(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_launch_sessions_workspace_operation
  ON runtime_launch_sessions(workspace_id, operation_id, related_operation_id);
`
};

const WORKSPACE_RUNTIME_VERIFICATION_MIGRATION: SqlMigration = {
  id: 8,
  name: 'v0_5_runtime_verification_evidence_authority',
  sql: `
CREATE TABLE IF NOT EXISTS runtime_verification_evidence (
  evidence_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES runtime_launch_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_verification_evidence_session_created
  ON runtime_verification_evidence(workspace_id, session_id, created_at, evidence_id);
`
};

const APP_RUNTIME_MIGRATION: SqlMigration = {
  id: 2,
  name: 'v0_5_runtime_adapter_settings_authority',
  sql: `
CREATE TABLE IF NOT EXISTS runtime_adapter_settings (
  adapter_id TEXT PRIMARY KEY,
  executable_path TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`
};

registerMigration(SQLITE_MIGRATIONS, WORKSPACE_RUNTIME_MIGRATION, 'workspace.db');
registerMigration(
  SQLITE_MIGRATIONS,
  WORKSPACE_RUNTIME_VERIFICATION_MIGRATION,
  'workspace.db'
);
registerMigration(APP_DB_MIGRATIONS, APP_RUNTIME_MIGRATION, 'app.db');

function registerMigration(
  migrations: readonly SqlMigration[],
  migration: SqlMigration,
  databaseLabel: string
): void {
  const mutable = migrations as SqlMigration[];
  const existing = mutable.find((item) => item.id === migration.id);
  if (existing) {
    if (existing.name !== migration.name || existing.sql !== migration.sql) {
      throw new Error(`${databaseLabel} migration id ${migration.id} is already occupied.`);
    }
    return;
  }
  const expectedId = mutable.length + 1;
  if (migration.id !== expectedId) {
    throw new Error(
      `${databaseLabel} runtime migration must be contiguous: expected ${expectedId}, got ${migration.id}.`
    );
  }
  mutable.push(migration);
}
