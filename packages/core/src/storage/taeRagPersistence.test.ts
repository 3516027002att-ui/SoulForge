import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RagChunk } from '@soulforge/shared';
import type { SqliteDatabase } from './sqliteDatabase.js';
import { SQLITE_MIGRATIONS } from './sqliteSchema.js';
import { WorkspaceDataRepository } from './workspaceDataRepository.js';

// Exercise the production repository against an actual durable SQLite file.
// This narrow test uses Node's driver to isolate native-addon ABI availability.
function open(path: string) {
  const db = new DatabaseSync(path);
  const adapter = {
    prepare: (sql: string) => db.prepare(sql),
    transaction: (body: () => void) => ({ immediate() { db.exec('BEGIN IMMEDIATE'); try { body(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } } })
  } as unknown as SqliteDatabase;
  return { db, repository: new WorkspaceDataRepository(adapter, 'tae-persist') };
}

function initialize(db: DatabaseSync) {
  for (const migration of SQLITE_MIGRATIONS) {
    db.exec(migration.sql);
    for (const column of migration.addColumns ?? []) {
      const columns = db.prepare(`PRAGMA table_info(${column.table})`).all();
      if (!columns.some(c => c.name === column.column)) db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.column} ${column.definition}`);
    }
    if (migration.sqlAfterColumns) db.exec(migration.sqlAfterColumns);
  }
  db.prepare('INSERT INTO workspaces(workspace_id,root_path,game,created_at,updated_at) VALUES(?,?,?,?,?)').run('tae-persist','/fixture','sekiro','test','test');
}

test('native action counts and partial state survive SQLite restart without borrowing another source identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-persist-')); const path = join(root, 'workspace.db');
  let current = open(path);
  try {
    initialize(current.db);
    const chunk: RagChunk = { chunkId: 'rag:tae_event:v2:fixture', workspaceId: 'tae-persist', sourceUri: 'file://chr/c0000.tae', symbolUri: 'action://c0000/A400000/e0', family: 'tae_event', title: 'native event', body: 'native evidence', numericIds: [400000], contentHash: 'body', sourceHash: 'leaf-A', outerFileHash: 'outer-A', taeActionEventCount: 240, taeActionEventsComplete: false };
    current.repository.replaceRagChunks([chunk]); current.db.close(); current = open(path);
    let loaded = current.repository.loadRagChunks()[0]!;
    assert.equal(loaded.taeActionEventCount, 240); assert.equal(loaded.taeActionEventsComplete, false);
    current.repository.mergeRagChunks([{ ...chunk, taeActionEventCount: 241 }]);
    assert.equal(current.repository.loadRagChunks()[0]?.taeActionEventCount, 241, 'metadata-only upsert is persisted');
    current.repository.mergeRagChunkDelta({ sourceUri: chunk.sourceUri, upserts: [{ ...chunk, taeActionEventCount: 242 }], deletedChunkIds: [] });
    assert.equal(current.repository.loadRagChunks()[0]?.taeActionEventCount, 242, 'bounded delta retains native completeness metadata');
    current.db.prepare('UPDATE rag_chunks SET outer_file_hash=? WHERE chunk_id=?').run('outer-B', chunk.chunkId);
    loaded = current.repository.loadRagChunks()[0]!;
    assert.equal(loaded.taeActionEventCount, undefined, 'source-mismatched metadata cannot survive hydration');
    assert.equal(loaded.taeActionEventsComplete, undefined);
  } finally { current.db.close(); await rm(root, { recursive: true, force: true }); }
});
