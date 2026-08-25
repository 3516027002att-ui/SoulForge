export interface SqlMigration {
  id: number;
  name: string;
  sql: string;
  /**
   * 需要按「列不存在才加」语义添加的列。
   *
   * SQLite 没有 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，而迁移可能运行在
   * 已经有该列的既有库上（本仓库实测遇到过：一条迁移被删后重建，既有库里它
   * 加的列已存在，裸 ALTER 报 duplicate column）。执行器逐列检查后再决定。
   *
   * checksum 计算包含本字段，故改动它会改变 checksum —— 这是有意的：
   * 它和 sql 一样是迁移内容的一部分。
   */
  addColumns?: ReadonlyArray<{ table: string; column: string; definition: string }>;
  /**
   * 在 addColumns 之后执行的 SQL。
   *
   * 用于依赖新列的对象（如建在新列上的索引）：那些语句不能与主 sql 同批执行，
   * 因为主 sql 跑在加列之前。
   */
  sqlAfterColumns?: string;
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
  },
  {
    id: 7,
    name: 'v0_5_rag_evidence_chunks',
    sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rag_chunks (
  chunk_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  symbol_uri TEXT NOT NULL,
  family TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  numeric_ids_json TEXT NOT NULL,
  relative_path TEXT,
  resource_kind TEXT,
  confidence TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_workspace_family
  ON rag_chunks(workspace_id, family);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_workspace_source
  ON rag_chunks(workspace_id, source_uri);

CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`
  },
  {
    id: 8,
    name: 'v0_5_rag_chunks_trigram',
    sql: `
-- CJK 子串检索索引：unicode61 不切分中文，LIKE fallback 只覆盖整串。
-- trigram tokenizer（SQLite >= 3.34）把 title/body 切成 3 字符 gram，支持
-- 任意 ≥3 字符子串匹配（含中文）；1-2 字短词仍走 LIKE fallback。
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts_trigram USING fts5(
  chunk_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);
`
  },
  {
    id: 9,
    name: 'v0_5_rag_embeddings',
    sql: `
PRAGMA foreign_keys = ON;

-- chunk 级 embedding（float32 BLOB）。语料全量重建时整体替换；model 记录
-- 生成向量所用 embedding 模型 —— 查询向量必须用同一模型，检索侧按 model 过滤。
CREATE TABLE IF NOT EXISTS rag_embeddings (
  chunk_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES rag_chunks(chunk_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rag_embeddings_workspace_model
  ON rag_embeddings(workspace_id, model);
`
  },
  {
    id: 10,
    name: 'v0_5_rag_chunk_freshness',
    sql: 'PRAGMA foreign_keys = ON;',
    addColumns: [
      { table: 'rag_chunks', column: 'source_revision', definition: 'INTEGER' },
      { table: 'rag_chunks', column: 'source_hash', definition: 'TEXT' }
    ],
    sqlAfterColumns: `
CREATE INDEX IF NOT EXISTS idx_rag_chunks_workspace_source_hash
  ON rag_chunks(workspace_id, source_uri, source_hash);
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
    /**
     * 占位迁移，SQL 刻意为空。不要删。
     *
     * ── 它为什么存在 ──
     *
     * 本机实测（2026-08-09）：用户打开工作区时报
     * `SQLITE_SCHEMA_NEWER_THAN_APPLICATION`「数据库版本高于当前应用支持版本」。
     * 排查发现 `%APPDATA%/@soulforge/desktop/app.db` 的 user_version = 2，
     * schema_migrations 里有两条记录：
     *   1  v0_5_app_authority
     *   2  v0_5_app_ai_authority_and_retention
     * 而代码里 APP_DB_MIGRATIONS 只有 id 1。降级保护判断 2 > 1 遂拒绝打开——
     * 那道检查没做错，它正是为防止旧代码往新库里写。
     *
     * 错在别处：第 2 条迁移建的那些表（ai_conversations / ai_messages /
     * agent_steps / tool_calls / permission_grants / outbound_context_items /
     * app_agent_runs / trusted_signers / adaptation_packages）后来被合并进了
     * id 1 的 SQL，却没管已有数据库仍记着 user_version = 2。git 历史里搜不到
     * 这个迁移名，说明合并发生在它入库之前，于是所有既有 app.db 都变成了
     * 「版本过高」。
     *
     * 补回这条空迁移，让代码支持版本回到 2：既有库直接可开且数据全保留，
     * 新建库连续跑 1、2 后结果与只跑 1 相同（id 1 的 CREATE TABLE IF NOT
     * EXISTS 已建齐全部表）。
     *
     * 为什么不改成把表拆回 id 2：那会让**新建**库在 id 1 阶段缺表，而 id 1
     * 已经入库并被既有库执行过——拆分只对新库生效，两类库从此走上不同路径。
     * 空占位是唯一让两类库收敛到同一状态的改法。
     *
     * 126 个 workspace.db 实测全是 user_version = 6，与 SQLITE_MIGRATIONS 一致，
     * 不受此问题影响。
     *
     * ── SQL 为什么不是空的 ──
     *
     * 第一版打算写空占位（只为把版本抬回 2）。做结构比对后发现那会制造一个更
     * 隐蔽的缺陷：这条迁移当初建了 5 张表（app_settings / app_agent_runs /
     * agent_steps / tool_calls / outbound_context_items）、3 个索引，还给
     * ai_messages 加了 expires_at / redaction_summary / provider_response_id
     * 三列。空占位会让**既有库**正常（表都在）而**全新安装的库缺这 5 张表**——
     * 症状是新用户一用 AI 就崩，而老用户毫无察觉。
     *
     * 下面的 DDL 从既有库的 sqlite_master 导出后重写为 IF NOT EXISTS 形式，
     * 与实际结构逐字段对齐（已用结构比对验证）。ALTER TABLE 那三列走
     * addColumnIfMissing 而不是裸 ALTER：既有库里它们已存在，裸 ALTER 会报
     * duplicate column。
     */
    sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_app_agent_runs_conversation_created
  ON app_agent_runs(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run_created
  ON tool_calls(run_id, created_at);
`,
    /**
     * ai_messages 的三个附加列。
     *
     * 单独走 addColumns 而不是写进 sql：SQLite 没有
     * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，而既有库里这三列已存在，
     * 裸 ALTER 会以 duplicate column 失败。执行器按列是否存在逐个决定。
     *
     * idx_ai_messages_expires 依赖 expires_at，故也放在这里、加列之后建。
     */
    addColumns: [
      { table: 'ai_messages', column: 'expires_at', definition: 'TEXT' },
      { table: 'ai_messages', column: 'redaction_summary', definition: "TEXT NOT NULL DEFAULT '{}'" },
      { table: 'ai_messages', column: 'provider_response_id', definition: 'TEXT' }
    ],
    sqlAfterColumns: `
CREATE INDEX IF NOT EXISTS idx_ai_messages_expires
  ON ai_messages(expires_at);
`
  },
  {
    id: 3,
    name: 'provider_usage_history',
    sql: `
PRAGMA foreign_keys = ON;

-- Provider usage is intentionally independent from model_services: model
-- credentials/configuration live in the encrypted vault, while this table is
-- an audit-safe numeric ledger.  event_id makes retries/idempotent IPC replay
-- harmless and one row represents one actual provider HTTP/SSE request.
CREATE TABLE IF NOT EXISTS provider_usage_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  model TEXT NOT NULL,
  call_index INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_tokens INTEGER NOT NULL,
  context_source TEXT NOT NULL,
  provider_reported INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, call_index)
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_service_created
  ON provider_usage_events(service_id, created_at);
CREATE INDEX IF NOT EXISTS idx_provider_usage_session_call
  ON provider_usage_events(session_id, call_index);
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
