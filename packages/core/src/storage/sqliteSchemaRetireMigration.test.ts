import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyMigrations, openWorkspaceDatabase } from './sqliteDatabase.js';
import { SQLITE_MIGRATIONS } from './sqliteSchema.js';

/**
 * #41 删表迁移：只影响"旧版本建过、当前代码不再用"的库。
 *
 * 这里不构造历史 schema（那要冻结 15 条迁移），而是反过来做：在当前库上手工塞回
 * 一张遗留在旧库里的表，然后让 id=16 这条迁移重跑，断言它被删掉。这样测试验证的是
 * 迁移本身的行为，而不是某一份历史 schema 的快照。
 */

const RETIRED_TABLES = [
  'adaptation_packages',
  'agent_runs',
  'agent_steps',
  'ai_conversations',
  'ai_messages',
  'app_agent_runs',
  'event_instructions',
  'event_symbols',
  'event_text_fts',
  'map_entities',
  'map_regions',
  'model_services',
  'operation_logs',
  'outbound_context_items',
  'param_fields',
  'param_rows',
  'param_rows_fts',
  'permission_grants',
  'text_entries_fts',
  'tool_calls',
  'trusted_signers',
  'workspace_layers'
] as const;

const RETAINED_TABLES = [
  'resource_nodes',
  'resource_edges',
  'resource_graph_snapshots',
  'workspaces',
  'patch_history',
  'rag_chunks'
] as const;

function withDatabase(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'sf-retire-migration-'));
  try {
    run(join(directory, 'workspace.db'));
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function tableExists(database: ReturnType<typeof openWorkspaceDatabase>, table: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present?: number } | undefined;
  return row?.present === 1;
}

describe('retire_unread_tables migration', () => {
  it('新库上不创建任何一张待退役表', () => {
    withDatabase((path) => {
      const database = openWorkspaceDatabase(path);
      try {
        for (const table of RETIRED_TABLES) {
          assert.equal(tableExists(database, table), false, `${table} 不应出现在新库里`);
        }
      } finally {
        database.close();
      }
    });
  });

  it('删掉旧库遗留的待退役表，且不碰仍在使用的表', () => {
    withDatabase((path) => {
      const database = openWorkspaceDatabase(path);
      try {
        // 模拟旧库：塞回几张遗留表，并把 id=16 记为未执行。
        database.exec(`
CREATE TABLE agent_runs (id TEXT PRIMARY KEY);
CREATE TABLE param_rows (id INTEGER);
CREATE TABLE tool_calls (id TEXT);
DELETE FROM schema_migrations WHERE id = 16;
`);
        applyMigrations(database, SQLITE_MIGRATIONS);
        for (const table of ['agent_runs', 'param_rows', 'tool_calls']) {
          assert.equal(tableExists(database, table), false, `遗留表 ${table} 必须被删掉`);
        }
        for (const table of RETAINED_TABLES) {
          assert.equal(tableExists(database, table), true, `${table} 不在退役清单里，不能被删`);
        }
      } finally {
        database.close();
      }
    });
  });

  it('重复执行是幂等的（新库上 DROP IF EXISTS 是空操作）', () => {
    withDatabase((path) => {
      const database = openWorkspaceDatabase(path);
      try {
        database.exec('DELETE FROM schema_migrations WHERE id = 16');
        applyMigrations(database, SQLITE_MIGRATIONS);
        database.exec('DELETE FROM schema_migrations WHERE id = 16');
        applyMigrations(database, SQLITE_MIGRATIONS);
        assert.equal(tableExists(database, 'patch_history'), true);
      } finally {
        database.close();
      }
    });
  });
});
