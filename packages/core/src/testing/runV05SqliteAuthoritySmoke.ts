import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { OperationLogRecord } from '@soulforge/shared';
import { importLegacyOperationLog, LegacyOperationLogImportError } from '../patch/importLegacyOperationLog.js';
import { openSqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import {
  applyMigrations,
  migrationChecksum,
  openAppDatabase,
  openWorkspaceDatabase,
  SqliteMigrationError
} from '../storage/sqliteDatabase.js';
import { APP_DB_MIGRATIONS, SQLITE_MIGRATIONS, type SqlMigration } from '../storage/sqliteSchema.js';
import { DurableWorkspaceRepository } from '../storage/durableWorkspaceRepository.js';
import { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import {
  importLegacySemanticSnapshot,
  LegacySemanticSnapshotImportError
} from '../workspace/importLegacySemanticSnapshot.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-sqlite-'));
  const workspaceDbPath = join(root, 'workspace.db');
  const appDbPath = join(root, 'app.db');
  const workspaceId = 'workspace-sqlite-smoke';

  const appDb = openAppDatabase(appDbPath);
  assert(tableExists(appDb, 'model_services'), 'app.db model_services table');
  assert(tableExists(appDb, 'adaptation_packages'), 'app.db adaptation_packages table');
  assert(appDb.pragma('journal_mode', { simple: true }) === 'wal', 'app.db WAL');
  appDb.close();

  const store = openSqliteOperationLogStore({
    databasePath: workspaceDbPath,
    workspaceId,
    rootPath: join(root, 'mod'),
    game: 'sekiro'
  });
  const original = makeRecord(workspaceId, 'op-original');
  const inverse = {
    ...makeRecord(workspaceId, 'op-inverse'),
    inverseOfOpId: original.opId,
    rollbackScope: 'operation' as const
  };
  await store.record(original);
  await store.record(inverse);
  assert((await store.get(original.opId))?.status === 'committed', 'original operation remains committed');
  assert((await store.get(inverse.opId))?.inverseOfOpId === original.opId, 'inverse relation in SQLite');
  store.close();

  const reopened = openSqliteOperationLogStore({
    databasePath: workspaceDbPath,
    workspaceId,
    rootPath: join(root, 'mod'),
    game: 'sekiro'
  });
  assert((await reopened.list()).length === 2, 'SQLite operation history survives reopen');
  assert((await reopened.get(inverse.opId))?.rollbackScope === 'operation', 'rollback scope survives reopen');

  const legacyPath = join(root, 'legacy-operation-log.json');
  const legacyRecord = makeRecord(workspaceId, 'op-legacy');
  await writeFile(legacyPath, `${JSON.stringify({ version: 1, entries: [legacyRecord] }, null, 2)}\n`, 'utf8');
  const firstImport = await importLegacyOperationLog({
    sourcePath: legacyPath,
    backupDirectory: join(root, 'legacy-backups'),
    store: reopened
  });
  assert(firstImport.status === 'imported' && firstImport.recordCount === 1, 'legacy JSON first import');
  assert(Boolean(firstImport.backupPath), 'legacy JSON read-only backup path');
  assert((await readFile(firstImport.backupPath!, 'utf8')).includes('op-legacy'), 'legacy backup content');
  const secondImport = await importLegacyOperationLog({
    sourcePath: legacyPath,
    backupDirectory: join(root, 'legacy-backups'),
    store: reopened
  });
  assert(secondImport.status === 'already_imported', 'legacy JSON idempotent import');

  const corruptPath = join(root, 'corrupt-operation-log.json');
  await writeFile(corruptPath, '{ not-json', 'utf8');
  let corruptRejected = false;
  try {
    await importLegacyOperationLog({
      sourcePath: corruptPath,
      backupDirectory: join(root, 'legacy-backups'),
      store: reopened
    });
  } catch (error) {
    corruptRejected = error instanceof LegacyOperationLogImportError
      && error.code === 'LEGACY_OPERATION_LOG_CORRUPT';
  }
  assert(corruptRejected, 'corrupt legacy JSON is surfaced');
  assert((await reopened.list()).length === 3, 'corrupt import does not erase history');
  await verifyAtomicFinalizeFailure(reopened, workspaceId, root);
  reopened.close();

  const reopenedDb = openWorkspaceDatabase(workspaceDbPath);
  assert(reopenedDb.pragma('foreign_keys', { simple: true }) === 1, 'workspace.db foreign keys');
  assert(reopenedDb.pragma('journal_mode', { simple: true }) === 'wal', 'workspace.db WAL');
  assert(tableExists(reopenedDb, 'transaction_journal'), 'transaction journal table');
  assert(tableExists(reopenedDb, 'resource_entry_changes'), 'resource entry changes table');
  verifyDurableRepositories(reopenedDb, workspaceId, root);
  await verifySemanticSnapshotImport(reopenedDb, workspaceId, root);
  verifyWorkspaceDataRepositories(reopenedDb, workspaceId, root);
  const applied = reopenedDb.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all() as Array<{
    id: number;
    checksum: string;
  }>;
  assert(applied.length === SQLITE_MIGRATIONS.length, 'all workspace migrations applied');
  for (const migration of SQLITE_MIGRATIONS) {
    assert(
      applied.find((row) => row.id === migration.id)?.checksum === migrationChecksum(migration),
      `workspace migration checksum ${migration.id}`
    );
  }
  reopenedDb.close();

  verifyMigrationFailureRollback(join(root, 'fault.db'));
  verifyChecksumMismatch(join(root, 'checksum.db'));
  verifyNewerSchemaRejected(join(root, 'newer-user-version.db'), join(root, 'newer-ledger.db'));

  console.log(JSON.stringify({
    ok: true,
    message: 'V0.5 SQLite 权威层验证通过',
    checks: [
      'app.db/workspace.db migrations',
      'WAL/foreign keys/busy transaction base',
      'migration checksums',
      'newer schema downgrade refusal',
      'migration failure rollback',
      'SQLite operation/inverse persistence',
      'transaction phase compare-and-swap and restart discovery',
      'recovery point and audit persistence',
      'atomic commit finalization rollback',
      'strict idempotent semantic snapshot import',
      'file FTS, diagnostics, and background jobs',
      'strict idempotent legacy JSON import',
      'corrupt JSON preservation'
    ],
    workspaceMigrationCount: SQLITE_MIGRATIONS.length,
    appMigrationCount: APP_DB_MIGRATIONS.length
  }, null, 2));
}

