/**
 * Install / upgrade recovery smoke — W-A-RECOVERY-INTEGRATION-04.
 *
 * Simulates a workspace database written by an OLDER application version (a
 * strict prefix of the migration list) being opened by the CURRENT application
 * (all migrations), and verifies the durable journal / operation log / backup
 * structure survives the upgrade:
 *
 *   - The old database contains a committed operation, a terminal journal row, a
 *     recovery point and an audit event.
 *   - It also contains a non-terminal `replacing` journal row (an interrupted
 *     transaction that crashed under the old version) with a real restore point
 *     and pending operation — the exact state the power-loss smoke produces.
 *   - After opening with the full migration list, all old rows are still
 *     readable, the previously-applied migration checksums still match, and the
 *     new tables/columns exist.
 *   - `recoverIncompleteTransactions` then repairs the pre-upgrade interrupted
 *     transaction using the pre-upgrade backup, proving journal structure
 *     compatibility across install/upgrade.
 *
 * This is a real migration of a real SQLite file; it only touches the test
 * temp workspace, never the game directory.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { createRestorePoint } from '../backup/restorePoint.js';
import { recoverIncompleteTransactions } from '../patch/recoveryRepair.js';
import { SqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import { DurableWorkspaceRepository } from '../storage/durableWorkspaceRepository.js';
import {
  applyMigrations,
  migrationChecksum,
  openWorkspaceDatabase
} from '../storage/sqliteDatabase.js';
import { SQLITE_MIGRATIONS } from '../storage/sqliteSchema.js';

const WORKSPACE_ID = 'upgrade-recovery-smoke';
/** The "old application" version: migrations 1..3 (initial + patch history + durable journal). */
const OLD_SCHEMA_VERSION = 3;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-upgrade-'));
  const databasePath = join(root, 'workspace.db');
  const overlayRoot = join(root, 'mod');
  const backupRoot = join(root, 'backups');
  const targetA = join(overlayRoot, 'upgrade-a.txt');
  const targetB = join(overlayRoot, 'upgrade-b.txt');
  const beforeA = Buffer.from('pre-upgrade-before-a\n');
  const beforeB = Buffer.from('pre-upgrade-before-b\n');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  await writeFile(targetA, beforeA);
  await writeFile(targetB, beforeB);

  const openedDatabases: Array<{ open: boolean; close(): void }> = [];

  try {
    // --- Old application version: only migrations 1..3 applied. ---
    const oldDb = new BetterSqlite3(databasePath);
    openedDatabases.push(oldDb);
    oldDb.pragma('journal_mode = WAL');
    applyMigrations(oldDb, SQLITE_MIGRATIONS.slice(0, OLD_SCHEMA_VERSION));
    const now = new Date().toISOString();
    oldDb.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, 'sekiro', ?, ?)
`).run(WORKSPACE_ID, overlayRoot, now, now);

    // A committed operation + file operations as the OLD application recorded
    // them (migration 2/3 columns; `rollback_target_uri` from migration 5 does
    // not exist yet).
    const committedBackupPath = join(backupRoot, 'committed-backup', 'upgrade-a.txt');
    oldDb.prepare(`
