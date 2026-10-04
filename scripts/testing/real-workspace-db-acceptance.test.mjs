import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import * as acceptance from './real-workspace-db-acceptance.mjs';

const tables = ['workspaces', 'patch_history', 'transaction_journal', 'semantic_file_cache', 'rag_chunks'];

test('streaming row fingerprints distinguish every SQLite storage class and exact integer/text bytes', () => {
  assert.equal(typeof acceptance.streamTableDigest, 'function');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE typed(value);');
    const fingerprints = [];
    for (const literal of ['NULL', "X'31'", "'1'", '1', 'CAST(1 AS REAL)', '9007199254740992', '9007199254740993', "CAST(X'80' AS TEXT)", "CAST(X'81' AS TEXT)"]) {
      db.exec(`DELETE FROM typed; INSERT INTO typed VALUES (${literal});`);
      fingerprints.push(acceptance.streamTableDigest(db, 'typed').sha256);
    }
    assert.equal(new Set(fingerprints).size, fingerprints.length);
  } finally { db.close(); }
});

test('fingerprints use composite primary keys without rowid and ignore insertion order', () => {
  assert.equal(typeof acceptance.streamTableDigest, 'function');
  const left = new Database(':memory:'), right = new Database(':memory:');
  try {
    for (const db of [left, right]) db.exec('CREATE TABLE typed(a TEXT NOT NULL,b INTEGER NOT NULL,payload BLOB,PRIMARY KEY(a,b)) WITHOUT ROWID;');
    const values = [['z', 2, Buffer.from('second')], ['a', 1, Buffer.from('first')]];
    for (const value of values) left.prepare('INSERT INTO typed VALUES(?,?,?)').run(...value);
    for (const value of [...values].reverse()) right.prepare('INSERT INTO typed VALUES(?,?,?)').run(...value);
    assert.deepEqual(acceptance.streamTableDigest(left, 'typed'), acceptance.streamTableDigest(right, 'typed'));
  } finally { left.close(); right.close(); }
});

test('large-table fingerprinting iterates rows instead of collecting them with all()', () => {
  assert.equal(typeof acceptance.streamTableDigest, 'function');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE rag_chunks(id INTEGER PRIMARY KEY,body TEXT);');
    const insert = db.prepare('INSERT INTO rag_chunks VALUES (?,?)');
    db.transaction(() => { for (let i = 0; i < 5000; i++) insert.run(i, `row-${i}`); })();
    let iterated = 0;
    const streaming = { prepare(sql) {
      const statement = db.prepare(sql);
      if (/FROM "rag_chunks"/u.test(sql)) {
        statement.all = () => { throw new Error('unbounded all() is forbidden'); };
        const iterate = statement.iterate.bind(statement);
        statement.iterate = function* (...args) { for (const row of iterate(...args)) { iterated++; yield row; } };
      }
      return statement;
    }, pragma: db.pragma.bind(db) };
    const result = acceptance.streamTableDigest(streaming, 'rag_chunks');
    assert.equal(result.rowCount, 5000);
    assert.equal(iterated, 5000);
  } finally { db.close(); }
});

test('missing rowid requires a usable key instead of silently relying on scan order', () => {
  assert.equal(typeof acceptance.streamTableDigest, 'function');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE shadowed(rowid TEXT,_rowid_ TEXT,oid TEXT);');
    assert.throws(() => acceptance.streamTableDigest(db, 'shadowed'), /ORDER_UNAVAILABLE/);
  } finally { db.close(); }
});

