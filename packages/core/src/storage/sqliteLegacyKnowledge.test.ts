import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, migrationChecksum, openMigratedDatabase } from './sqliteDatabase.js';
import { SQLITE_MIGRATIONS } from './sqliteSchema.js';
import { SqliteKnowledgeStorePersistence } from '../knowledge/sqliteKnowledgeStore.js';

// Literal historical migration from e32edad1, not the converter's own schema.
const legacy14 = { id: 14, name: 'v0_9_knowledge_store', sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_generations (
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  parent_generation TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, generation_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_current (
  workspace_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, generation_id)
    REFERENCES knowledge_generations(workspace_id, generation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_generations_workspace_created
  ON knowledge_generations(workspace_id, created_at);
` };
const migrations = SQLITE_MIGRATIONS.filter(item => item.id <= 14);
const historical = [...migrations.slice(0, 13), legacy14];
const body = 'durable historical knowledge';
const hash = createHash('sha256').update(body).digest('hex');
const scope = { gameProfile: 'sekiro', version: '1.6', visibility: 'project', workspaceId: 'test' };
const snapshot = {
  current: 'gen-1',
  generations: [
    { generationId: 'gen-0', parentGeneration: null, schemaVersion: 'knowledge-v1', createdAt: 'epoch', pages: {}, claims: {}, sourceRevisions: {} },
    { generationId: 'gen-1', parentGeneration: 'gen-0', schemaVersion: 'knowledge-v1', createdAt: 'now',
      pages: { page: { pageId: 'page', path: 'test.md', body, contentHash: hash, revision: 1, scope, claims: ['claim'] } },
      claims: { claim: { claimId: 'claim', scope, value: 42, extension: { preserved: true } } }, sourceRevisions: { source: 'sha256' } }
  ], blobs: { [hash]: body }
};
async function fixture(run: (db: Database.Database, root: string, path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sf-legacy-knowledge-')), path = join(root, 'workspace.db');
  const db = openMigratedDatabase(path, historical);
  try {
    assert.equal(migrationChecksum(legacy14), '43ee85272d692befe29a49b03eb9594d4f7bd9ce5ddf5b88bb921467c00a8cd9');
    db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)').run('test', root, 'sekiro', 'now', 'now');
    for (const generation of snapshot.generations) db.prepare('INSERT INTO knowledge_generations VALUES (?,?,?,?,?,?)')
      .run('test', generation.generationId, generation.parentGeneration, generation.schemaVersion, generation.createdAt, JSON.stringify(snapshot));
    db.prepare('INSERT INTO knowledge_current VALUES (?,?,?)').run('test', snapshot.current, 'now');
    await run(db, root, path);
  } finally { if (db.open) db.close(); await rm(root, { recursive: true, force: true }); }
}

test('known v14 converts nonempty generations/pages/claims/blobs, with backup and stable reopen', async () => fixture(async (db, root, path) => {
  applyMigrations(db, migrations);
  const expected = { ...snapshot, schemaVersion: 'knowledge-v1' };
  assert.deepEqual(new SqliteKnowledgeStorePersistence(db, { workspaceId: 'test', ensureWorkspaceRow: false }).load(), expected);
  assert.equal((db.prepare('SELECT checksum FROM schema_migrations WHERE id=14').get() as {checksum:string}).checksum, migrationChecksum(migrations[13]!));
  const backups = (await readdir(root)).filter(name => name.includes('.pre-schema-14-') && name.endsWith('.db'));
  assert.equal(backups.length, 1);
  const backup = new Database(join(root, backups[0]!), { readonly: true });
  try { assert.equal((backup.prepare('SELECT count(*) n FROM knowledge_generations WHERE state_json IS NOT NULL').get() as {n:number}).n, 2); } finally { backup.close(); }
  db.close(); const reopened = openMigratedDatabase(path, migrations);
  try { assert.deepEqual(new SqliteKnowledgeStorePersistence(reopened, { workspaceId: 'test', ensureWorkspaceRow: false }).load(), expected); } finally { reopened.close(); }
  assert.equal((await readdir(root)).filter(name => name.includes('.pre-schema-')).length, 1);
}));

for (const fault of ['unknown-checksum', 'conflicting-snapshots', 'extra-field', 'before-checksum-commit']) {
  test(`legacy v14 fails closed and rolls back: ${fault}`, async () => fixture(async (db) => {
    if (fault === 'unknown-checksum') db.prepare('UPDATE schema_migrations SET checksum=? WHERE id=14').run('0'.repeat(64));
    if (fault === 'conflicting-snapshots') db.prepare('UPDATE knowledge_generations SET state_json=? WHERE generation_id=?')
      .run(JSON.stringify({ ...snapshot, current: 'gen-0' }), 'gen-0');
    if (fault === 'extra-field') db.prepare('UPDATE knowledge_generations SET state_json=?').run(JSON.stringify({ ...snapshot, unknown: 'must not lose this' }));
    if (fault === 'before-checksum-commit') db.exec(`CREATE TRIGGER fail_migration BEFORE UPDATE ON schema_migrations
      WHEN NEW.id=14 BEGIN SELECT RAISE(ABORT,'injected before commit'); END;`);
    const before = db.prepare('SELECT * FROM knowledge_generations ORDER BY generation_id').all();
    const ledger = db.prepare('SELECT * FROM schema_migrations WHERE id=14').get();
    assert.throws(() => applyMigrations(db, migrations), error => (error as {code?:string}).code === (fault === 'unknown-checksum'
      ? 'SQLITE_MIGRATION_CHECKSUM_MISMATCH' : 'SQLITE_LEGACY_KNOWLEDGE_MIGRATION_FAILED'));
    assert.deepEqual(db.prepare('SELECT * FROM knowledge_generations ORDER BY generation_id').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE id=14').get(), ledger);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_pages'").get(), undefined);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    if (fault === 'before-checksum-commit') { db.exec('DROP TRIGGER fail_migration'); applyMigrations(db, migrations); }
  }));
}
