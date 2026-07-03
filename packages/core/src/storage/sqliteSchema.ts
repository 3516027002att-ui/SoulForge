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
