/**
 * Cross-session journal consistency smoke — W-A-RECOVERY-INTEGRATION-04.
 *
 * Uses one real workspace (SQLite workspace.db + real overlay) across multiple
 * open -> write -> close -> reopen sessions and verifies the durable journal /
 * operation log / backup remain consistent:
 *
 *   Session 1  — commits op1 (2 files) through the full
 *                pending -> ... -> committed journal machine.
 *   Session 2  — reopens and asserts op1 appears exactly once with 2 file
 *                operations, its backup holds the exact before-bytes, and there
 *                are no incomplete journal rows. Then rolls op1 back through the
 *                persisted backup (cross-session rollback) and commits op2.
 *   Session 3  — reopens and asserts op1 (original, immutable), its inverse, and
 *                op2 each appear exactly once with no duplicates, every journal
 *                row is terminal, and the three recovery points are present.
 *                Leaves an in-flight (non-terminal) transaction behind.
 *   Session 4  — reopens and discovers the in-flight journal row, repairs it
 *                (`marked_failed`, no files touched), and asserts the history is
 *                still duplicate-free and loss-free.
 *
 * Authority cap: partial; only the actually exercised transaction/journal/backup
 * recovery path is claimed.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PatchIR, PatchIrOperation } from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { recoverIncompleteTransactions } from '../patch/recoveryRepair.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { openSessionStore } from './journalWiringStore.js';

const WORKSPACE_ID = 'cross-session-journal-smoke';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-cross-session-'));
  const overlayRoot = join(root, 'mod');
  const databasePath = join(root, 'workspace.db');
  const backupRoot = join(root, 'backups');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const target1 = join(overlayRoot, 'cross-a.txt');
  const target2 = join(overlayRoot, 'cross-b.txt');
  const target3 = join(overlayRoot, 'cross-c.txt');
  const target4 = join(overlayRoot, 'cross-d.txt');
  const before1 = Buffer.from('session-1-before-a\n');
  const after1 = Buffer.from('session-1-after-a\n');
  const before2 = Buffer.from('session-1-before-b\n');
  const after2 = Buffer.from('session-1-after-b\n');
  const before3 = Buffer.from('session-2-before-c\n');
  const after3 = Buffer.from('session-2-after-c\n');
  const before4 = Buffer.from('session-2-before-d\n');
  const after4 = Buffer.from('session-2-after-d\n');
  await writeFile(target1, before1);
  await writeFile(target2, before2);

  const results: Record<string, unknown> = {};
  const openedDatabases: Array<{ open: boolean; close(): void }> = [];

  try {
    // --- Session 1: open, commit op1, close. ---
    const session1 = openSessionStore(databasePath, WORKSPACE_ID, overlayRoot);
    openedDatabases.push(session1.database);
    const op1 = createReplacePatch(
      'op-session-1',
      'session 1',
      [
        { targetPath: target1, targetUri: 'file://cross-a.txt', before: before1, after: after1 },
        { targetPath: target2, targetUri: 'file://cross-b.txt', before: before2, after: after2 }
      ]
    );
    const committed1 = await executePatchIrThroughTransaction(op1, {
      workspaceRoot: overlayRoot,
      operationLog: session1.store,
      backupBaseDir: backupRoot,
      author: 'user',
      mode: 'normal'
    });
    assert(committed1.operation !== undefined && committed1.changedFiles.length === 2,
      'session1: op1 commit failed');
    assert(session1.repository.getTransaction(committed1.operation.transactionId!)?.phase === 'committed',
      'session1: op1 journal not committed');
    session1.store.close();

    // --- Session 2: reopen, verify op1 exactly once, roll it back, commit op2, close. ---
    const session2 = openSessionStore(databasePath, WORKSPACE_ID, overlayRoot);
    openedDatabases.push(session2.database);
    const s2List = await session2.store.list();
    assert(s2List.length === 1, `session2: expected exactly 1 op, got ${s2List.length}`);
    const s2op1 = await session2.store.get('op-session-1');
    assert(s2op1?.status === 'committed', 'session2: op1 status lost across session');
    assert(s2op1.files.length === 2, 'session2: op1 file operations lost across session');
    assert(session2.repository.listIncompleteTransactions().length === 0,
      'session2: unexpected incomplete journal rows');
    const s2backup = await readFile(s2op1.files.find((file) => file.targetPath === target1)!.backupPath);
    assert(s2backup.equals(before1), 'session2: backup before-bytes mismatch');
    results.session2ReopenConsistent = true;

    const rollback = await rollbackOperation({
      opId: 'op-session-1',
      store: session2.store,
      session: await openWorkspaceSession({ overlayRoot, game: 'sekiro' }),
      backupBaseDir: backupRoot,
      author: 'user',
      confirmation: createConfirmationReceipt({
        subjects: ['ROLLBACK_OPERATION:op-session-1'],
        riskLevel: 'high'
      })
    });
    assert(rollback.ok && rollback.restoredFiles.length === 2,
      `session2: cross-session rollback failed: ${JSON.stringify(rollback.diagnostics)}`);
    assert((await readFile(target1)).equals(before1), 'session2: rollback did not restore target1');
    assert((await readFile(target2)).equals(before2), 'session2: rollback did not restore target2');
    results.crossSessionRollback = true;

    await writeFile(target3, before3);
    await writeFile(target4, before4);
    const op2 = createReplacePatch(
      'op-session-2',
      'session 2',
      [
        { targetPath: target3, targetUri: 'file://cross-c.txt', before: before3, after: after3 },
        { targetPath: target4, targetUri: 'file://cross-d.txt', before: before4, after: after4 }
      ]
    );
    const committed2 = await executePatchIrThroughTransaction(op2, {
      workspaceRoot: overlayRoot,
      operationLog: session2.store,
      backupBaseDir: backupRoot,
      author: 'user',
      mode: 'normal'
    });
    assert(committed2.operation !== undefined, 'session2: op2 commit failed');
    session2.store.close();

    // --- Session 3: reopen, verify no duplicates/loss, then leave an in-flight tx. ---
    const session3 = openSessionStore(databasePath, WORKSPACE_ID, overlayRoot);
    openedDatabases.push(session3.database);
    const s3List = await session3.store.list();
    assert(s3List.length === 3, `session3: expected 3 records, got ${s3List.length}`);
    assert(new Set(s3List.map((record) => record.opId)).size === 3, 'session3: duplicate op records');
    const s3op1 = await session3.store.get('op-session-1');
    assert(s3op1?.status === 'committed', 'session3: original op1 must remain committed and immutable');
    assert(s3op1.files.length === 2, 'session3: original op1 file operations changed');
    const s3inverse = s3List.find((record) => record.inverseOfOpId === 'op-session-1');
    assert(s3inverse !== undefined && s3inverse.status === 'committed',
      'session3: inverse of op1 not present exactly once');
    const s3op2 = await session3.store.get('op-session-2');
    assert(s3op2?.status === 'committed', 'session3: op2 status lost across session');
    assert((await readFile(target3)).equals(after3), 'session3: op2 re-read mismatch');
    assert(session3.repository.listIncompleteTransactions().length === 0,
      'session3: unexpected incomplete journal rows');
    assert(session3.repository.listRecoveryPoints().length === 3,
      `session3: recovery points=${session3.repository.listRecoveryPoints().length}, expected 3`);
    results.session3NoLossNoDuplicates = true;

    // Leave an in-flight (non-terminal) transaction behind for the next session.
    const now = new Date().toISOString();
    await session3.store.record({
      opId: 'op-session-3-inflight', workspaceId: WORKSPACE_ID, title: 'in-flight session 3',
      author: 'user', mode: 'normal', status: 'pending',
      createdAt: now, files: [], diagnostics: []
    });
    session3.repository.createTransaction({
      transactionId: 'tx-session-3-inflight', opId: 'op-session-3-inflight', phase: 'staging',
      state: { operationCount: 1 }, createdAt: now, updatedAt: now
    });
    await session3.store.updateStatus('op-session-3-inflight', 'pending', { transactionId: 'tx-session-3-inflight' });
    session3.store.close();

    // --- Session 4: reopen, discover and repair the in-flight journal row. ---
    const session4 = openSessionStore(databasePath, WORKSPACE_ID, overlayRoot);
    openedDatabases.push(session4.database);
    const incomplete = session4.repository.listIncompleteTransactions();
    assert(incomplete.length === 1 && incomplete[0]!.transactionId === 'tx-session-3-inflight',
      'session4: in-flight journal row not discovered across session');
    const repair = await recoverIncompleteTransactions({ store: session4.store, repository: session4.repository });
    assert(repair.recovered.length === 1, 'session4: repair count');
    assert(repair.recovered[0]!.action === 'marked_failed', 'session4: action not marked_failed');
    assert(session4.repository.getTransaction('tx-session-3-inflight')?.phase === 'failed',
      'session4: journal not terminal after repair');
    assert((await session4.store.get('op-session-3-inflight'))?.status === 'failed',
      'session4: op not marked failed');
    const s4List = await session4.store.list();
    const s4Ids = s4List.map((record) => record.opId);
    assert(new Set(s4Ids).size === s4Ids.length, 'session4: duplicates appeared after repair');
    assert(s4List.filter((record) => record.status === 'committed').length === 3,
      'session4: committed history changed after repair');
    assert(session4.repository.listIncompleteTransactions().length === 0,
      'session4: repair not terminal');
    const secondRepair = await recoverIncompleteTransactions({ store: session4.store, repository: session4.repository });
    assert(secondRepair.recovered.length === 0, 'session4: repair not idempotent');
    results.session4CrashDiscoveryRepaired = true;
    results.finalJournalTerminal = true;
    session4.store.close();

    console.log(JSON.stringify({
      ok: true,
      message: '跨会话 journal/backup 一致性验证通过（无丢失、无重复）',
      authority: 'partial',
      sessions: results,
      nonClaims: [
        '只作用于测试进程与临时 overlay，未触碰原版游戏目录。',
        '会话边界为 SQLite store 关闭/重开；未声明桌面主进程 UI 会话语义。',
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

async function removeRecursivelyWithRetry(path: string): Promise<void> {
  // Windows may briefly hold SQLite -wal/-shm files after the last close.
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

function createReplacePatch(
  patchId: string,
  label: string,
  items: Array<{ targetPath: string; targetUri: string; before: Buffer; after: Buffer }>
): PatchIR {
  const patch = createPatchIr({
    workspaceId: WORKSPACE_ID,
    title: `cross-session ${label}`,
    author: 'user',
    operations: items.map<PatchIrOperation>((item, index) => ({
      id: `${patchId}-${index}`,
      kind: 'file_replace',
      targetUri: item.targetUri,
      targetPath: item.targetPath,
      resourceKind: 'other',
      newText: item.after.toString('utf8'),
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

await main();