test('same-count mutations in each retained table fail content-preservation acceptance', () => {
  assert.equal(typeof acceptance.databaseAcceptanceInventory, 'function');
  assert.equal(typeof acceptance.assertPreservedTables, 'function');
  const db = new Database(':memory:');
  try {
    for (const table of tables) {
      db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,payload BLOB);`);
      db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run('id', Buffer.from('before'));
    }
    const before = acceptance.databaseAcceptanceInventory(db);
    for (const table of tables) {
      db.prepare(`UPDATE ${table} SET payload=?`).run(Buffer.from('changed'));
      const changed = acceptance.databaseAcceptanceInventory(db);
      assert.deepEqual(changed.counts, before.counts);
      assert.throws(() => acceptance.assertPreservedTables(before, changed), /preserved table content/u);
      db.prepare(`UPDATE ${table} SET payload=?`).run(Buffer.from('before'));
    }
    acceptance.assertPreservedTables(before, acceptance.databaseAcceptanceInventory(db));
  } finally { db.close(); }
});

test('new columns are disclosed outside the frozen source digest and missing source columns fail closed', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE rag_chunks(id TEXT PRIMARY KEY,body TEXT); INSERT INTO rag_chunks VALUES('id','original');");
    const before = acceptance.databaseAcceptanceInventory(db);
    db.exec('ALTER TABLE rag_chunks ADD COLUMN native_metadata_json TEXT;');
    const after = acceptance.databaseAcceptanceInventory(db, { baseline: before });
    acceptance.assertPreservedTables(before, after);
    assert.deepEqual(after.unverifiedAddedColumns, { rag_chunks: ['native_metadata_json'] });
    db.exec("UPDATE rag_chunks SET body='modified';");
    assert.throws(() => acceptance.assertPreservedTables(before, acceptance.databaseAcceptanceInventory(db, { baseline: before })), /preserved table content/u);
    db.exec('ALTER TABLE rag_chunks DROP COLUMN body;');
    assert.throws(() => acceptance.databaseAcceptanceInventory(db, { baseline: before }), /PRESERVED_COLUMNS_MISSING/u);
  } finally { db.close(); }
});

async function ownedFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'sf-db-acceptance-boundary-'));
  try {
    const repositoryRoot = join(root, 'repo'), outside = join(root, 'outside');
    await mkdir(repositoryRoot); await mkdir(outside);
    const source = join(outside, 'source.db'); await writeFile(source, 'original sentinel');
    await run({ root, repositoryRoot, outside, source });
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  }
}

test('owned output rejects a linked validation root and linked intermediate escape', async () => {
  assert.equal(typeof acceptance.assertOwnedAcceptancePath, 'function');
  await ownedFixture(async ({ repositoryRoot, outside, source }) => {
    const base = join(repositoryRoot, '.local-validation');
    await symlink(outside, base, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(acceptance.assertOwnedAcceptancePath(join(base, 'new-output'), { repositoryRoot, source }), /OWNED_PATH/u);
    await rm(base); await mkdir(base);
    const alias = join(base, 'alias'); await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(acceptance.assertOwnedAcceptancePath(join(alias, 'new-output'), { repositoryRoot, source }), /OWNED_PATH/u);
  });
});

test('owned output accepts a fresh direct child but rejects source identity and hardlink aliases', async () => {
  assert.equal(typeof acceptance.assertOwnedAcceptancePath, 'function');
  await ownedFixture(async ({ repositoryRoot, source }) => {
    const base = join(repositoryRoot, '.local-validation'); await mkdir(base);
    const child = join(base, 'new-output');
    assert.equal(await acceptance.assertOwnedAcceptancePath(child, { repositoryRoot, source }), child);
    const sourceAlias = join(base, 'migration-copy.db'); await link(source, sourceAlias);
    await assert.rejects(acceptance.assertOwnedAcceptancePath(sourceAlias, { repositoryRoot, source, mustExist: true }), /SOURCE_ALIAS/u);
    await assert.rejects(acceptance.assertOwnedAcceptancePath(sourceAlias, { repositoryRoot, source: sourceAlias, mustExist: true }), /SOURCE_ALIAS/u);
  });
});

test('the complete acceptance path compares typed content on a tiny owned database and its recovery snapshots', async () => {
  const { openMigratedDatabase } = await import('../../packages/core/dist/storage/sqliteDatabase.js');
  const { SQLITE_MIGRATIONS } = await import('../../packages/core/dist/storage/sqliteSchema.js');
  await ownedFixture(async ({ repositoryRoot, source }) => {
    await rm(source);
    const db = openMigratedDatabase(source, SQLITE_MIGRATIONS.filter(migration => migration.id <= 15));
    try {
      db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)').run('test', 'synthetic-root', 'sekiro', 'now', 'now');
      db.prepare('INSERT INTO patch_history(op_id,workspace_id,title,author,mode,status,created_at) VALUES (?,?,?,?,?,?,?)')
        .run('original-op', 'test', 'preserved title', 'user', 'normal', 'committed', 'now');
    } finally { db.close(); }
    const base = join(repositoryRoot, '.local-validation'); await mkdir(base);
    const previousCwd = process.cwd();
    try {
      process.chdir(repositoryRoot);
      const report = await acceptance.runRealWorkspaceDatabaseAcceptance({ source, output: join(base, 'acceptance') });
      assert.equal(report.status, 'passed', JSON.stringify(report.error));
      assert.equal(report.originalPreserved, true);
      assert.deepEqual(Object.keys(report.before.preservedTableDigests), tables);
      assert.deepEqual(report.after.preservedTableDigests, report.before.preservedTableDigests);
      assert.deepEqual(report.after.unverifiedAddedColumns, { rag_chunks: ['native_metadata_json'] });
      assert.ok(report.snapshots.length > 0);
      for (const snapshot of report.snapshots) assert.deepEqual(snapshot.preservedTableDigests, report.before.preservedTableDigests);
      assert.match(report.preservationScope.knowledge, /not included/u);
      assert.ok(report.phases.every(phase => phase.status === 'passed'));
    } finally { process.chdir(previousCwd); }
  });
});