function verifyWorkspaceDataRepositories(
  database: BetterSqlite3.Database,
  workspaceId: string,
  root: string
): void {
  const repository = new WorkspaceDataRepository(database, workspaceId);
  repository.replaceFiles([{
    id: 'file-event', workspaceId, sourceUri: 'file://event/m10_00_00_00.emevd.dcx',
    sourcePath: join(root, 'mod', 'event', 'm10_00_00_00.emevd.dcx'),
    absolutePath: join(root, 'mod', 'event', 'm10_00_00_00.emevd.dcx'),
    relativePath: 'event/m10_00_00_00.emevd.dcx', game: 'sekiro', resourceKind: 'event',
    extension: '.dcx', compoundExtension: '.emevd.dcx', formatKind: 'emevd',
    formatLabel: 'EMEVD', size: 128, mtimeMs: 1, sha256: 'c'.repeat(64),
    parseStatus: 'partial', diagnostics: []
  }]);
  const found = repository.searchFiles('m10_00 EMEVD', 10);
  assert(found.length === 1 && found[0]?.formatKind === 'emevd', 'file FTS search');
  assert(repository.searchFiles('" OR *', 10).length === 0, 'FTS query syntax escaped');

  const now = new Date().toISOString();
  repository.replaceDiagnostics([{
    id: 'diagnostic-1', severity: 'warning', code: 'PARSE_PARTIAL', message: '部分解析',
    sourceUri: 'file://event/m10_00_00_00.emevd.dcx', details: { missing: 'writer' },
    createdAt: now, suppressed: false
  }]);
  assert(repository.listDiagnostics()[0]?.code === 'PARSE_PARTIAL', 'diagnostic persisted');
  repository.upsertJob({
    jobId: 'job-1', title: '索引工作区', jobKind: 'workspace_index', status: 'running',
    progress: { current: 3, total: 10, message: '处理中' }, payload: { root: 'resource://workspace' },
    createdAt: now, startedAt: now, updatedAt: now
  });
  repository.upsertJob({
    jobId: 'job-1', title: '索引工作区', jobKind: 'workspace_index', status: 'completed',
    progress: { current: 10, total: 10 }, payload: { root: 'resource://workspace' },
    result: { indexed: 1 }, createdAt: now, startedAt: now, completedAt: now, updatedAt: now
  });
  const job = repository.listJobs()[0];
  assert(job?.status === 'completed' && (job.result as { indexed?: number }).indexed === 1, 'background job persisted');
}

