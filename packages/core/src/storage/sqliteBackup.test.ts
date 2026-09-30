import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import * as sqlite from './sqliteDatabase.js';

type Backup = (source: string, destination: string, options?: {
  signal?: AbortSignal;
  progress?: (progress: { totalPages: number; remainingPages: number }) => number | undefined;
}) => Promise<{ status: 'migrated' | 'existing' }>;
function backup(): Backup {
  const fn = (sqlite as unknown as { backupWorkspaceDatabase?: Backup }).backupWorkspaceDatabase;
  assert.equal(typeof fn, 'function', 'consistent migration must use the SQLite backup API');
  return fn!;
}
function fixture(file: string) {
  const db = new BetterSqlite3(file);
  db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
  db.exec('CREATE TABLE A(v INTEGER); CREATE TABLE B(v INTEGER); INSERT INTO A VALUES(0); INSERT INTO B VALUES(0); CREATE TABLE padding(v BLOB);');
  const insert = db.prepare('INSERT INTO padding VALUES(?)');
  db.transaction(() => { for (let i = 0; i < 40; i += 1) insert.run(Buffer.alloc(4096)); })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  return db;
}
function counters(db: BetterSqlite3.Database) {
  return [db.prepare('SELECT v FROM A').get() as { v: number }, db.prepare('SELECT v FROM B').get() as { v: number }].map(row => row.v);
}

test('backup remains a genuine source snapshot during checkpoint and concurrent writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-backup-race-'));
  const source = join(root, 'source.db'), destination = join(root, 'destination.db');
  const writer = fixture(source); let target: BetterSqlite3.Database | undefined;
  const states = [[0, 0]]; writer.prepare('UPDATE A SET v=1').run(); states.push([1, 0]);
  let changed = false;
  try {
    const result = await backup()(source, destination, { progress: () => {
      if (!changed) { changed = true; writer.pragma('wal_checkpoint(PASSIVE)'); writer.prepare('UPDATE B SET v=1').run(); states.push([1, 1]); }
      return 1;
    } });
    assert.equal(result.status, 'migrated');
    target = new BetterSqlite3(destination, { readonly: true, fileMustExist: true });
    const observed = counters(target);
    assert.ok(states.some(state => JSON.stringify(state) === JSON.stringify(observed)), `snapshot ${observed} never existed in source`);
    assert.notDeepEqual(observed, [0, 1]);
    assert.equal(target.pragma('integrity_check', { simple: true }), 'ok');
    assert.ok(changed, 'test must actually cross the concurrent write boundary');
  } finally { target?.close(); writer.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed in-progress backup leaves no published target and can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-backup-cancel-'));
  const source = join(root, 'source.db'), destination = join(root, 'destination.db');
  const writer = fixture(source); const controller = new AbortController();
  try {
    await assert.rejects(backup()(source, destination, { signal: controller.signal, progress: () => { controller.abort(); return 1; } }));
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('destination')), []);
    assert.equal((await backup()(source, destination)).status, 'migrated');
  } finally { writer.close(); await rm(root, { recursive: true, force: true }); }
});

test('an established destination is never overwritten by migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-backup-existing-'));
  const source = join(root, 'source.db'), destination = join(root, 'destination.db');
  const writer = fixture(source); const established = fixture(destination); established.prepare('UPDATE A SET v=77').run(); established.close();
  const original = await readFile(destination);
  try {
    assert.equal((await backup()(source, destination)).status, 'existing');
    assert.deepEqual(await readFile(destination), original);
  } finally { writer.close(); await rm(root, { recursive: true, force: true }); }
});
