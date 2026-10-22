import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { openMigratedDatabase, SqliteMigrationError } from './sqliteDatabase.js';

const migrations = [{ id: 1, name: 'owned_integrity', sql: 'CREATE TABLE owned(value INTEGER CHECK(value > 0));' }];
async function withDatabase(run: (file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sf-sqlite-open-'));
  try { await run(join(root, 'owned.db')); }
  finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('read-only open verifies integrity once without a duplicate post-migration scan or mutation', async t => {
  await withDatabase(async file => {
    openMigratedDatabase(file, migrations).close();
    const before = await readFile(file);
    const original = BetterSqlite3.prototype.pragma;
    const statements: string[] = [];
    const observer = t.mock.method(BetterSqlite3.prototype, 'pragma', function (this: BetterSqlite3.Database, source: string, ...args: Parameters<typeof original> extends [string, ...infer Rest] ? Rest : never) {
      statements.push(source);
      return original.call(this, source, ...args);
    });
    try {
      const database = openMigratedDatabase(file, migrations, { readonly: true, fileMustExist: true });
      try {
        assert.equal(database.readonly, true);
        assert.equal((database.prepare('SELECT COUNT(*) AS n FROM owned').get() as { n: number }).n, 0);
      } finally { database.close(); }
    } finally { observer.mock.restore(); }
    assert.equal(statements.filter(sql => sql === 'quick_check').length, 1);
    assert.equal(statements.includes('journal_mode = WAL'), false);
    assert.deepEqual(await readFile(file), before);
  });
});

test('read-only open still rejects a corrupt table page instead of bypassing the remaining scan', async () => {
  await withDatabase(async file => {
    const database = openMigratedDatabase(file, migrations);
    const pageSize = database.pragma('page_size', { simple: true }) as number;
    const { rootpage } = database.prepare("SELECT rootpage FROM sqlite_master WHERE name='owned'").get() as { rootpage: number };
    database.close();
    const bytes = await readFile(file);
    assert.ok(rootpage > 1);
    bytes[(rootpage - 1) * pageSize] = 0xff; // Invalid b-tree page type, outside the schema page.
    await writeFile(file, bytes);
    assert.throws(() => openMigratedDatabase(file, migrations, { readonly: true, fileMustExist: true }).close(),
      error => error instanceof SqliteMigrationError && error.code === 'SQLITE_INTEGRITY_CHECK_FAILED'
        || (error as { code?: string }).code === 'SQLITE_CORRUPT');
  });
});

test('writer still verifies after a migration, rejecting a migration that creates invalid rows', async () => {
  await withDatabase(async file => {
    openMigratedDatabase(file, migrations).close();
    assert.throws(() => openMigratedDatabase(file, [...migrations, { id: 2, name: 'owned_invalid',
      sql: 'PRAGMA ignore_check_constraints = ON; INSERT INTO owned VALUES (-1); PRAGMA ignore_check_constraints = OFF;' }]).close(),
      error => error instanceof SqliteMigrationError && error.code === 'SQLITE_INTEGRITY_CHECK_FAILED');
  });
});