async function verifyAtomicFinalizeFailure(
  store: ReturnType<typeof openSqliteOperationLogStore>,
  workspaceId: string,
  root: string
): Promise<void> {
  const repository = new DurableWorkspaceRepository(store.database, workspaceId);
  const now = new Date().toISOString();
  repository.createTransaction({
    transactionId: 'tx-finalize-fault', opId: 'op-finalize-fault', phase: 'marking_committed',
    state: {}, createdAt: now, updatedAt: now
  });
  const operation = { ...makeRecord(workspaceId, 'op-finalize-fault'), transactionId: 'tx-finalize-fault' };
  const duplicateChange = {
    id: 'duplicate-entry-change', opId: operation.opId, resourceUri: 'file://archive.bnd',
    entryUri: 'file://archive.bnd#bnd/item.fmg', changeKind: 'replace',
    beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64),
    inverse: {
      id: 'inverse-finalize', kind: 'container_child_replace' as const,
      targetUri: 'file://archive.bnd', containerUri: 'file://archive.bnd', childPath: 'item.fmg',
      expectedChildHash: 'b'.repeat(64), childContentBase64: 'YmVmb3Jl',
      preconditions: [], validatorRequirements: [], riskLevel: 'high' as const
    }
  };
  let rejected = false;
  try {
    await store.finalizeCommit({
      operation,
      resourceEntryChanges: [duplicateChange, duplicateChange],
      recoveryPoint: {
        recoveryId: 'recovery-finalize-fault', opId: operation.opId,
        rootPath: join(root, 'recovery-finalize-fault'), sizeBytes: 0,
        state: 'active', createdAt: now, metadata: {}
      },
      auditEvent: {
        eventId: 'audit-finalize-fault', eventKind: 'transaction.committed',
        opId: operation.opId, transactionId: 'tx-finalize-fault', payload: {}, createdAt: now
      },
      transactionId: 'tx-finalize-fault', expectedPhase: 'marking_committed', finalState: {}
    });
  } catch {
    rejected = true;
  }
  assert(rejected, 'atomic finalize fault rejected');
  assert(await store.get(operation.opId) === undefined, 'failed finalize operation rolled back');
  assert(repository.listResourceEntryChanges(operation.opId).length === 0, 'failed finalize entry changes rolled back');
  assert(repository.getTransaction('tx-finalize-fault')?.phase === 'marking_committed', 'failed finalize phase transition rolled back');
  assert(!repository.listRecoveryPoints().some((item) => item.recoveryId === 'recovery-finalize-fault'), 'failed finalize recovery point rolled back');
  assert(!repository.listAuditEvents().some((item) => item.eventId === 'audit-finalize-fault'), 'failed finalize audit rolled back');
}

async function verifySemanticSnapshotImport(
  database: BetterSqlite3.Database,
  workspaceId: string,
  root: string
): Promise<void> {
  const createdAt = new Date().toISOString();
  const sourcePath = join(root, 'semantic-snapshot.json');
  const document = {
    workspaceId, createdAt, version: 'graph-v1', nodeCount: 2, edgeCount: 1, vfsUriCount: 2,
    graph: {
      workspaceId, version: 'graph-v1', createdAt, updatedAt: createdAt, mutations: [],
      nodes: [
        { id: 'node-a', kind: 'file', uri: 'file://a.bin', label: 'a.bin', properties: [], createdAt, updatedAt: createdAt },
        { id: 'node-b', kind: 'resource', uri: 'resource://b', label: 'b', properties: [], createdAt, updatedAt: createdAt }
      ],
      edges: [{ id: 'edge-a-b', kind: 'contains', fromId: 'node-a', toId: 'node-b', properties: [], createdAt, updatedAt: createdAt }]
    }
  };
  await writeFile(sourcePath, `${JSON.stringify(document)}\n`, 'utf8');
  const options = { sourcePath, backupDirectory: join(root, 'semantic-backups'), database, workspaceId };
  const first = await importLegacySemanticSnapshot(options);
  assert(first.status === 'imported' && first.nodeCount === 2 && first.edgeCount === 1, 'semantic snapshot imported');
  assert(Boolean(first.backupPath), 'semantic snapshot read-only backup');
  const second = await importLegacySemanticSnapshot(options);
  assert(second.status === 'already_imported', 'semantic snapshot import idempotent');
  const counts = database.prepare(`
SELECT (SELECT COUNT(*) FROM resource_nodes WHERE workspace_id = ?) AS nodes,
       (SELECT COUNT(*) FROM resource_edges WHERE workspace_id = ?) AS edges
`).get(workspaceId, workspaceId) as { nodes: number; edges: number };
  assert(counts.nodes === 2 && counts.edges === 1, 'semantic graph persisted');

  const corruptPath = join(root, 'semantic-corrupt.json');
  await writeFile(corruptPath, '{ invalid', 'utf8');
  let corruptRejected = false;
  try {
    await importLegacySemanticSnapshot({ ...options, sourcePath: corruptPath });
  } catch (error) {
    corruptRejected = error instanceof LegacySemanticSnapshotImportError
      && error.code === 'LEGACY_SEMANTIC_SNAPSHOT_CORRUPT';
  }
  assert(corruptRejected, 'corrupt semantic snapshot rejected');
  const nodesAfterFailure = database.prepare('SELECT COUNT(*) AS count FROM resource_nodes WHERE workspace_id = ?')
    .get(workspaceId) as { count: number };
  assert(nodesAfterFailure.count === 2, 'corrupt semantic snapshot preserves existing graph');
}

