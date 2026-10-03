import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { openAppDatabase, openMigratedDatabase, openWorkspaceDatabase } from './sqliteDatabase.js';
import { APP_DB_MIGRATIONS, SQLITE_MIGRATIONS } from './sqliteSchema.js';
import { SqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';

const workspaceTables = ['event_symbols','event_instructions','event_text_fts','map_entities','map_regions','param_rows','param_fields','param_rows_fts','text_entries','text_entries_fts','operation_logs','workspace_layers','agent_runs','resource_nodes','resource_edges','resource_graph_snapshots'];
const appTables = ['model_services','permission_grants','ai_conversations','ai_messages','adaptation_packages','trusted_signers','app_settings','app_agent_runs','agent_steps','tool_calls','outbound_context_items'];

test('retirement upgrades a workspace copy with a recoverable consistent pre-upgrade snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-table-retirement-'));
  const path = join(root, 'workspace.db');
  let database: BetterSqlite3.Database | undefined;
  try {
    database = openMigratedDatabase(path, SQLITE_MIGRATIONS.filter(migration => migration.id <= 15));
    database.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('test', root, 'sekiro', 'now', 'now');
    database.prepare('INSERT INTO operation_logs(op_id,workspace_id,title,author,mode,status,created_at) VALUES (?,?,?,?,?,?,?)').run('legacy','test','preserved','user','normal','committed','now');
    database.close();
    database = openWorkspaceDatabase(path);
    for (const table of workspaceTables) assert.equal(database.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table), undefined, `${table} must be retired`);
    const snapshots = (await readdir(root)).filter(name => name.includes('.pre-schema-'));
    assert.equal(snapshots.length, 1, 'retirement must preserve an upgrade snapshot');
    const snapshot = new BetterSqlite3(join(root, snapshots[0]!), { readonly: true });
    try { assert.equal(snapshot.pragma('integrity_check', { simple: true }), 'ok'); assert.equal((snapshot.prepare('SELECT title FROM operation_logs').get() as { title: string }).title, 'preserved'); }
    finally { snapshot.close(); }
    const store = new SqliteOperationLogStore(database, 'test');
    await store.record({ opId: 'new-op', workspaceId: 'test', title: 'new write', author: 'user', mode: 'normal', status: 'committed', createdAt: 'now', files: [], diagnostics: [] });
    assert.equal((await store.get('new-op'))?.status, 'committed');
    database.close(); database = openWorkspaceDatabase(path);
    assert.equal((await new SqliteOperationLogStore(database, 'test').get('new-op'))?.title, 'new write');
    assert.equal((await readdir(root)).filter(name => name.includes('.pre-schema-')).length, 1);
    assert.throws(() => openMigratedDatabase(path, SQLITE_MIGRATIONS.filter(migration => migration.id <= 15)), error => (error as { code?: string }).code === 'SQLITE_SCHEMA_NEWER_THAN_APPLICATION');
  } finally { database?.close(); await rm(root, { recursive: true, force: true }); }
});

test('app retirement preserves archived settings and keeps provider usage operational', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-app-retirement-')); const path = join(root, 'app.db');
  let database: BetterSqlite3.Database | undefined;
  try {
    database = openMigratedDatabase(path, APP_DB_MIGRATIONS.filter(migration => migration.id <= 3));
    database.prepare('INSERT INTO app_settings(setting_key,value_json,updated_at) VALUES (?,?,?)').run('legacy','{"safe":true}','now');
    database.close(); database = openAppDatabase(path);
    for (const table of appTables) assert.equal(database.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table), undefined, `${table} must be retired`);
    assert.ok(database.prepare('SELECT name FROM sqlite_master WHERE name=?').get('provider_usage_events'));
    const snapshots = (await readdir(root)).filter(name => name.includes('.pre-schema-')); assert.equal(snapshots.length, 1);
    const snapshot = new BetterSqlite3(join(root, snapshots[0]!), { readonly: true });
    try { assert.equal((snapshot.prepare('SELECT value_json FROM app_settings').get() as { value_json: string }).value_json, '{"safe":true}'); } finally { snapshot.close(); }
  } finally { database?.close(); await rm(root, { recursive: true, force: true }); }
});