INSERT INTO patch_history (
  op_id, workspace_id, title, author, mode, status, created_at, committed_at,
  rolled_back_at, backup_root, file_count, graph_json, diagnostics_json,
  transaction_id, recovery_path, recovery_reason, inverse_of_op_id, rollback_scope
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
      'op-upgrade-committed', WORKSPACE_ID, 'pre-upgrade committed', 'user', 'normal', 'committed',
      now, now, null, join(backupRoot, 'committed-backup'), 1, null, '[]',
      'tx-upgrade-committed', null, null, null, null
    );
    oldDb.prepare(`
INSERT INTO file_operations (
  id, op_id, workspace_id, target_uri, target_path, relative_path,
  before_hash, after_hash, backup_path, change_kind, resource_kind
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
      'op-upgrade-committed:0', 'op-upgrade-committed', WORKSPACE_ID,
      'file://upgrade-a.txt', targetA, null,
      sha256(beforeA), sha256(Buffer.from('pre-upgrade-after-a\n')), committedBackupPath,
      'text', null
    );
    oldDb.prepare(`
INSERT INTO transaction_journal (
  transaction_id, workspace_id, op_id, phase, state_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
      'tx-upgrade-committed', WORKSPACE_ID, 'op-upgrade-committed', 'committed',
      JSON.stringify({ changedFileCount: 1 }), now, now
    );
    oldDb.prepare(`
INSERT INTO recovery_points (
  recovery_id, workspace_id, op_id, root_path, size_bytes, state, created_at, expires_at, metadata_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
      'recovery-upgrade-committed', WORKSPACE_ID, 'op-upgrade-committed',
      join(backupRoot, 'committed-backup'), beforeA.byteLength, 'active', now, null,
      JSON.stringify({ fileCount: 1 })
    );
    oldDb.prepare(`
INSERT INTO audit_events (
  event_id, workspace_id, event_kind, op_id, transaction_id, payload_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
      'audit-upgrade-committed', WORKSPACE_ID, 'transaction.committed',
      'op-upgrade-committed', 'tx-upgrade-committed', JSON.stringify({ changedFileCount: 1 }), now
    );

    // An interrupted transaction under the old version: real restore point +
    // `replacing` journal row + pending op (the exact shape of a hard kill).
    const restorePoint = await createRestorePoint({
      sourcePaths: [targetA, targetB],
      baseDir: backupRoot,
      label: 'pre-upgrade-crash'
    });
    const crashTxId = 'tx-upgrade-crash';
    oldDb.prepare(`
INSERT INTO patch_history (
  op_id, workspace_id, title, author, mode, status, created_at, committed_at,
  rolled_back_at, backup_root, file_count, graph_json, diagnostics_json,
  transaction_id, recovery_path, recovery_reason, inverse_of_op_id, rollback_scope
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
      'op-upgrade-crash', WORKSPACE_ID, 'pre-upgrade interrupted', 'user', 'normal', 'pending',
      now, null, null, null, 0, null, '[]',
      crashTxId, null, null, null, null
    );
    oldDb.prepare(`
INSERT INTO transaction_journal (
  transaction_id, workspace_id, op_id, phase, state_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
      crashTxId, WORKSPACE_ID, 'op-upgrade-crash', 'replacing',
      JSON.stringify({
        backupRoot: restorePoint.root,
        sizeBytes: restorePoint.sizeBytes,
        restorePointFiles: restorePoint.files.map((file) => ({
          sourcePath: file.sourcePath, backupPath: file.backupPath,
          beforeHash: file.beforeHash, sizeBytes: file.sizeBytes
        })),
        afterHashes: {
          [targetA]: sha256(Buffer.from('pre-upgrade-after-a\n')),
          [targetB]: sha256(Buffer.from('pre-upgrade-after-b\n'))
        }
      }),
      now, now
    );
    oldDb.close();

    // --- Current application opens the old database and upgrades it. ---
    const upgraded = openWorkspaceDatabase(databasePath);
    openedDatabases.push(upgraded);
    const upgradedStore = new SqliteOperationLogStore(upgraded, WORKSPACE_ID);
    const upgradedRepository = new DurableWorkspaceRepository(upgraded, WORKSPACE_ID);

    assert(upgraded.pragma('quick_check', { simple: true }) === 'ok', 'upgrade: integrity after migration');
    const applied = upgraded.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all() as Array<{
      id: number; checksum: string;
    }>;
    assert(applied.length === SQLITE_MIGRATIONS.length,
      `upgrade: migrations applied=${applied.length}, expected ${SQLITE_MIGRATIONS.length}`);
    for (const migration of SQLITE_MIGRATIONS) {
      assert(applied.find((row) => row.id === migration.id)?.checksum === migrationChecksum(migration),
        `upgrade: migration ${migration.id} checksum mismatch after upgrade`);
    }

    // Old committed data survives the upgrade.
    const upgradedOp = await upgradedStore.get('op-upgrade-committed');
    assert(upgradedOp?.status === 'committed', 'upgrade: committed op lost');
    assert(upgradedOp.files.length === 1, 'upgrade: committed op file operations lost');
    assert(upgradedRepository.getTransaction('tx-upgrade-committed')?.phase === 'committed',
      'upgrade: committed journal row lost');
    assert(upgradedRepository.listRecoveryPoints().some((item) => item.recoveryId === 'recovery-upgrade-committed'),
      'upgrade: recovery point lost');
    assert(upgradedRepository.listAuditEvents().some((item) => item.eventId === 'audit-upgrade-committed'),
      'upgrade: audit event lost');
    // New schema surface exists.
    const hasRollbackTarget = (upgraded.pragma('table_info(patch_history)') as Array<{ name?: string }>).some(
      (column) => column.name === 'rollback_target_uri'
    );
    assert(hasRollbackTarget, 'upgrade: rollback_target_uri column not added');
    const hasJobs = upgraded.prepare(`
SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'background_jobs'
`).get() as { found?: number } | undefined;
    assert(hasJobs?.found === 1, 'upgrade: background_jobs table not added');

    // Pre-upgrade interrupted transaction is repaired with the pre-upgrade backup.
    assert(upgradedRepository.getTransaction(crashTxId)?.phase === 'replacing',
      'upgrade: interrupted journal row not preserved across upgrade');
    const repair = await recoverIncompleteTransactions({ store: upgradedStore, repository: upgradedRepository });
    assert(repair.recovered.some((item) => item.transactionId === crashTxId), 'upgrade: interrupted row not repaired');
    assert((await readFile(targetA)).equals(beforeA), 'upgrade: targetA not restored post-upgrade');
    assert((await readFile(targetB)).equals(beforeB), 'upgrade: targetB not restored post-upgrade');
    assert(upgradedRepository.getTransaction(crashTxId)?.phase === 'rolled_back',
      'upgrade: interrupted journal not terminal after post-upgrade recovery');
    assert((await upgradedStore.get('op-upgrade-crash'))?.status === 'failed',
      'upgrade: interrupted op not marked failed post-upgrade');
    assert(upgraded.pragma('quick_check', { simple: true }) === 'ok', 'upgrade: integrity after recovery');

    console.log(JSON.stringify({
      ok: true,
      message: '安装/升级后恢复验证通过（旧版本 journal 结构在升级后兼容且可恢复）',
      authority: 'partial',
      oldSchemaVersion: OLD_SCHEMA_VERSION,
      currentSchemaVersion: SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]!.id,
      migrationChecksumsPreserved: true,
      committedDataPreserved: true,
      preUpgradeCrashRepairedPostUpgrade: true,
      nonClaims: [
        '升级路径为真实 SQLite 文件从迁移 1..3 升到当前全量；未安装真实产品安装包。',
        '只作用于测试临时 workspace，未触碰原版游戏目录。',
        'partial 只提升本次实际覆盖的 journal/backup 结构兼容恢复路径。'
      ]
    }, null, 2));
  } finally {
    for (const database of openedDatabases) {
      try {
        if (database.open) database.close();
      } catch {
        // already closed or locked; keep going
      }
    }
    await removeRecursivelyWithRetry(root);
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function removeRecursivelyWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(path, { recursive: true, force: true });
}

await main();