function verifyDurableRepositories(
  database: BetterSqlite3.Database,
  workspaceId: string,
  root: string
): void {
  const repository = new DurableWorkspaceRepository(database, workspaceId);
  const createdAt = new Date().toISOString();
  repository.createTransaction({
    transactionId: 'tx-incomplete', opId: 'op-original', phase: 'pending',
    state: { checkpoint: 0 }, createdAt, updatedAt: createdAt
  });
  const staging = repository.transitionTransaction({
    transactionId: 'tx-incomplete', expectedPhase: 'pending', nextPhase: 'staging',
    state: { checkpoint: 1 }
  });
  assert((staging.state as { checkpoint: number }).checkpoint === 1, 'transaction state update');
  let conflictRejected = false;
  try {
    repository.transitionTransaction({
      transactionId: 'tx-incomplete', expectedPhase: 'pending', nextPhase: 'committed', state: {}
    });
  } catch (error) {
    conflictRejected = error instanceof Error && error.message.includes('phase conflict');
  }
  assert(conflictRejected, 'transaction phase conflict rejected');
  assert(repository.listIncompleteTransactions().some((item) => item.transactionId === 'tx-incomplete'), 'restart discovery');

  repository.recordRecoveryPoint({
    recoveryId: 'recovery-1', opId: 'op-original', rootPath: join(root, 'recovery', 'recovery-1'),
    sizeBytes: 128, state: 'active', createdAt, metadata: { afterHash: 'b'.repeat(64) }
  });
  repository.recordRecoveryPoint({
    recoveryId: 'recovery-old', opId: 'op-inverse', rootPath: join(root, 'recovery', 'old'),
    sizeBytes: 100, state: 'active', createdAt: '2020-01-01T00:00:00.000Z', metadata: {}
  });
  repository.appendAuditEvent({
    eventId: 'audit-1', eventKind: 'transaction.phase_changed', opId: 'op-original',
    transactionId: 'tx-incomplete', payload: { from: 'pending', to: 'staging' }, createdAt
  });
  assert(repository.listRecoveryPoints()[0]?.recoveryId === 'recovery-1', 'recovery point persisted');
  assert(repository.listAuditEvents()[0]?.eventId === 'audit-1', 'audit event persisted');
  const cleanup = repository.planRecoveryCleanup({
    now: new Date('2026-07-11T00:00:00.000Z'), maxAgeDays: 30, maxBytes: 200
  });
  assert(cleanup.protectedRecoveryIds.includes('recovery-1'), 'active transaction recovery protected');
  assert(cleanup.candidates.some((item) => item.recoveryId === 'recovery-old' && item.reason === 'age'), 'old recovery selected');
  assert(cleanup.quotaSatisfied && cleanup.projectedBytesAfter === 128, 'recovery quota projection');
  repository.markRecoveryPointExpired('recovery-old');
  assert(repository.listRecoveryPoints().find((item) => item.recoveryId === 'recovery-old')?.state === 'expired', 'recovery expiration persisted');
  repository.recordResourceEntryChange({
    id: 'entry-change-1', opId: 'op-original', resourceUri: 'file://archive.bnd',
    entryUri: 'file://archive.bnd#bnd/item.fmg', changeKind: 'replace',
    beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64),
    inverse: {
      id: 'inverse-entry-1', kind: 'container_child_replace', targetUri: 'file://archive.bnd',
      containerUri: 'file://archive.bnd', childPath: 'item.fmg',
      expectedChildHash: 'b'.repeat(64), childContentBase64: 'YmVmb3Jl',
      preconditions: [{ type: 'content_hash', description: '条目仍须等于 afterHash' }],
      validatorRequirements: [{ validatorId: 'container_child_hash', scope: 'staged_output', required: true }],
      riskLevel: 'high'
    }
  });
  const entryChange = repository.listResourceEntryChanges('op-original')[0];
  assert(entryChange?.inverse.kind === 'container_child_replace', 'resource entry inverse persisted');
}

