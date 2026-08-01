/**
 * Real process-termination (power-loss) recovery smoke — W-A-RECOVERY-INTEGRATION-04.
 *
 * Spawns a real child Node process that drives a real workspace transaction
 * (SQLite durable journal + on-disk restore point + atomic replace) over a real
 * overlay, then hard-kills the child (SIGKILL) at three distinct points:
 *
 *   hook-kill        — kill inside the `onRestorePointCreated` hook, i.e. after
 *                      the restore point and its journal metadata are durable but
 *                      before any target is replaced.
 *   mid-replace      — kill via a short timer while the replace loop is copying
 *                      a large second target; the first (tiny) target is already
 *                      replaced, so the on-disk workspace holds a partial commit.
 *   committed-then-kill — the transaction fully commits (journal phase
 *                      `committed`, op status `committed`), then the process is
 *                      killed. Verifies committed bytes re-read identically.
 *
 * The parent then reopens the workspace database and verifies:
 *   - SQLite WAL crash recovery (quick_check ok, committed journal row visible);
 *   - journal replay consistency (phase + backup metadata from `backing_up ->
 *     replacing` transition);
 *   - whole-file integrity (every target is exactly before or after bytes — no
 *     torn files);
 *   - `recoverIncompleteTransactions` rolls a non-terminal transaction back to
 *     the exact before-bytes and terminates the journal (idempotent);
 *   - a fully committed transaction is left untouched and re-reads identically.
 *
 * Authority cap: partial. Only the actually exercised transaction/journal/backup
 * recovery path is claimed; nothing here touches native game assets.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationLogRecord, PatchIrOperation } from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { recoverIncompleteTransactions } from '../patch/recoveryRepair.js';
import { SqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import { DurableWorkspaceRepository } from '../storage/durableWorkspaceRepository.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';

const WORKSPACE_ID = 'power-loss-recovery-smoke';
const OP_ID = 'op-power-loss';
const LARGE_FILE_BYTES = 64 * 1024 * 1024;

type CrashMode = 'hook-kill' | 'mid-replace' | 'committed-then-kill';

const mode = process.argv[2];
if (mode === '--crash-child') {
  await runChild(process.argv[3]!, process.argv[4] as CrashMode);
} else {
  await runParent();
}

// ---------------------------------------------------------------------------
// Child
// ---------------------------------------------------------------------------

async function runChild(caseRoot: string, crashMode: CrashMode): Promise<void> {
  const overlayRoot = join(caseRoot, 'mod');
  const databasePath = join(caseRoot, 'workspace.db');
  const stagingRoot = join(caseRoot, 'staging');
  const backupRoot = join(caseRoot, 'backups');
  const killMarkerPath = join(caseRoot, 'kill-marker.json');
  const doneMarkerPath = join(caseRoot, 'done-marker.json');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const targetA = join(overlayRoot, 'a.txt');
  const targetB = join(overlayRoot, 'b.bin');
  const beforeA = Buffer.from('before-a\n');
  const afterA = Buffer.from('after-a-power-loss\n');
  const beforeB = deterministicBytes(0xAB, LARGE_FILE_BYTES);
  const afterB = deterministicBytes(0x5A, LARGE_FILE_BYTES);
  await writeFile(targetA, beforeA);
  await writeFile(targetB, beforeB);

  const patch = createPatchIr({
    workspaceId: WORKSPACE_ID,
    title: `power-loss ${crashMode}`,
    author: 'user',
    operations: [buildReplaceOp('op-a', targetA, beforeA, 'file://a.txt', afterA),
      buildReplaceOp('op-b', targetB, beforeB, 'file://b.bin', afterB)]
  });
  patch.patchId = OP_ID;

  const store = openPowerLossStore(databasePath);
  const repository = new DurableWorkspaceRepository(store.database, WORKSPACE_ID);
  const now = new Date().toISOString();

  const tx = createWorkspaceTransaction({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: overlayRoot,
    stagingBaseDir: stagingRoot,
    backupBaseDir: backupRoot,
    onRestorePointCreated: async (restorePoint) => {
      const afterHashes: Record<string, string> = {};
      for (const target of tx.getCommitTargets()) {
        afterHashes[target.targetPath] = sha256(await readFile(target.stagingPath));
      }
      repository.transitionTransaction({
        transactionId: tx.transactionId,
        expectedPhase: 'backing_up',
        nextPhase: 'replacing',
        state: {
          backupRoot: restorePoint.root,
          sizeBytes: restorePoint.sizeBytes,
          restorePointFiles: restorePoint.files.map((file) => ({
            sourcePath: file.sourcePath,
            backupPath: file.backupPath,
            beforeHash: file.beforeHash,
            sizeBytes: file.sizeBytes
          })),
          afterHashes
        }
      });
      await writeFile(killMarkerPath, JSON.stringify({
        transactionId: tx.transactionId,
        backupRoot: restorePoint.root
      }), 'utf8');
      if (crashMode === 'hook-kill') {
        process.kill(process.pid, 'SIGKILL');
      } else if (crashMode === 'mid-replace') {
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), 15);
      }
    }
  });

  await store.record({
    opId: OP_ID, workspaceId: WORKSPACE_ID, title: `power-loss ${crashMode}`,
    author: 'user', mode: 'normal', status: 'pending',
    createdAt: patch.createdAt, files: [], diagnostics: []
  });
  repository.createTransaction({
    transactionId: tx.transactionId, opId: OP_ID, phase: 'pending',
    state: { operationCount: 2 }, createdAt: now, updatedAt: now
  });
  await store.updateStatus(OP_ID, 'pending', { transactionId: tx.transactionId });

  const added = tx.addPatch({ ...patch, patchId: OP_ID });
  if (!added.ok) throw new Error(`child: patch admission failed: ${JSON.stringify(added.diagnostics)}`);
  repository.transitionTransaction({
    transactionId: tx.transactionId, expectedPhase: 'pending', nextPhase: 'staging',
    state: { operationCount: 2 }
  });
  const staged = await tx.stage();
  if (!staged.ok) throw new Error(`child: stage failed: ${JSON.stringify(staged.diagnostics)}`);
  repository.transitionTransaction({
    transactionId: tx.transactionId, expectedPhase: 'staging', nextPhase: 'validating',
    state: { staged: true }
  });
  const validated = await tx.validate();
  if (!validated.ok) throw new Error(`child: validate failed: ${JSON.stringify(validated.diagnostics)}`);
  repository.transitionTransaction({
    transactionId: tx.transactionId, expectedPhase: 'validating', nextPhase: 'backing_up',
    state: { validated: true }
  });

  const committed = await tx.commit();
  if (!committed.ok || !committed.restorePoint) {
    throw new Error(`child: commit failed: ${JSON.stringify(committed.diagnostics)}`);
  }
  // Mirror durablePatchCommit finalize: mark committed in the journal + op log,
  // then die so the parent can confirm the committed state re-reads identically.
  repository.transitionTransaction({
    transactionId: tx.transactionId, expectedPhase: 'replacing', nextPhase: 'marking_committed',
    state: { committedPaths: committed.committedPaths }
  });
  const operation: OperationLogRecord = {
    opId: OP_ID, workspaceId: WORKSPACE_ID, title: `power-loss ${crashMode}`,
    author: 'user', mode: 'normal', status: 'committed',
    createdAt: patch.createdAt, committedAt: now,
    backupRoot: committed.restorePoint.root,
    files: await Promise.all(committed.restorePoint.files.map(async (file) => ({
      targetUri: `file://${basename(file.sourcePath)}`,
      targetPath: file.sourcePath,
      beforeHash: file.beforeHash,
      afterHash: sha256(await readFile(file.sourcePath)),
      backupPath: file.backupPath,
      kind: file.sourcePath.endsWith('.txt') ? 'text' : 'binary'
    }))),
    diagnostics: [],
    transactionId: tx.transactionId
  };
  await store.record(operation);
  repository.transitionTransaction({
    transactionId: tx.transactionId, expectedPhase: 'marking_committed', nextPhase: 'committed',
    state: { changedFileCount: committed.committedPaths.length }
  });
  await writeFile(doneMarkerPath, JSON.stringify({ transactionId: tx.transactionId }), 'utf8');
  process.kill(process.pid, 'SIGKILL');
}

function buildReplaceOp(
  id: string,
  targetPath: string,
  before: Buffer,
  targetUri: string,
  after: Buffer
): PatchIrOperation {
  return {
    id,
    kind: 'file_replace',
    targetUri,
    targetPath,
    resourceKind: 'other',
    newContentBase64: after.toString('base64'),
    expectedHash: sha256(before),
    preconditions: [{
      type: 'content_hash',
      description: 'original bytes must match',
      expectedHash: sha256(before)
    }],
    validatorRequirements: [
      { validatorId: 'whole_file_replace', scope: 'staged_output', required: true }
    ],
    riskLevel: 'low'
  };
}

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

async function runParent(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-power-loss-'));
  const results: Array<Record<string, unknown>> = [];
  try {
    results.push(await runCrashCase(root, 'hook-kill'));
    results.push(await runCrashCase(root, 'mid-replace'));
    results.push(await runCrashCase(root, 'committed-then-kill'));

    console.log(JSON.stringify({
      ok: true,
      message: '真实进程终止（断电）恢复验证通过',
      authority: 'partial',
      crashCases: results,
      nonClaims: [
        '只作用于测试进程自身与临时 overlay，未触碰原版游戏目录。',
        '恢复策略为回滚到提交前；不声明自动重放或 roll-forward。',
        'partial 只提升本次实际覆盖的 transaction/journal/backup 恢复路径。'
      ]
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCrashCase(root: string, crashMode: CrashMode): Promise<Record<string, unknown>> {
  const caseRoot = join(root, `case-${crashMode}`);
  await mkdir(caseRoot, { recursive: true });
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    '--crash-child',
    caseRoot,
    crashMode
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exit = await new Promise<{ code: number | null }>((resolve) => {
    child.once('exit', (code) => resolve({ code }));
  });

  const markerPath = join(caseRoot, crashMode === 'committed-then-kill'
    ? 'done-marker.json'
    : 'kill-marker.json');
  const markerText = await waitForFile(markerPath, 60_000);
  if (crashMode !== 'committed-then-kill' && exit.code === 0) {
    throw new Error(`crash child for ${crashMode} exited 0 (expected hard kill).`);
  }

  const marker = JSON.parse(markerText) as { transactionId: string };
  const database = openWorkspaceDatabase(join(caseRoot, 'workspace.db'));
  ensureWorkspaceRow(database, join(caseRoot, 'mod'));
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_ID);
  const store = new SqliteOperationLogStore(database, WORKSPACE_ID);
  const overlayRoot = join(caseRoot, 'mod');
  const targetA = join(overlayRoot, 'a.txt');
  const targetB = join(overlayRoot, 'b.bin');
  const beforeA = Buffer.from('before-a\n');
  const afterA = Buffer.from('after-a-power-loss\n');
  const beforeB = deterministicBytes(0xAB, LARGE_FILE_BYTES);
  const afterB = deterministicBytes(0x5A, LARGE_FILE_BYTES);

  try {
    assert(database.pragma('quick_check', { simple: true }) === 'ok',
      `${crashMode}: SQLite integrity after crash`);
    const journal = repository.getTransaction(marker.transactionId);
    assert(journal !== undefined, `${crashMode}: journal row present`);
    const state = asRecord(journal.state);
    const filesInJournal = Array.isArray(state.restorePointFiles) ? state.restorePointFiles : [];

    const result: Record<string, unknown> = {
      mode: crashMode,
      childExitCode: exit.code,
      journalPhaseAfterCrash: journal.phase,
      journalBackupPersisted: Boolean(state.backupRoot) && filesInJournal.length === 2,
      afterHashesPersisted: typeof state.afterHashes === 'object'
        && Object.keys(asRecord(state.afterHashes)).length === 2
    };

    if (crashMode === 'hook-kill' || crashMode === 'mid-replace') {
      assert(journal.phase === 'replacing', `${crashMode}: journal must be non-terminal at replacing, got ${journal.phase}`);
      assert(result.journalBackupPersisted === true, `${crashMode}: backup metadata missing from journal state`);
      assert(result.afterHashesPersisted === true, `${crashMode}: after hashes missing from journal state`);
      const op = await store.get(OP_ID);
      assert(op?.status === 'pending', `${crashMode}: op must be pending after crash, got ${op?.status}`);

      const hashA = sha256(await readFile(targetA));
      const hashB = sha256(await readFile(targetB));
      const beforeHashA = sha256(beforeA);
      const afterHashA = sha256(afterA);
      const beforeHashB = sha256(beforeB);
      const afterHashB = sha256(afterB);
      assert([beforeHashA, afterHashA].includes(hashA), `${crashMode}: a.txt is torn`);
      assert([beforeHashB, afterHashB].includes(hashB), `${crashMode}: b.bin is torn`);
      result.aBeforeCrash = hashA === beforeHashA ? 'before' : 'after';
      result.bBeforeCrash = hashB === beforeHashB ? 'before' : 'after';
      if (crashMode === 'mid-replace') {
        assert(hashA === afterHashA, 'mid-replace: first (tiny) target should already be replaced');
      } else {
        assert(hashA === beforeHashA && hashB === beforeHashB, 'hook-kill: no target should be replaced');
      }
      const tempFilesBefore = (await listTempFiles(overlayRoot));
      result.leftoverTempFilesBeforeRecovery = tempFilesBefore.length;

      const repair = await recoverIncompleteTransactions({ store, repository });
      assert(repair.recovered.length === 1, `${crashMode}: recovery must repair exactly one transaction`);
      const repaired = repair.recovered[0]!;
      assert(repaired.action === 'rolled_back', `${crashMode}: recovery action ${repaired.action}`);
      assert(repaired.restoredFiles.length === 2, `${crashMode}: both targets restored`);
      assert(database.pragma('quick_check', { simple: true }) === 'ok', `${crashMode}: integrity after recovery`);
      assert((await readFile(targetA)).equals(beforeA), `${crashMode}: a.txt not restored to before`);
      assert((await readFile(targetB)).equals(beforeB), `${crashMode}: b.bin not restored to before`);
      assert(repository.getTransaction(marker.transactionId)?.phase === 'rolled_back',
        `${crashMode}: journal not terminal after recovery`);
      const opAfter = await store.get(OP_ID);
      assert(opAfter?.status === 'failed', `${crashMode}: op should be failed after recovery, got ${opAfter?.status}`);
      assert(repository.listAuditEvents().some((event) => event.eventKind === 'recovery.repaired'),
        `${crashMode}: recovery audit event missing`);
      const tempFilesAfter = await listTempFiles(overlayRoot);
      assert(tempFilesAfter.length === 0, `${crashMode}: leftover temp files after recovery: ${tempFilesAfter.join(',')}`);
      result.tempFilesCleaned = true;

      const second = await recoverIncompleteTransactions({ store, repository });
      assert(second.recovered.length === 0, `${crashMode}: recovery must be idempotent`);
      result.idempotent = true;
    } else {
      assert(journal.phase === 'committed', `committed-then-kill: journal must be committed, got ${journal.phase}`);
      const op = await store.get(OP_ID);
      assert(op?.status === 'committed', `committed-then-kill: op must be committed, got ${op?.status}`);
      assert((await readFile(targetA)).equals(afterA), 'committed-then-kill: a.txt re-read mismatch');
      assert((await readFile(targetB)).equals(afterB), 'committed-then-kill: b.bin re-read mismatch');
      const backupFiles = op?.files ?? [];
      assert(backupFiles.length === 2, 'committed-then-kill: committed op must record 2 backups');
      const backupA = await readFile(backupFiles.find((file) => file.targetPath === targetA)!.backupPath);
      assert(backupA.equals(beforeA), 'committed-then-kill: a.txt backup does not hold before bytes');
      const repair = await recoverIncompleteTransactions({ store, repository });
      assert(repair.recovered.length === 0, 'committed-then-kill: committed transaction must not be repaired');
      result.reReadConsistent = true;
      result.backupBeforeBytesIntact = true;
    }
    return result;
  } finally {
    store.close();
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deterministicBytes(seed: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += 4096) {
    const chunk = Buffer.alloc(Math.min(4096, size - offset));
    for (let index = 0; index < chunk.length; index += 1) {
      chunk[index] = (seed + index) & 0xff;
    }
    chunk.copy(bytes, offset);
  }
  return bytes;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function openPowerLossStore(databasePath: string): SqliteOperationLogStore {
  const database = openWorkspaceDatabase(databasePath);
  ensureWorkspaceRow(database, join(dirnameOf(databasePath), 'mod'));
  return new SqliteOperationLogStore(database, WORKSPACE_ID, true);
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index < 0 ? '.' : path.slice(0, index);
}

function ensureWorkspaceRow(database: ReturnType<typeof openWorkspaceDatabase>, rootPath: string): void {
  const now = new Date().toISOString();
  database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
  root_path = excluded.root_path,
  game = excluded.game,
  updated_at = excluded.updated_at
`).run(WORKSPACE_ID, rootPath, 'sekiro', now, now);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

async function listTempFiles(overlayRoot: string): Promise<string[]> {
  const entries = await readdir(overlayRoot);
  return entries.filter((name) => name.startsWith('.soulforge-') && name.endsWith('.tmp'));
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`marker file never appeared: ${path}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
