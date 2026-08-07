/**
 * Core journal wiring smoke — W-A-RECOVERY-INTEGRATION-04.
 *
 * Verifies that the full durable-journal phase machine runs on the CORE path
 * with a plain `SqliteOperationLogStore` — no desktop database utility client
 * and no test wrapper — plus the disk-error / ACL fail-closed cases of the
 * recovery entry:
 *
 *   leg-a  core journal machine   — `executePatchIrThroughTransaction` with a
 *          bare `SqliteOperationLogStore` drives pending -> staging ->
 *          validating -> backing_up -> replacing -> marking_committed ->
 *          committed over a real workspace.db, records the recovery point and
 *          the `transaction.committed` audit event through the store's own
 *          journal methods, and leaves nothing to repair.
 *   leg-b  phase transitions      — the store's `createTransaction` /
 *          `transitionTransaction` accept every phase hop, enforce expected
 *          phase (a conflict throws a structured error instead of being
 *          swallowed), and reach `committed` / `rolled_back` / `failed`
 *          terminal states.
 *   leg-c  power-loss recovery    — a `replacing` journal row shaped byte-for-
 *          byte like a real hard kill (backupRoot + restorePointFiles +
 *          afterHashes) is repaired through the core store: originals restored,
 *          leftover sibling temp file removed, journal terminal, `recovery.
 *          repaired` audit recorded, idempotent.
 *   leg-d  disk error / ACL       — (d1) read-only target file: restore fails
 *          closed (`restore_failed`, journal stays non-terminal, structured
 *          RECOVERY_RESTORE_FAILED diagnostic); (d2) undeletable leftover temp
 *          file: restore completes but the failed delete is surfaced as a
 *          RECOVERY_TEMP_CLEANUP_FAILED warning, not swallowed; (d3) corrupt
 *          journal row (garbage state_json / invalid phase): the recovery pass
 *          fails closed with RECOVERY_JOURNAL_READ_FAILED and repairs nothing,
 *          then recovers after the row is repaired.
 *   leg-e  async repository entry  — an async journal facade shaped exactly like
 *          the desktop main process's `OperationLogUtilityClient` drives
 *          `recoverIncompleteTransactions`, so the main-process restart
 *          recovery increment is a direct call over the existing client.
 *
 * Authority cap: partial; only the actually exercised transaction/journal/backup
 * recovery path is claimed. Nothing here touches native game assets.
 */