function verifyMigrationFailureRollback(path: string): void {
  const db = new BetterSqlite3(path);
  const migrations: SqlMigration[] = [
    { id: 1, name: 'base', sql: 'CREATE TABLE base_table (id INTEGER PRIMARY KEY);' },
    {
      id: 2,
      name: 'fault',
      sql: 'CREATE TABLE must_rollback (id INTEGER PRIMARY KEY); THIS IS INVALID SQL;'
    }
  ];
  let rejected = false;
  try {
    applyMigrations(db, migrations);
  } catch (error) {
    rejected = error instanceof SqliteMigrationError && error.code === 'SQLITE_MIGRATION_FAILED';
  }
  assert(rejected, 'fault migration rejected');
  assert(!tableExists(db, 'must_rollback'), 'failed migration DDL rolled back');
  const recorded = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 2').get() as { count: number };
  assert(recorded.count === 0, 'failed migration not recorded');
  db.close();
}

function verifyChecksumMismatch(path: string): void {
  const db = openWorkspaceDatabase(path);
  db.prepare('UPDATE schema_migrations SET checksum = ? WHERE id = 1').run('tampered');
  db.close();
  let rejected = false;
  try {
    openWorkspaceDatabase(path);
  } catch (error) {
    rejected = error instanceof SqliteMigrationError
      && error.code === 'SQLITE_MIGRATION_CHECKSUM_MISMATCH';
  }
  assert(rejected, 'migration checksum tamper rejected');
}

function verifyNewerSchemaRejected(userVersionPath: string, ledgerPath: string): void {
  const userVersionDb = new BetterSqlite3(userVersionPath);
  userVersionDb.pragma('user_version = 999');
  userVersionDb.close();
  let userVersionRejected = false;
  try {
    openWorkspaceDatabase(userVersionPath);
  } catch (error) {
    userVersionRejected = error instanceof SqliteMigrationError
      && error.code === 'SQLITE_SCHEMA_NEWER_THAN_APPLICATION';
  }
  assert(userVersionRejected, 'higher PRAGMA user_version rejected');

  const ledgerDb = new BetterSqlite3(ledgerPath);
  ledgerDb.exec(`
CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT,
  applied_at TEXT NOT NULL
);
INSERT INTO schema_migrations (id, name, checksum, applied_at)
VALUES (999, 'future', 'future-checksum', '2026-07-11T00:00:00.000Z');
`);
  ledgerDb.close();
  let ledgerRejected = false;
  try {
    openWorkspaceDatabase(ledgerPath);
  } catch (error) {
    ledgerRejected = error instanceof SqliteMigrationError
      && error.code === 'SQLITE_SCHEMA_NEWER_THAN_APPLICATION';
  }
  assert(ledgerRejected, 'higher schema_migrations id rejected');
}

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  const row = db.prepare(`
SELECT 1 AS found
FROM sqlite_master
WHERE type = 'table' AND name = ?
`).get(name) as { found?: number } | undefined;
  return row?.found === 1;
}

function makeRecord(workspaceId: string, opId: string): OperationLogRecord {
  return {
    opId,
    workspaceId,
    title: opId,
    author: 'user',
    mode: 'normal',
    status: 'committed',
    createdAt: new Date().toISOString(),
    committedAt: new Date().toISOString(),
    backupRoot: `backup://${opId}`,
    files: [{
      targetUri: `file://${opId}.bin`,
      targetPath: `C:\\synthetic\\${opId}.bin`,
      beforeHash: 'a'.repeat(64),
      afterHash: 'b'.repeat(64),
      backupPath: `C:\\synthetic-backup\\${opId}.bin`,
      kind: 'binary',
      resourceKind: 'other'
    }],
    diagnostics: []
  };
}

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
