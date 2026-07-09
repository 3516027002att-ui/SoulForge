export interface SqlMigration {
  id: number;
  name: string;
  sql: string;
}

/**
 * SQLite schema for SoulForge's persistent evidence index.
 *
 * This file intentionally has no SQLite driver dependency. The desktop main
 * process can apply these migrations with better-sqlite3, node:sqlite, or any
 * future adapter while core query semantics remain stable.
 */
export const SQLITE_MIGRATIONS: readonly SqlMigration[] = [
  {
    id: 1,
    name: 'initial_evidence_index',
    sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  game TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  source_uri TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  sha256 TEXT,
  parse_status TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_workspace_kind ON files(workspace_id, resource_kind);
CREATE INDEX IF NOT EXISTS idx_files_workspace_path ON files(workspace_id, relative_path);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  source_uri UNINDEXED,
  relative_path,
  resource_kind,
  extension
);

CREATE TABLE IF NOT EXISTS event_symbols (
  uri TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  map_id TEXT,
  event_id INTEGER NOT NULL,
  name TEXT,
  raw_json TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_symbols_workspace_event_id ON event_symbols(workspace_id, event_id);
CREATE INDEX IF NOT EXISTS idx_event_symbols_workspace_map ON event_symbols(workspace_id, map_id);
CREATE VIRTUAL TABLE IF NOT EXISTS event_text_fts USING fts5(
  uri UNINDEXED,
  event_id UNINDEXED,
  name,
  instructions_text
);

CREATE TABLE IF NOT EXISTS event_instructions (
  uri TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_uri TEXT NOT NULL,
  instruction_index INTEGER NOT NULL,
  name TEXT,
  category TEXT,
  args_json TEXT NOT NULL,
  raw_json TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (event_uri) REFERENCES event_symbols(uri) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_instructions_event ON event_instructions(event_uri, instruction_index);

CREATE TABLE IF NOT EXISTS map_entities (
  uri TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  map_id TEXT NOT NULL,
  entity_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT,
  position_json TEXT,
  rotation_json TEXT,
  raw_json TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_map_entities_workspace_entity_id ON map_entities(workspace_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_map_entities_workspace_map ON map_entities(workspace_id, map_id);

CREATE TABLE IF NOT EXISTS map_regions (
  uri TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  map_id TEXT NOT NULL,
  entity_id INTEGER,
  name TEXT NOT NULL,
  shape TEXT,
  position_json TEXT,
  rotation_json TEXT,
  size_json TEXT,
  raw_json TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_map_regions_workspace_entity_id ON map_regions(workspace_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_map_regions_workspace_map ON map_regions(workspace_id, map_id);

CREATE TABLE IF NOT EXISTS param_rows (
  uri TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  param_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  row_name TEXT,
  fields_json TEXT,
  raw_json TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_param_rows_workspace_param_row ON param_rows(workspace_id, param_name, row_id);
CREATE VIRTUAL TABLE IF NOT EXISTS param_rows_fts USING fts5(
  uri UNINDEXED,
  param_name,
  row_name,
  fields_text
);

CREATE TABLE IF NOT EXISTS param_fields (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  row_uri TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_type TEXT,
  value_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (row_uri) REFERENCES param_rows(uri) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_param_fields_row ON param_fields(row_uri);

CREATE TABLE IF NOT EXISTS text_entries (
  uri TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  category TEXT,
  text_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_text_entries_workspace_text_id ON text_entries(workspace_id, text_id);
CREATE VIRTUAL TABLE IF NOT EXISTS text_entries_fts USING fts5(uri UNINDEXED, category, text);

CREATE TABLE IF NOT EXISTS reference_edges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_uri TEXT NOT NULL,
  to_uri TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reference_edges_from ON reference_edges(workspace_id, from_uri);
CREATE INDEX IF NOT EXISTS idx_reference_edges_to ON reference_edges(workspace_id, to_uri);

CREATE TABLE IF NOT EXISTS operation_logs (
  op_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);
`
  },
  {
    id: 2,
    name: 'v0_5_patch_history_and_diagnostics',
    sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace_layers (
  workspace_id TEXT PRIMARY KEY,
  overlay_root TEXT NOT NULL,
  base_root TEXT,
  staging_root TEXT,
  base_missing INTEGER NOT NULL DEFAULT 1,
  opened_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS diagnostics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_uri TEXT,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL,
  suppressed INTEGER NOT NULL DEFAULT 0,
  resolved_by_op_id TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_diagnostics_workspace_code ON diagnostics(workspace_id, code);
CREATE INDEX IF NOT EXISTS idx_diagnostics_workspace_source ON diagnostics(workspace_id, source_uri);

CREATE TABLE IF NOT EXISTS patch_history (
  op_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  rolled_back_at TEXT,
  backup_root TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  graph_json TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_patch_history_workspace_created ON patch_history(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS file_operations (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  target_uri TEXT NOT NULL,
  target_path TEXT NOT NULL,
  relative_path TEXT,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  resource_kind TEXT,
  FOREIGN KEY (op_id) REFERENCES patch_history(op_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_operations_op ON file_operations(op_id);
CREATE INDEX IF NOT EXISTS idx_file_operations_target ON file_operations(workspace_id, target_uri);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  thinking TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT,
  plan_json TEXT,
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_created ON agent_runs(workspace_id, created_at);

-- Extend operation_logs for v0.5 commit/rollback timestamps when present.
ALTER TABLE operation_logs ADD COLUMN committed_at TEXT;
ALTER TABLE operation_logs ADD COLUMN rolled_back_at TEXT;
ALTER TABLE operation_logs ADD COLUMN backup_root TEXT;
ALTER TABLE operation_logs ADD COLUMN graph_json TEXT;
`
  }
];

export function getLatestSchemaVersion(): number {
  return SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]?.id ?? 0;
}

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
