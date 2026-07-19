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

`
  },
  {
    id: 3,
    name: 'v0_5_durable_transactions_and_inverse_history',
    sql: `
PRAGMA foreign_keys = ON;

ALTER TABLE patch_history ADD COLUMN transaction_id TEXT;
ALTER TABLE patch_history ADD COLUMN recovery_path TEXT;
ALTER TABLE patch_history ADD COLUMN recovery_reason TEXT;
ALTER TABLE patch_history ADD COLUMN inverse_of_op_id TEXT;
ALTER TABLE patch_history ADD COLUMN rollback_scope TEXT;

CREATE INDEX IF NOT EXISTS idx_patch_history_inverse
  ON patch_history(workspace_id, inverse_of_op_id);

CREATE TABLE IF NOT EXISTS transaction_journal (
  transaction_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transaction_journal_workspace_phase
  ON transaction_journal(workspace_id, phase);

CREATE TABLE IF NOT EXISTS resource_entry_changes (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  resource_uri TEXT NOT NULL,
  entry_uri TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  inverse_json TEXT NOT NULL,
  FOREIGN KEY (op_id) REFERENCES patch_history(op_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resource_entry_changes_op
  ON resource_entry_changes(op_id);

CREATE TABLE IF NOT EXISTS recovery_points (
  recovery_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  op_id TEXT,
  root_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  metadata_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_points_workspace_created
  ON recovery_points(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  op_id TEXT,
  transaction_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_events_workspace_created
  ON audit_events(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS legacy_imports (
  source_kind TEXT NOT NULL,
  source_path_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  backup_path TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_path_hash, content_hash)
);
`
  },
  {
    id: 4,
    name: 'v0_5_resource_graph_authority',
    sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS resource_graph_snapshots (
  workspace_id TEXT PRIMARY KEY,
  graph_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resource_nodes (
  node_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  resource_kind TEXT,
  overlay TEXT,
  label TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  confidence_json TEXT,
  provenance_json TEXT,
  diagnostics_json TEXT NOT NULL,
  content_hash TEXT,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_nodes_workspace_uri
  ON resource_nodes(workspace_id, uri);
CREATE INDEX IF NOT EXISTS idx_resource_nodes_workspace_kind
  ON resource_nodes(workspace_id, resource_kind, kind);

CREATE TABLE IF NOT EXISTS resource_edges (
  edge_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  uri TEXT,
  label TEXT,
  properties_json TEXT NOT NULL,
  confidence_json TEXT,
  provenance_json TEXT,
  diagnostics_json TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (from_id) REFERENCES resource_nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES resource_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resource_edges_from ON resource_edges(workspace_id, from_id);
CREATE INDEX IF NOT EXISTS idx_resource_edges_to ON resource_edges(workspace_id, to_id);
`
  },
  {
    id: 5,
    name: 'v0_5_fine_grained_rollback_target',
    sql: `
ALTER TABLE patch_history ADD COLUMN rollback_target_uri TEXT;
CREATE INDEX IF NOT EXISTS idx_patch_history_rollback_target
  ON patch_history(workspace_id, inverse_of_op_id, rollback_scope, rollback_target_uri);
`
  },
  {
    id: 6,
    name: 'v0_5_file_diagnostic_and_job_repositories',
    sql: `
ALTER TABLE files ADD COLUMN compound_extension TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN format_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE files ADD COLUMN format_label TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS background_jobs (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,
  progress_message TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_workspace_status
  ON background_jobs(workspace_id, status, created_at);
`
  }
];

export const APP_DB_MIGRATIONS: readonly SqlMigration[] = [
  {
    id: 1,
    name: 'v0_5_app_authority',
    sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS model_services (
  service_id TEXT PRIMARY KEY,
  service_kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_mode TEXT NOT NULL,
  model_name TEXT NOT NULL,
  credential_ciphertext BLOB,
  credential_key_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS permission_grants (
  grant_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (service_id) REFERENCES model_services(service_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_permission_grants_service
  ON permission_grants(service_id, revoked_at);

CREATE TABLE IF NOT EXISTS ai_conversations (
  conversation_id TEXT PRIMARY KEY,
  workspace_key TEXT,
  service_id TEXT,
  retention_mode TEXT NOT NULL DEFAULT 'thirty_days',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (service_id) REFERENCES model_services(service_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ai_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  body_text TEXT NOT NULL,
  tool_json TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created
  ON ai_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS adaptation_packages (
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  signer_key_id TEXT NOT NULL,
  signature BLOB NOT NULL,
  trust_state TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  enabled_at TEXT,
  PRIMARY KEY (package_id, version)
);

CREATE TABLE IF NOT EXISTS trusted_signers (
  key_id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  trust_source TEXT NOT NULL,
  trusted_at TEXT NOT NULL,
  revoked_at TEXT
);
`
  },
  {
    id: 2,
    name: 'v0_5_app_ai_authority_and_retention',
    sql: `
PRAGMA foreign_keys = ON;

ALTER TABLE ai_messages ADD COLUMN expires_at TEXT;
ALTER TABLE ai_messages ADD COLUMN redaction_summary TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_messages ADD COLUMN provider_response_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_messages_expires
  ON ai_messages(expires_at);

CREATE TABLE IF NOT EXISTS app_agent_runs (
  run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  workspace_key TEXT,
  permission_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  finish_reason TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  audit_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES model_services(service_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_app_agent_runs_conversation_created
  ON app_agent_runs(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS agent_steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES app_agent_runs(run_id) ON DELETE CASCADE,
  UNIQUE (run_id, step_index)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_index INTEGER,
  tool_name TEXT NOT NULL,
  permission TEXT NOT NULL,
  ok INTEGER NOT NULL,
  code TEXT,
  arguments_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES app_agent_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run_created
  ON tool_calls(run_id, created_at);

CREATE TABLE IF NOT EXISTS outbound_context_items (
  context_item_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  resource_uri TEXT,
  context_kind TEXT NOT NULL,
  content_hash TEXT,
  redaction_summary TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES app_agent_runs(run_id) ON DELETE CASCADE,
  UNIQUE (run_id, item_index)
);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`
  }
];

export function getLatestSchemaVersion(): number {
  return SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]?.id ?? 0;
}

export function getLatestAppSchemaVersion(): number {
  return APP_DB_MIGRATIONS[APP_DB_MIGRATIONS.length - 1]?.id ?? 0;
}

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