import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { PatchIR, PatchIrOperation } from '@soulforge/shared';
import { createRestorePoint } from '../backup/restorePoint.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import {
  recoverIncompleteTransactions,
  type RecoverableJournalRepository
} from '../patch/recoveryRepair.js';
import { SqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import {
  DurableWorkspaceRepository,
  type AuditEventRecord,
  type TransactionJournalPhase,
  type TransactionJournalRecord
} from '../storage/durableWorkspaceRepository.js';

const WORKSPACE_A = 'core-journal-wiring-a';
const WORKSPACE_B = 'core-journal-wiring-b';
const WORKSPACE_C = 'core-journal-wiring-c';
const WORKSPACE_D = 'core-journal-wiring-d';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-core-journal-'));
  const results: Record<string, unknown> = {};
  const openedDatabases: Array<{ open: boolean; close(): void }> = [];

  try {
    results.legA = await legACoreJournalMachine(root, openedDatabases);
    results.legB = await legBPhaseTransitions(root, openedDatabases);
    results.legC = await legCPowerLossRecovery(root, openedDatabases);
    results.legD = await legDDiskErrors(root, openedDatabases);
    results.legE = await legEAsyncRepositoryEntry(root, openedDatabases);

    console.log(JSON.stringify({
      ok: true,
      message: '核心 SqliteOperationLogStore 全阶段 journal 接线 + 磁盘错误/ACL 失败关闭 + 异步恢复入口验证通过',
      authority: 'partial',
      legs: results,
      nonClaims: [
        'journal 全阶段状态机在 core 路径以 SqliteOperationLogStore 直接生效（此前仅桌面 databaseUtilityClient 与测试包装生效）。',
        'legE 的 async facade 是 OperationLogUtilityClient 的镜像形状；未在桌面主进程真实接线（并行团队冲突风险，增量待协调者）。',
        '只作用于测试临时 workspace/overlay，未触碰原版游戏目录。',
        '恢复策略为回滚到 before，不自动重放、不 roll-forward。',
        'partial 只提升本次实际覆盖的 transaction/journal/backup 恢复路径。'
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

// ---------------------------------------------------------------------------
// Leg A — full journal machine on the core path via a bare SqliteOperationLogStore
// ---------------------------------------------------------------------------

async function legACoreJournalMachine(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const legRoot = join(root, 'leg-a');
  const overlayRoot = join(legRoot, 'mod');
  const databasePath = join(legRoot, 'workspace.db');
  const backupRoot = join(legRoot, 'backups');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const targetA = join(overlayRoot, 'a.txt');
  const targetB = join(overlayRoot, 'b.bin');
  const targetC = join(overlayRoot, 'c.txt');
  const beforeA = Buffer.from('core-a-before\n');
  const afterA = Buffer.from('core-a-after\n');
  const beforeB = Buffer.from('core-b-before-0123456789\n');
  const afterB = Buffer.from('core-b-after-9876543210\n');
  const beforeC = Buffer.from('core-c-before\n');
  const afterC = Buffer.from('core-c-after\n');
  await writeFile(targetA, beforeA);
  await writeFile(targetB, beforeB);
  await writeFile(targetC, beforeC);

  const database = openWorkspaceDatabase(databasePath);
  openedDatabases.push(database);
  await ensureWorkspaceRow(database, overlayRoot, WORKSPACE_A);
  const store = new SqliteOperationLogStore(database, WORKSPACE_A, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_A);

  const patch = createReplacePatch(WORKSPACE_A, 'op-core-journal-a', [
    { targetPath: targetA, targetUri: 'file://a.txt', before: beforeA, after: afterA },
    { targetPath: targetB, targetUri: 'file://b.bin', before: beforeB, after: afterB },
    { targetPath: targetC, targetUri: 'file://c.txt', before: beforeC, after: afterC }
  ]);

  const committed = await executePatchIrThroughTransaction(patch, {
    workspaceRoot: overlayRoot,
    operationLog: store,
    backupBaseDir: backupRoot,
    author: 'user',
    mode: 'normal'
  });
  assert(committed.operation !== undefined, 'legA: operation record missing');
  assert(committed.diagnostics.every((item) => item.severity !== 'error'),
    `legA: unexpected diagnostics ${JSON.stringify(committed.diagnostics)}`);
  assert(committed.changedFiles.length === 3, `legA: changedFiles=${committed.changedFiles.length}`);
  const txId = committed.operation.transactionId!;
  const journal = repository.getTransaction(txId);
  assert(journal?.phase === 'committed', `legA: journal phase ${journal?.phase}, expected committed`);
  const op = await store.get('op-core-journal-a');
  assert(op?.status === 'committed', `legA: op status ${op?.status}`);
  assert(op.files.length === 3, `legA: op files=${op.files.length}`);
  assert((await readFile(targetA)).equals(afterA), 'legA: a.txt re-read mismatch');
  assert((await readFile(targetB)).equals(afterB), 'legA: b.bin re-read mismatch');
  assert((await readFile(targetC)).equals(afterC), 'legA: c.txt re-read mismatch');
  const backupA = await readFile(op.files.find((file) => file.targetPath === targetA)!.backupPath);
  assert(backupA.equals(beforeA), 'legA: a.txt backup does not hold before bytes');
  assert(repository.listRecoveryPoints().length === 1, 'legA: recovery point not recorded');
  assert(repository.listAuditEvents().some((event) => event.eventKind === 'transaction.committed'),
    'legA: transaction.committed audit event missing');
  assert(database.pragma('quick_check', { simple: true }) === 'ok', 'legA: integrity after commit');
  const repair = await recoverIncompleteTransactions({ store, repository });
  assert(repair.recovered.length === 0, 'legA: nothing should need repair after clean commit');

  const recoveryPointCount = repository.listRecoveryPoints().length;
  store.close();
  database.close();
  openedDatabases.pop();

  return {
    journalPhase: 'committed',
    opStatus: 'committed',
    changedFiles: 3,
    recoveryPoints: recoveryPointCount,
    transactionCommittedAudit: true,
    cleanAfterCommit: repair.recovered.length === 0
  };
}

// ---------------------------------------------------------------------------
// Leg B — every phase hop through the store's own journal methods
// ---------------------------------------------------------------------------

async function legBPhaseTransitions(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const legRoot = join(root, 'leg-b');
  const overlayRoot = join(legRoot, 'mod');
  const databasePath = join(legRoot, 'workspace.db');
  await mkdir(overlayRoot, { recursive: true });
  const database = openWorkspaceDatabase(databasePath);
  openedDatabases.push(database);
  await ensureWorkspaceRow(database, overlayRoot, WORKSPACE_B);
  const store = new SqliteOperationLogStore(database, WORKSPACE_B, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_B);
  const now = new Date().toISOString();

  // Full commit path pending -> ... -> committed.
  const txId = 'tx-core-phases';
  await store.createTransaction({
    transactionId: txId, opId: 'op-core-phases', phase: 'pending',
    state: { operationCount: 1 }, createdAt: now, updatedAt: now
  });
  const hops: Array<[import('../storage/durableWorkspaceRepository.js').TransactionJournalPhase,
    import('../storage/durableWorkspaceRepository.js').TransactionJournalPhase, unknown]> = [
    ['pending', 'staging', { operationCount: 1 }],
    ['staging', 'validating', { staged: true }],
    ['validating', 'backing_up', { validated: true }],
    ['backing_up', 'replacing', { backupRoot: 'leg-b-backups' }],
    ['replacing', 'marking_committed', { committedPaths: [] }],
    ['marking_committed', 'committed', { changedFileCount: 0 }]
  ];
  for (const [expected, next, state] of hops) {
    const row = await store.transitionTransaction({
      transactionId: txId, expectedPhase: expected, nextPhase: next, state
    });
    assert(row.phase === next, `legB: hop ${expected}->${next} returned ${row.phase}`);
  }
  assert(repository.getTransaction(txId)?.phase === 'committed', 'legB: committed row lost');

  // Phase conflict must throw (not swallow).
  let conflictThrown = false;
  try {
    await store.transitionTransaction({
      transactionId: txId, expectedPhase: 'staging', nextPhase: 'failed', state: {}
    });
  } catch (error) {
    conflictThrown = /phase conflict/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(conflictThrown, 'legB: expected-phase conflict did not throw a structured error');

  // rolled_back via an expected-phase array.
  const rolledBackTx = 'tx-core-rolled-back';
  await store.createTransaction({
    transactionId: rolledBackTx, opId: 'op-core-rolled-back', phase: 'pending',
    state: { operationCount: 1 }, createdAt: now, updatedAt: now
  });
  await store.transitionTransaction({
    transactionId: rolledBackTx, expectedPhase: 'pending', nextPhase: 'replacing',
    state: { backupRoot: 'leg-b-rollback-backups' }
  });
  const rolled = await store.transitionTransaction({
    transactionId: rolledBackTx, expectedPhase: ['backing_up', 'replacing'], nextPhase: 'rolled_back',
    state: { reason: 'test' }
  });
  assert(rolled.phase === 'rolled_back', `legB: rolled_back phase ${rolled.phase}`);

  // failed terminal state.
  const failedTx = 'tx-core-failed';
  await store.createTransaction({
    transactionId: failedTx, opId: 'op-core-failed', phase: 'pending',
    state: { operationCount: 1 }, createdAt: now, updatedAt: now
  });
  const failed = await store.transitionTransaction({
    transactionId: failedTx, expectedPhase: 'pending', nextPhase: 'failed',
    state: { phase: 'stage' }
  });
  assert(failed.phase === 'failed', `legB: failed phase ${failed.phase}`);

  // recordRecoveryPoint + appendAuditEvent via the store.
  await store.recordRecoveryPoint({
    recoveryId: 'recovery-core-b', opId: 'op-core-phases', rootPath: join(legRoot, 'backups'),
    sizeBytes: 12, state: 'active', createdAt: now, metadata: { fileCount: 1 }
  });
  await store.appendAuditEvent({
    eventId: 'audit-core-b', eventKind: 'recovery.repaired', opId: 'op-core-phases',
    transactionId: txId, payload: { nextPhase: 'committed' }, createdAt: now
  });
  assert(repository.listRecoveryPoints().some((item) => item.recoveryId === 'recovery-core-b'),
    'legB: recovery point via store missing');
  assert(repository.listAuditEvents().some((event) => event.eventId === 'audit-core-b'),
    'legB: audit event via store missing');
  assert(database.pragma('quick_check', { simple: true }) === 'ok', 'legB: integrity');

  store.close();
  database.close();
  openedDatabases.pop();

  return {
    hops: hops.map(([expected, next]) => `${expected}->${next}`),
    conflictThrowsStructured: true,
    terminalStates: ['committed', 'rolled_back', 'failed'],
    recoveryPointAndAuditViaStore: true
  };
}

// ---------------------------------------------------------------------------
// Leg C — power-loss recovery driven through the core store
// ---------------------------------------------------------------------------

async function legCPowerLossRecovery(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const legRoot = join(root, 'leg-c');
  const overlayRoot = join(legRoot, 'mod');
  const databasePath = join(legRoot, 'workspace.db');
  const backupRoot = join(legRoot, 'backups');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const targetA = join(overlayRoot, 'a.txt');
  const targetB = join(overlayRoot, 'b.txt');
  const targetC = join(overlayRoot, 'c.txt');
  const beforeA = Buffer.from('crash-before-a\n');
  const afterA = Buffer.from('crash-after-a-partially-committed\n');
  const beforeB = Buffer.from('crash-before-b\n');
  const afterB = Buffer.from('crash-after-b\n');
  const beforeC = Buffer.from('crash-before-c\n');
  const afterC = Buffer.from('crash-after-c\n');
  await writeFile(targetA, beforeA);
  await writeFile(targetB, beforeB);
  await writeFile(targetC, beforeC);

  const database = openWorkspaceDatabase(databasePath);
  openedDatabases.push(database);
  await ensureWorkspaceRow(database, overlayRoot, WORKSPACE_C);
  const store = new SqliteOperationLogStore(database, WORKSPACE_C, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_C);

  // Real restore point, shaped like durablePatchCommit's backing_up -> replacing
  // transition after a hard kill.
  const restorePoint = await createRestorePoint({
    sourcePaths: [targetA, targetB, targetC],
    baseDir: backupRoot,
    label: 'leg-c-crash'
  });
  const crashTxId = 'tx-core-crash';
  const now = new Date().toISOString();
  await store.record({
    opId: 'op-core-crash', workspaceId: WORKSPACE_C, title: 'core journal crash',
    author: 'user', mode: 'normal', status: 'pending',
    createdAt: now, files: [], diagnostics: []
  });
  await store.createTransaction({
    transactionId: crashTxId, opId: 'op-core-crash', phase: 'pending',
    state: { operationCount: 3 }, createdAt: now, updatedAt: now
  });
  await store.transitionTransaction({
    transactionId: crashTxId, expectedPhase: 'pending', nextPhase: 'replacing',
    state: {
      backupRoot: restorePoint.root,
      sizeBytes: restorePoint.sizeBytes,
      restorePointFiles: restorePoint.files.map((file) => ({
        sourcePath: file.sourcePath,
        backupPath: file.backupPath,
        beforeHash: file.beforeHash,
        sizeBytes: file.sizeBytes
      })),
      afterHashes: {
        [targetA]: sha256(afterA),
        [targetB]: sha256(afterB),
        [targetC]: sha256(afterC)
      }
    }
  });
  await store.updateStatus('op-core-crash', 'pending', { transactionId: crashTxId });

  // Partial commit: only a.txt replaced; an orphaned sibling temp file remains.
  await writeFile(targetA, afterA);
  const orphanTemp = join(overlayRoot, `.soulforge-${crashTxId}-${basename(targetB)}.tmp`);
  await writeFile(orphanTemp, 'leftover', 'utf8');

  const repair = await recoverIncompleteTransactions({ store, repository });
  assert(repair.recovered.length === 1, `legC: recovered=${repair.recovered.length}`);
  const recovered = repair.recovered[0]!;
  assert(recovered.action === 'rolled_back', `legC: action ${recovered.action}`);
  assert(recovered.restoredFiles.length === 3, `legC: restored=${recovered.restoredFiles.length}`);
  assert(recovered.removedTempFiles.includes(orphanTemp),
    `legC: orphan temp ${orphanTemp} not covered by cleanup`);
  assert((await readFile(targetA)).equals(beforeA), 'legC: a.txt not restored to before');
  assert((await readFile(targetB)).equals(beforeB), 'legC: b.txt changed');
  assert((await readFile(targetC)).equals(beforeC), 'legC: c.txt changed');
  assert(repository.getTransaction(crashTxId)?.phase === 'rolled_back', 'legC: journal not terminal');
  assert((await store.get('op-core-crash'))?.status === 'failed', 'legC: op not marked failed');
  assert(repository.listAuditEvents().some((event) => event.eventKind === 'recovery.repaired'),
    'legC: recovery.repaired audit missing');
  assert((await listTempFiles(overlayRoot)).length === 0, 'legC: leftover temp files after recovery');
  assert(database.pragma('quick_check', { simple: true }) === 'ok', 'legC: integrity after recovery');
  const second = await recoverIncompleteTransactions({ store, repository });
  assert(second.recovered.length === 0, 'legC: recovery not idempotent');

  store.close();
  database.close();
  openedDatabases.pop();

  return {
    action: 'rolled_back',
    restoredFiles: 3,
    orphanTempCleaned: true,
    journalTerminal: true,
    recoveryAudit: true,
    idempotent: true
  };
}

// ---------------------------------------------------------------------------
// Leg D — disk error / ACL fail-closed
// ---------------------------------------------------------------------------

async function legDDiskErrors(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const d1 = await legDReadOnlyTarget(root, openedDatabases);
  const d2 = await legDTempCleanupFailure(root, openedDatabases);
  const d3 = await legDCorruptJournal(root, openedDatabases);
  const d4 = await legDRestoreVerifyMismatch(root, openedDatabases);
  return {
    readOnlyTarget: d1,
    tempCleanupFailure: d2,
    corruptJournal: d3,
    restoreVerifyMismatch: d4
  };
}

/**
 * legD4：还原「成功」但还原后哈希与 journal 记录的 beforeHash 不一致。
 *
 * 为什么必须单独覆盖：recoveryRepair 有四个失败出口，此前三个各有唯一覆盖者
 * （corruption_blocked、restore_failed 的 copyFile 失败分支、marked_failed），
 * 而 RECOVERY_RESTORE_VERIFY_FAILED（recoveryRepair.ts:219-227）**无人覆盖**。
 *
 * 它守的场景比 copyFile 失败更隐蔽：还原动作本身报成功，但落地字节与预期不符
 * ——备份文件被外部改动、磁盘静默损坏、或备份与 journal 记录的哈希本就不匹配。
 * 这类情况下 journal 必须**保持非终态**，因为把它标成 rolled_back 等于声称
 * 「已回到原始状态」，而磁盘上的字节并不是原始字节。恢复边界上最不能出现的
 * 就是这种「声称已恢复但实际没有」。
 *
 * 构造方式：备份目录里的备份文件被替换成第三种内容。restoreFromPoint 会成功
 * 把它拷回目标（copyFile 不校验内容），随后的哈希复验必然失败——这正是该分支
 * 的真实触发条件，不是人为注入的假失败。
 */
async function legDRestoreVerifyMismatch(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const legRoot = join(root, 'leg-d4');
  const overlayRoot = join(legRoot, 'mod');
  const databasePath = join(legRoot, 'workspace.db');
  const backupRoot = join(legRoot, 'backups');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const target = join(overlayRoot, 'verify.txt');
  const before = Buffer.from('verify-before\n');
  const after = Buffer.from('verify-after\n');
  await writeFile(target, before);

  const database = openWorkspaceDatabase(databasePath);
  openedDatabases.push(database);
  await ensureWorkspaceRow(database, overlayRoot, WORKSPACE_D);
  const store = new SqliteOperationLogStore(database, WORKSPACE_D, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_D);

  const restorePoint = await createRestorePoint({
    sourcePaths: [target], baseDir: backupRoot, label: 'leg-d4'
  });
  const txId = 'tx-core-d4';
  const now = new Date().toISOString();
  await store.record({
    opId: 'op-core-d4', workspaceId: WORKSPACE_D, title: 'leg d4 restore verify',
    author: 'user', mode: 'normal', status: 'pending',
    createdAt: now, files: [], diagnostics: []
  });
  await store.createTransaction({
    transactionId: txId, opId: 'op-core-d4', phase: 'replacing',
    state: {
      backupRoot: restorePoint.root,
      sizeBytes: restorePoint.sizeBytes,
      restorePointFiles: restorePoint.files.map((file) => ({
        sourcePath: file.sourcePath, backupPath: file.backupPath,
        beforeHash: file.beforeHash, sizeBytes: file.sizeBytes
      })),
      afterHashes: { [target]: sha256(after) }
    },
    createdAt: now, updatedAt: now
  });

  try {
    // 目标处于「中断后的写入结果」状态。
    await writeFile(target, after);
    // 备份被外部改成第三种内容：还原会成功，但复验必然失败。
    const backupPath = restorePoint.files[0]!.backupPath;
    await writeFile(backupPath, Buffer.from('verify-tampered-backup\n'));

    const repair = await recoverIncompleteTransactions({ store, repository });
    const outcome = repair.recovered.find((item) => item.transactionId === txId);
    assert(outcome?.action === 'restore_failed', `legD4: action ${outcome?.action}`);
    assert(
      repair.diagnostics.some((item) => item.code === 'RECOVERY_RESTORE_VERIFY_FAILED'),
      'legD4: RECOVERY_RESTORE_VERIFY_FAILED diagnostic missing'
    );
    // journal 必须保持非终态：标成 rolled_back 等于声称已回到原始状态，
    // 而磁盘上的字节并不是原始字节。
    assert(
      repository.getTransaction(txId)?.phase === 'replacing',
      'legD4: journal must stay non-terminal after restore verify failure'
    );
    // 诊断必须带上实测哈希，否则操作员无法判断现场到底是什么状态。
    const verifyDiagnostic = repair.diagnostics.find(
      (item) => item.code === 'RECOVERY_RESTORE_VERIFY_FAILED'
    );
    const details = verifyDiagnostic?.details as { errors?: unknown[] } | undefined;
    assert(
      Array.isArray(details?.errors) && details.errors.length > 0,
      'legD4: verify diagnostic must report which paths mismatched'
    );
    assert(database.pragma('quick_check', { simple: true }) === 'ok', 'legD4: integrity');
  } finally {
    store.close();
    database.close();
    openedDatabases.pop();
  }
  return {
    action: 'restore_failed',
    journalNonTerminal: true,
    diagnosticCode: 'RECOVERY_RESTORE_VERIFY_FAILED'
  };
}

async function legDReadOnlyTarget(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const legRoot = join(root, 'leg-d1');
  const overlayRoot = join(legRoot, 'mod');
  const databasePath = join(legRoot, 'workspace.db');
  const backupRoot = join(legRoot, 'backups');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const targetA = join(overlayRoot, 'a.txt');
  const targetB = join(overlayRoot, 'b.txt');
  const beforeA = Buffer.from('ro-before-a\n');
  const afterA = Buffer.from('ro-after-a\n');
  const beforeB = Buffer.from('ro-before-b\n');
  const afterB = Buffer.from('ro-after-b\n');
  await writeFile(targetA, beforeA);
  await writeFile(targetB, beforeB);

  const database = openWorkspaceDatabase(databasePath);
  openedDatabases.push(database);
  await ensureWorkspaceRow(database, overlayRoot, WORKSPACE_D);
  const store = new SqliteOperationLogStore(database, WORKSPACE_D, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_D);

  const restorePoint = await createRestorePoint({
    sourcePaths: [targetA, targetB], baseDir: backupRoot, label: 'leg-d1'
  });
  const txId = 'tx-core-d1';
  const now = new Date().toISOString();
  await store.record({
    opId: 'op-core-d1', workspaceId: WORKSPACE_D, title: 'leg d1 read-only',
    author: 'user', mode: 'normal', status: 'pending',
    createdAt: now, files: [], diagnostics: []
  });
  await store.createTransaction({
    transactionId: txId, opId: 'op-core-d1', phase: 'replacing',
    state: {
      backupRoot: restorePoint.root,
      sizeBytes: restorePoint.sizeBytes,
      restorePointFiles: restorePoint.files.map((file) => ({
        sourcePath: file.sourcePath, backupPath: file.backupPath,
        beforeHash: file.beforeHash, sizeBytes: file.sizeBytes
      })),
      afterHashes: { [targetA]: sha256(afterA), [targetB]: sha256(afterB) }
    },
    createdAt: now, updatedAt: now
  });

  try {
    // Make the first target read-only so the restore's copyFile fails (Windows EPERM).
    chmodSync(targetA, 0o444);
    const repair = await recoverIncompleteTransactions({ store, repository });
    const outcome = repair.recovered.find((item) => item.transactionId === txId);
    assert(outcome?.action === 'restore_failed', `legD1: action ${outcome?.action}`);
    assert(repair.diagnostics.some((item) => item.code === 'RECOVERY_RESTORE_FAILED'),
      'legD1: RECOVERY_RESTORE_FAILED diagnostic missing');
    assert(repository.getTransaction(txId)?.phase === 'replacing',
      'legD1: journal must stay non-terminal after restore failure');
    // Read-only target must be untouched (restore was blocked, not a silent no-op).
    assert((await readFile(targetA)).equals(beforeA), 'legD1: read-only target modified');
    assert(database.pragma('quick_check', { simple: true }) === 'ok', 'legD1: integrity');
  } finally {
    chmodSync(targetA, 0o644);
    store.close();
    database.close();
    openedDatabases.pop();
  }
  return { action: 'restore_failed', journalNonTerminal: true, diagnosticCode: 'RECOVERY_RESTORE_FAILED' };
}

async function legDTempCleanupFailure(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const legRoot = join(root, 'leg-d2');
  const overlayRoot = join(legRoot, 'mod');
  const databasePath = join(legRoot, 'workspace.db');
  const backupRoot = join(legRoot, 'backups');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const targetA = join(overlayRoot, 'a.txt');
  const beforeA = Buffer.from('d2-before-a\n');
  const afterA = Buffer.from('d2-after-a\n');
  await writeFile(targetA, beforeA);

  const database = openWorkspaceDatabase(databasePath);
  openedDatabases.push(database);
  await ensureWorkspaceRow(database, overlayRoot, WORKSPACE_D);
  const store = new SqliteOperationLogStore(database, WORKSPACE_D, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_D);

  const restorePoint = await createRestorePoint({
    sourcePaths: [targetA], baseDir: backupRoot, label: 'leg-d2'
  });
  const txId = 'tx-core-d2';
  const now = new Date().toISOString();
  await store.record({
    opId: 'op-core-d2', workspaceId: WORKSPACE_D, title: 'leg d2 temp cleanup',
    author: 'user', mode: 'normal', status: 'pending',
    createdAt: now, files: [], diagnostics: []
  });
  await store.createTransaction({
    transactionId: txId, opId: 'op-core-d2', phase: 'replacing',
    state: {
      backupRoot: restorePoint.root,
      sizeBytes: restorePoint.sizeBytes,
      restorePointFiles: restorePoint.files.map((file) => ({
        sourcePath: file.sourcePath, backupPath: file.backupPath,
        beforeHash: file.beforeHash, sizeBytes: file.sizeBytes
      })),
      afterHashes: { [targetA]: sha256(afterA) }
    },
    createdAt: now, updatedAt: now
  });

  // Occupy the expected sibling temp path with a non-empty directory so a
  // non-recursive rm fails (ERR_FS_EISDIR on Windows).
  const tempDirPath = join(overlayRoot, `.soulforge-${txId}-${basename(targetA)}.tmp`);
  await mkdir(tempDirPath, { recursive: true });
  await writeFile(join(tempDirPath, 'inner.txt'), 'occupied', 'utf8');

  try {
    const repair = await recoverIncompleteTransactions({ store, repository });
    const outcome = repair.recovered.find((item) => item.transactionId === txId);
    // Restore succeeds (verified before-bytes), so the journal terminates.
    assert(outcome?.action === 'rolled_back', `legD2: action ${outcome?.action}`);
    assert((await readFile(targetA)).equals(beforeA), 'legD2: target not restored');
    assert(repository.getTransaction(txId)?.phase === 'rolled_back', 'legD2: journal not terminal');
    // The failed delete is surfaced, not swallowed.
    assert(repair.diagnostics.some((item) => item.code === 'RECOVERY_TEMP_CLEANUP_FAILED'),
      'legD2: RECOVERY_TEMP_CLEANUP_FAILED diagnostic missing');
    const second = await recoverIncompleteTransactions({ store, repository });
    assert(second.recovered.length === 0, 'legD2: recovery not idempotent');
  } finally {
    // Unlock the occupied temp dir so recursive cleanup can proceed.
    await rm(tempDirPath, { recursive: true, force: true });
    store.close();
    database.close();
    openedDatabases.pop();
  }
  return { action: 'rolled_back', journalTerminal: true, tempDeleteFailureSurfaced: true };
}

async function legDCorruptJournal(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const legRoot = join(root, 'leg-d3');
  const overlayRoot = join(legRoot, 'mod');
  const databasePath = join(legRoot, 'workspace.db');
  await mkdir(overlayRoot, { recursive: true });
  const database = openWorkspaceDatabase(databasePath);
  openedDatabases.push(database);
  await ensureWorkspaceRow(database, overlayRoot, WORKSPACE_D);
  const store = new SqliteOperationLogStore(database, WORKSPACE_D, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_D);
  const now = new Date().toISOString();

  // Two non-terminal rows: one with garbage state_json, one with an invalid phase.
  await store.createTransaction({
    transactionId: 'tx-core-d3-json', opId: 'op-core-d3-json', phase: 'staging',
    state: { operationCount: 1 }, createdAt: now, updatedAt: now
  });
  await store.createTransaction({
    transactionId: 'tx-core-d3-phase', opId: 'op-core-d3-phase', phase: 'staging',
    state: { operationCount: 1 }, createdAt: now, updatedAt: now
  });
  database.prepare(`UPDATE transaction_journal SET state_json = ? WHERE transaction_id = ?`)
    .run('{{{ this is not json', 'tx-core-d3-json');
  database.prepare(`UPDATE transaction_journal SET phase = ? WHERE transaction_id = ?`)
    .run('bogus-phase', 'tx-core-d3-phase');

  try {
    // Fail closed: the pass repairs nothing and surfaces a structured diagnostic.
    const repair = await recoverIncompleteTransactions({ store, repository });
    assert(repair.recovered.length === 0, 'legD3: corrupt journal must block the whole pass');
    const failed = repair.diagnostics.find((item) => item.code === 'RECOVERY_JOURNAL_READ_FAILED');
    assert(failed !== undefined, 'legD3: RECOVERY_JOURNAL_READ_FAILED diagnostic missing');
    const failedDetails = failed.details && typeof failed.details === 'object'
      ? failed.details as Record<string, unknown>
      : {};
    assert(typeof failedDetails.error === 'string' && failedDetails.error.length > 0,
      'legD3: underlying corruption message was swallowed');
    // Corrupt rows stay byte-for-byte untouched (raw reads: the repository would
    // throw while hydrating the corrupt state_json, which is exactly the failure
    // the recovery pass surfaced instead of swallowing).
    const rowJsonPhase = database.prepare(
      'SELECT phase FROM transaction_journal WHERE transaction_id = ?'
    ).get('tx-core-d3-json') as { phase?: unknown };
    const rowPhasePhase = database.prepare(
      'SELECT phase FROM transaction_journal WHERE transaction_id = ?'
    ).get('tx-core-d3-phase') as { phase?: unknown };
    assert(rowJsonPhase?.phase === 'staging', 'legD3: corrupt-state row must stay untouched');
    assert(rowPhasePhase?.phase === 'bogus-phase', 'legD3: corrupt-phase row must stay untouched');
    assert(database.pragma('quick_check', { simple: true }) === 'ok', 'legD3: integrity while blocked');

    // After the rows are repaired, recovery completes.
    database.prepare(`UPDATE transaction_journal SET state_json = ? WHERE transaction_id = ?`)
      .run('{}', 'tx-core-d3-json');
    database.prepare(`UPDATE transaction_journal SET phase = ? WHERE transaction_id = ?`)
      .run('staging', 'tx-core-d3-phase');
    const second = await recoverIncompleteTransactions({ store, repository });
    assert(second.recovered.length === 2,
      `legD3: recovered=${second.recovered.length} after rows repaired`);
    assert(second.recovered.every((item) => item.action === 'marked_failed'),
      'legD3: repaired rows should be marked_failed (no backup metadata)');
    assert(repository.listIncompleteTransactions().length === 0, 'legD3: not terminal after repair');
  } finally {
    store.close();
    database.close();
    openedDatabases.pop();
  }
  return {
    passBlockedWithDiagnostic: 'RECOVERY_JOURNAL_READ_FAILED',
    rowsUntouchedWhileBlocked: true,
    recoveredAfterRowsRepaired: 2
  };
}

// ---------------------------------------------------------------------------
// Leg E — async repository facade drives the recovery entry
//
// The desktop main process's `OperationLogUtilityClient` exposes the exact
// async journal surface (`listIncompleteTransactions` / `transitionTransaction`
// / `appendAuditEvent`) and can therefore act as the `RecoverableJournalRepository`
// for `recoverIncompleteTransactions`. This leg proves an async facade with the
// client's shapes repairs a real crash journal identically to a synchronous
// repository, so the main-process restart recovery increment is a direct call.
// ---------------------------------------------------------------------------

class AsyncJournalFacade implements RecoverableJournalRepository {
  constructor(private readonly repository: DurableWorkspaceRepository) {}

  async listIncompleteTransactions(): Promise<TransactionJournalRecord[]> {
    return this.repository.listIncompleteTransactions();
  }
  async transitionTransaction(options: {
    transactionId: string;
    expectedPhase: TransactionJournalPhase | TransactionJournalPhase[];
    nextPhase: TransactionJournalPhase;
    state: unknown;
    updatedAt?: string;
  }): Promise<TransactionJournalRecord> {
    return this.repository.transitionTransaction(options);
  }
  async appendAuditEvent(
    event: Omit<AuditEventRecord, 'workspaceId' | 'eventId'> & { eventId?: string }
  ): Promise<AuditEventRecord> {
    return this.repository.appendAuditEvent(event);
  }
}

async function legEAsyncRepositoryEntry(
  root: string,
  openedDatabases: Array<{ open: boolean; close(): void }>
): Promise<Record<string, unknown>> {
  const legRoot = join(root, 'leg-e');
  const overlayRoot = join(legRoot, 'mod');
  const databasePath = join(legRoot, 'workspace.db');
  const backupRoot = join(legRoot, 'backups');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const targetA = join(overlayRoot, 'a.txt');
  const beforeA = Buffer.from('leg-e-before-a\n');
  const afterA = Buffer.from('leg-e-after-a\n');
  await writeFile(targetA, beforeA);

  const database = openWorkspaceDatabase(databasePath);
  openedDatabases.push(database);
  await ensureWorkspaceRow(database, overlayRoot, WORKSPACE_C);
  const store = new SqliteOperationLogStore(database, WORKSPACE_C, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_C);

  const restorePoint = await createRestorePoint({
    sourcePaths: [targetA], baseDir: backupRoot, label: 'leg-e'
  });
  const txId = 'tx-core-leg-e';
  const now = new Date().toISOString();
  await store.record({
    opId: 'op-core-leg-e', workspaceId: WORKSPACE_C, title: 'leg e async facade',
    author: 'user', mode: 'normal', status: 'pending',
    createdAt: now, files: [], diagnostics: []
  });
  await store.createTransaction({
    transactionId: txId, opId: 'op-core-leg-e', phase: 'replacing',
    state: {
      backupRoot: restorePoint.root,
      sizeBytes: restorePoint.sizeBytes,
      restorePointFiles: restorePoint.files.map((file) => ({
        sourcePath: file.sourcePath, backupPath: file.backupPath,
        beforeHash: file.beforeHash, sizeBytes: file.sizeBytes
      })),
      afterHashes: { [targetA]: sha256(afterA) }
    },
    createdAt: now, updatedAt: now
  });
  // Partial commit (a.txt holds after-bytes) then recover through the facade.
  await writeFile(targetA, afterA);

  const facade = new AsyncJournalFacade(repository);
  const repair = await recoverIncompleteTransactions({ store, repository: facade });
  assert(repair.recovered.length === 1, `legE: recovered=${repair.recovered.length}`);
  assert(repair.recovered[0]!.action === 'rolled_back', `legE: action ${repair.recovered[0]!.action}`);
  assert((await readFile(targetA)).equals(beforeA), 'legE: a.txt not restored to before');
  assert(repository.getTransaction(txId)?.phase === 'rolled_back', 'legE: journal not terminal via facade');
  assert(repository.listAuditEvents().some((event) => event.eventKind === 'recovery.repaired'),
    'legE: recovery.repaired audit missing via facade');
  assert(database.pragma('quick_check', { simple: true }) === 'ok', 'legE: integrity');

  store.close();
  database.close();
  openedDatabases.pop();

  return {
    asyncFacadeDrivesRecovery: true,
    action: 'rolled_back',
    journalTerminal: true,
    recoveryAudit: true
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReplacePatch(
  workspaceId: string,
  patchId: string,
  items: Array<{ targetPath: string; targetUri: string; before: Buffer; after: Buffer }>
): PatchIR {
  const patch = createPatchIr({
    workspaceId,
    title: `core journal wiring ${patchId}`,
    author: 'user',
    operations: items.map<PatchIrOperation>((item, index) => ({
      id: `${patchId}-${index}`,
      kind: 'file_replace',
      targetUri: item.targetUri,
      targetPath: item.targetPath,
      resourceKind: 'other',
      newContentBase64: item.after.toString('base64'),
      expectedHash: sha256(item.before),
      preconditions: [{
        type: 'content_hash',
        description: 'original bytes must match',
        expectedHash: sha256(item.before)
      }],
      validatorRequirements: [
        { validatorId: 'whole_file_replace', scope: 'staged_output', required: true }
      ],
      riskLevel: 'low'
    }))
  });
  patch.patchId = patchId;
  return patch;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function ensureWorkspaceRow(
  database: ReturnType<typeof openWorkspaceDatabase>,
  rootPath: string,
  workspaceId: string
): Promise<void> {
  const now = new Date().toISOString();
  database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
  root_path = excluded.root_path,
  game = excluded.game,
  updated_at = excluded.updated_at
`).run(workspaceId, rootPath, 'sekiro', now, now);
}

async function listTempFiles(overlayRoot: string): Promise<string[]> {
  const entries = await readdir(overlayRoot);
  return entries.filter((name) => name.startsWith('.soulforge-') && name.endsWith('.tmp'));
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

await main();
