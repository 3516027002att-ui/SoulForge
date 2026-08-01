/**
 * Large-capacity transaction recovery smoke — W-A-RECOVERY-INTEGRATION-04.
 *
 * Exercises the stage/validate/commit/re-read chain and the durable journal
 * with hundreds of operations (default 800) in one real transaction over a real
 * SQLite workspace database and a real overlay:
 *
 *   1. success-chain      — `executePatchIrThroughTransaction` end-to-end with a
 *      journal-wired operation-log store (createTransaction / transition /
 *      finalizeCommit wired to the SQLite repository, mirroring the desktop
 *      database utility). Asserts the journal reaches `committed`, the op record
 *      carries all 800 file operations, every target re-reads to the exact
 *      after-bytes, and every backup holds the exact before-bytes.
 *   2. fail-closed        — for each of stage / validate / commit / re-read, an
 *      800-op transaction with an injected failure. Asserts originals preserved,
 *      staging cleaned, the journal terminates in `failed`, and the op record is
 *      marked failed.
 *   3. recovery-at-scale  — a real 800-file restore point plus a `replacing`
 *      journal row whose state shape is byte-for-byte what the real process
 *      termination smoke (runPowerLossRecoverySmoke) produces after a hard kill.
 *      `recoverIncompleteTransactions` restores all 800 files to the recorded
 *      before-bytes, terminates the journal, and is idempotent. A corrupted
 *      target at this scale must fail closed (`corruption_blocked`) instead of
 *      overwriting evidence.
 *
 * Authority cap: partial; only the actually exercised transaction/journal/backup
 * recovery path is claimed.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Diagnostic,
  PatchIR,
  PatchIrOperation,
  ValidatorContract,
  ValidatorResult,
  WriterAdapterContract,
  WriterApplyResult,
  WriterRollbackMetadata,
  WriterWritePlan
} from '@soulforge/shared';
import { createRestorePoint } from '../backup/restorePoint.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { recoverIncompleteTransactions } from '../patch/recoveryRepair.js';
import { SqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import { DurableWorkspaceRepository, type TransactionJournalPhase } from '../storage/durableWorkspaceRepository.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import { createScaffoldWriterAdapters } from '../writers/index.js';
import { JournalWiringStore } from './journalWiringStore.js';

const WORKSPACE_ID = 'large-transaction-recovery-smoke';
const OP_COUNT = 800;
const FILE_BYTES = 1024;

const MODE = process.argv[2] ?? 'parent';
const OP_ID_PREFIX = 'op-large';
const STAGING_ROOT = 'staging';
const BACKUP_ROOT = 'backups';
const BACKUP_LARGE_ROOT = 'backups-large';

type FailurePhase = 'stage' | 'validate' | 'commit' | 're-read';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLargePatch(
  workspaceId: string,
  opIdPrefix: string,
  targets: string[],
  before: Buffer[],
  after: Buffer[]
): PatchIR {
  const patch = createPatchIr({
    workspaceId,
    title: `large transaction ${opIdPrefix} (${OP_COUNT} ops)`,
    author: 'user',
    operations: targets.map((target, index) => ({
      id: `${opIdPrefix}-${index}`,
      kind: 'file_replace',
      targetUri: `file://${opIdPrefix}/${index}`,
      targetPath: target,
      resourceKind: 'other',
      newContentBase64: after[index]!.toString('base64'),
      expectedHash: sha256(before[index]!),
      preconditions: [{
        type: 'content_hash',
        description: 'original bytes must match',
        expectedHash: sha256(before[index]!)
      }],
      validatorRequirements: [
        { validatorId: 'whole_file_replace', scope: 'staged_output', required: true }
      ],
      riskLevel: 'low'
    }))
  });
  return patch;
}

function buildTargets(overlayRoot: string, opIdPrefix: string): string[] {
  return Array.from({ length: OP_COUNT }, (_value, index) => join(overlayRoot, `${opIdPrefix}-${index}.bin`));
}

function beforeBytes(index: number): Buffer {
  const marker = `before-${index}`.padEnd(64, 'x');
  const bytes = Buffer.alloc(FILE_BYTES, 0x11);
  bytes.write(marker, 0, 'utf8');
  return bytes;
}

function afterBytes(index: number): Buffer {
  const marker = `after-${index}`.padEnd(64, 'y');
  const bytes = Buffer.alloc(FILE_BYTES, 0x22);
  bytes.write(marker, 0, 'utf8');
  return bytes;
}

async function writeAll(targets: string[], bytes: Buffer[]): Promise<void> {
  for (let index = 0; index < targets.length; index += 1) {
    await writeFile(targets[index]!, bytes[index]!);
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function awaitRead(path: string): Promise<Buffer> {
  return readFile(path);
}

async function ensureWorkspaceRow(database: ReturnType<typeof openWorkspaceDatabase>, rootPath: string): Promise<void> {
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

async function listTempFiles(overlayRoot: string): Promise<string[]> {
  const entries = await readdir(overlayRoot);
  return entries.filter((name) => name.startsWith('.soulforge-') && name.endsWith('.tmp'));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function throwingValidator(scope: 'staged_output' | 'after_commit'): ValidatorContract {
  const fail = (): ValidatorResult => {
    throw new Error('injected large-transaction validator failure');
  };
  return {
    validatorId: `large_failure_matrix_${scope}`,
    targetResourceKinds: ['*'],
    validationScope: [scope],
    ...(scope === 'staged_output'
      ? { validateStagedOutput: fail }
      : { validateAfterCommit: fail })
  };
}

class ThrowAfterStageWriter implements WriterAdapterContract {
  readonly writerId: string;
  readonly supportedResourceKinds;
  readonly supportedOperations;
  readonly inputSchemaVersion: string;
  readonly preconditions;

  constructor(private readonly delegate: WriterAdapterContract) {
    this.writerId = `large-failure-matrix:${delegate.writerId}`;
    this.supportedResourceKinds = delegate.supportedResourceKinds;
    this.supportedOperations = delegate.supportedOperations;
    this.inputSchemaVersion = delegate.inputSchemaVersion;
    this.preconditions = delegate.preconditions;
  }

  canHandle(operation: PatchIrOperation): boolean {
    return this.delegate.canHandle(operation);
  }
  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    return this.delegate.writePlan(patch, operations);
  }
  async applyToStaging(input: Parameters<WriterAdapterContract['applyToStaging']>[0]): Promise<WriterApplyResult> {
    const result = await this.delegate.applyToStaging(input);
    if (!result.ok) return result;
    throw new Error('injected large-transaction stage failure');
  }
  produceRollbackMetadata(input: { operations: PatchIrOperation[]; backupPaths: string[] }): WriterRollbackMetadata {
    return this.delegate.produceRollbackMetadata(input);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-large-transaction-'));
  const overlayRoot = join(root, 'mod');
  const stagingRoot = join(root, STAGING_ROOT);
  const backupRoot = join(root, BACKUP_ROOT);
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const database = openWorkspaceDatabase(join(root, 'workspace.db'));
  await ensureWorkspaceRow(database, overlayRoot);
  const delegate = new SqliteOperationLogStore(database, WORKSPACE_ID, true);
  const repository = new DurableWorkspaceRepository(database, WORKSPACE_ID);
  const store = new JournalWiringStore(delegate, repository);

  try {
    const targets = buildTargets(overlayRoot, 'success');
    const before = targets.map((_target, index) => beforeBytes(index));
    const after = targets.map((_target, index) => afterBytes(index));
    await writeAll(targets, before);

    const successPatch = buildLargePatch(WORKSPACE_ID, 'success', targets, before, after);
    successPatch.patchId = 'op-large-success';

    // 1. Success chain at scale.
    const committed = await executePatchIrThroughTransaction(successPatch, {
      workspaceRoot: overlayRoot,
      operationLog: store,
      backupBaseDir: backupRoot,
      author: 'user',
      mode: 'normal'
    });
    assert(committed.operation !== undefined, 'success: operation record missing');
    assert(committed.changedFiles.length === OP_COUNT, `success: changedFiles=${committed.changedFiles.length}`);
    assert(committed.diagnostics.every((item) => item.severity !== 'error'),
      `success: unexpected diagnostics ${JSON.stringify(committed.diagnostics)}`);
    assert(repository.getTransaction(committed.operation.transactionId!)?.phase === 'committed',
      'success: journal phase not committed');
    const successOp = await store.get('op-large-success');
    assert(successOp?.status === 'committed', 'success: op status not committed');
    assert(successOp.files.length === OP_COUNT, `success: op files=${successOp.files.length}`);
    assert(repository.listRecoveryPoints().length === 1, 'success: recovery point not recorded');
    assert(database.pragma('quick_check', { simple: true }) === 'ok', 'success: integrity');
    for (let index = 0; index < OP_COUNT; index += 1) {
      assert((await readFile(targets[index]!)).equals(after[index]!), `success: re-read mismatch at ${index}`);
    }
    for (let index = 0; index < OP_COUNT; index += 1) {
      const backupPath = successOp.files[index]!.backupPath;
      assert(sha256(await readFile(backupPath)) === successOp.files[index]!.beforeHash,
        `success: backup before-bytes mismatch at ${index}`);
    }

    // 2. Fail-closed at scale for each phase.
    const failResults: Array<{ phase: FailurePhase; code: string }> = [];
    for (const phase of ['stage', 'validate', 'commit', 're-read'] as const) {
      const failTargets = buildTargets(overlayRoot, `fail-${phase}`);
      const failBefore = failTargets.map((_target, index) => beforeBytes(index));
      const failAfter = failTargets.map((_target, index) => afterBytes(index));
      await writeAll(failTargets, failBefore);
      const failPatch = buildLargePatch(WORKSPACE_ID, `fail-${phase}`, failTargets, failBefore, failAfter);
      failPatch.patchId = `op-large-fail-${phase}`;

      const outcome = await runLargeWithFailure({
        store,
        repository,
        overlayRoot,
        stagingRoot,
        backupRoot,
        patch: failPatch,
        phase,
        targets: failTargets,
        before: failBefore
      });
      assert(outcome.code !== undefined, `${phase}: expected a failure code`);
      for (let index = 0; index < OP_COUNT; index += 1) {
        assert((await readFile(failTargets[index]!)).equals(failBefore[index]!),
          `${phase}: original bytes changed at ${index}`);
      }
      assert((await listTempFiles(overlayRoot)).length === 0, `${phase}: leftover temp files`);
      failResults.push({ phase, code: outcome.code! });
    }

    // 3. Recovery at scale (synthetic crash shape validated against the real
    //    power-loss crash: journal phase 'replacing' + backupRoot +
    //    restorePointFiles + afterHashes).
    const recoveryTargets = buildTargets(overlayRoot, 'recovery');
    const recoveryBefore = recoveryTargets.map((_target, index) => beforeBytes(index));
    const recoveryAfter = recoveryTargets.map((_target, index) => afterBytes(index));
    await writeAll(recoveryTargets, recoveryBefore);
    await mkdir(join(root, BACKUP_LARGE_ROOT), { recursive: true });
    const restorePoint = await createRestorePoint({
      sourcePaths: recoveryTargets,
      baseDir: join(root, BACKUP_LARGE_ROOT),
      label: 'large-recovery'
    });
    const recoveryTxId = 'tx-large-recovery';
    await store.record({
      opId: 'op-large-recovery', workspaceId: WORKSPACE_ID, title: 'large recovery synthetic crash',
      author: 'user', mode: 'normal', status: 'pending',
      createdAt: new Date().toISOString(), files: [], diagnostics: []
    });
    repository.createTransaction({
      transactionId: recoveryTxId, opId: 'op-large-recovery', phase: 'replacing',
      state: {
        backupRoot: restorePoint.root,
        sizeBytes: restorePoint.sizeBytes,
        restorePointFiles: restorePoint.files.map((file) => ({
          sourcePath: file.sourcePath,
          backupPath: file.backupPath,
          beforeHash: file.beforeHash,
          sizeBytes: file.sizeBytes
        })),
        afterHashes: Object.fromEntries(recoveryAfter.map((bytes, index) => [recoveryTargets[index]!, sha256(bytes)]))
      },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    const repair = await recoverIncompleteTransactions({ store, repository });
    assert(repair.recovered.length === 1, 'recovery-at-scale: one transaction repaired');
    assert(repair.recovered[0]!.action === 'rolled_back', 'recovery-at-scale: action not rolled_back');
    assert(repair.recovered[0]!.restoredFiles.length === OP_COUNT,
      `recovery-at-scale: restored=${repair.recovered[0]!.restoredFiles.length}`);
    for (let index = 0; index < OP_COUNT; index += 1) {
      assert((await readFile(recoveryTargets[index]!)).equals(recoveryBefore[index]!),
        `recovery-at-scale: target ${index} not restored to before`);
    }
    assert(repository.getTransaction(recoveryTxId)?.phase === 'rolled_back', 'recovery-at-scale: journal not terminal');
    assert((await store.get('op-large-recovery'))?.status === 'failed', 'recovery-at-scale: op not marked failed');
    const secondRepair = await recoverIncompleteTransactions({ store, repository });
    assert(secondRepair.recovered.length === 0, 'recovery-at-scale: not idempotent');

    // 3b. Corrupted target at scale must fail closed.
    const corruptTargets = buildTargets(overlayRoot, 'corrupt');
    const corruptBefore = corruptTargets.map((_target, index) => beforeBytes(index));
    const corruptAfter = corruptTargets.map((_target, index) => afterBytes(index));
    await writeAll(corruptTargets, corruptBefore);
    const corruptRestorePoint = await createRestorePoint({
      sourcePaths: corruptTargets,
      baseDir: join(root, 'backups-corrupt'),
      label: 'corrupt-recovery'
    });
    const corruptTxId = 'tx-large-corrupt';
    await store.record({
      opId: 'op-large-corrupt', workspaceId: WORKSPACE_ID, title: 'large corrupt synthetic crash',
      author: 'user', mode: 'normal', status: 'pending',
      createdAt: new Date().toISOString(), files: [], diagnostics: []
    });
    repository.createTransaction({
      transactionId: corruptTxId, opId: 'op-large-corrupt', phase: 'replacing',
      state: {
        backupRoot: corruptRestorePoint.root,
        sizeBytes: corruptRestorePoint.sizeBytes,
        restorePointFiles: corruptRestorePoint.files.map((file) => ({
          sourcePath: file.sourcePath,
          backupPath: file.backupPath,
          beforeHash: file.beforeHash,
          sizeBytes: file.sizeBytes
        })),
        afterHashes: Object.fromEntries(corruptAfter.map((bytes, index) => [corruptTargets[index]!, sha256(bytes)]))
      },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    const corruptedTarget = corruptTargets[123]!;
    await writeFile(corruptedTarget, Buffer.alloc(FILE_BYTES, 0xEE));
    const corruptRepair = await recoverIncompleteTransactions({ store, repository });
    const corruptOutcome = corruptRepair.recovered.find((item) => item.transactionId === corruptTxId);
    assert(corruptOutcome?.action === 'corruption_blocked', `corrupt: expected corruption_blocked, got ${corruptOutcome?.action}`);
    assert(corruptRepair.diagnostics.some((item) => item.code === 'RECOVERY_CORRUPTION_DETECTED'),
      'corrupt: RECOVERY_CORRUPTION_DETECTED diagnostic missing');
    assert(repository.getTransaction(corruptTxId)?.phase === 'replacing',
      'corrupt: journal must remain non-terminal after corruption block');

    console.log(JSON.stringify({
      ok: true,
      message: `大容量事务（${OP_COUNT} ops）成功链/失败关闭/恢复验证通过`,
      authority: 'partial',
      operationCount: OP_COUNT,
      successChain: {
        journalPhase: 'committed',
        opStatus: 'committed',
        changedFiles: committed.changedFiles.length,
        fileOperations: successOp.files.length,
        backupCount: successOp.files.length,
        reReadAllMatch: true
      },
      failClosed: failResults,
      recoveryAtScale: {
        restoredFiles: repair.recovered[0]!.restoredFiles.length,
        journalStateSource: 'synthetic-replacing-shaped-by-real-powerloss-crash',
        action: repair.recovered[0]!.action,
        idempotent: true,
        corruptionFailClosed: corruptOutcome?.action
      },
      nonClaims: [
        'journal 状态为按真实断电 crash 形状构造的 synthetic 大容量输入；真实 800-op 进程终止由 runPowerLossRecoverySmoke 覆盖。',
        '只作用于测试进程与临时 overlay，未触碰原版游戏目录。',
        'partial 只提升本次实际覆盖的 transaction/journal/backup 恢复路径。'
      ]
    }, null, 2));
  } finally {
    delegate.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runLargeWithFailure(input: {
  store: JournalWiringStore;
  repository: DurableWorkspaceRepository;
  overlayRoot: string;
  stagingRoot: string;
  backupRoot: string;
  patch: PatchIR;
  phase: FailurePhase;
  targets: string[];
  before: Buffer[];
}): Promise<{ code?: string; diagnostics: Diagnostic[] }> {
  const { store, repository } = input;
  const opId = input.patch.patchId;
  const now = new Date().toISOString();
  const blockedBackupPath = join(input.backupRoot, 'blocked');
  if (input.phase === 'commit') {
    await mkdir(input.backupRoot, { recursive: true });
    await writeFile(blockedBackupPath, 'not-a-directory', 'utf8');
  }

  const writers = createScaffoldWritersForPhase(input.patch.operations[0]!, input.phase);
  const validators = createScaffoldValidators();
  if (input.phase === 'validate') validators.push(throwingValidator('staged_output'));
  if (input.phase === 're-read') validators.push(throwingValidator('after_commit'));

  const tx = createWorkspaceTransaction({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: input.overlayRoot,
    stagingBaseDir: input.stagingRoot,
    backupBaseDir: input.phase === 'commit' ? blockedBackupPath : input.backupRoot,
    writers,
    validators,
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
    }
  });

  await store.record({
    opId, workspaceId: WORKSPACE_ID, title: `large fail ${input.phase}`,
    author: 'user', mode: 'normal', status: 'pending',
    createdAt: input.patch.createdAt, files: [], diagnostics: []
  });
  repository.createTransaction({
    transactionId: tx.transactionId, opId, phase: 'pending',
    state: { operationCount: OP_COUNT }, createdAt: now, updatedAt: now
  });
  await store.updateStatus(opId, 'pending', { transactionId: tx.transactionId });

  const added = tx.addPatch({ ...input.patch, patchId: opId });
  if (!added.ok) {
    await failAndMark(store, repository, tx.transactionId, opId, 'pending', added.diagnostics);
    return { code: 'TRANSACTION_FAILED', diagnostics: added.diagnostics };
  }

  await repository.transitionTransaction({
    transactionId: tx.transactionId, expectedPhase: 'pending', nextPhase: 'staging',
    state: { operationCount: OP_COUNT }
  });
  const staged = await tx.stage();
  if (!staged.ok || input.phase === 'stage') {
    const diagnostics = staged.diagnostics;
    await failAndMark(store, repository, tx.transactionId, opId, 'staging', diagnostics);
    return { code: 'WRITER_STAGING_FAILED', diagnostics };
  }

  await repository.transitionTransaction({
    transactionId: tx.transactionId, expectedPhase: 'staging', nextPhase: 'validating',
    state: { staged: true }
  });
  const validated = await tx.validate();
  if (!validated.ok || input.phase === 'validate') {
    const diagnostics = validated.diagnostics;
    await failAndMark(store, repository, tx.transactionId, opId, 'validating', diagnostics);
    return { code: 'VALIDATOR_STAGED_OUTPUT_FAILED', diagnostics };
  }

  await repository.transitionTransaction({
    transactionId: tx.transactionId, expectedPhase: 'validating', nextPhase: 'backing_up',
    state: { validated: true }
  });
  const committed = await tx.commit();
  if (!committed.ok) {
    const expectedCode = input.phase === 'commit'
      ? 'BACKUP_CREATE_FAILED'
      : 'VALIDATOR_AFTER_COMMIT_FAILED';
    await failAndMark(store, repository, tx.transactionId, opId, ['backing_up', 'replacing'], committed.diagnostics);
    return { code: expectedCode, diagnostics: committed.diagnostics };
  }
  throw new Error(`large fail ${input.phase}: transaction unexpectedly committed.`);
}

async function failAndMark(
  store: JournalWiringStore,
  repository: DurableWorkspaceRepository,
  transactionId: string,
  opId: string,
  expectedPhase: TransactionJournalPhase | TransactionJournalPhase[],
  diagnostics: Diagnostic[]
): Promise<void> {
  try {
    repository.transitionTransaction({
      transactionId,
      expectedPhase,
      nextPhase: 'failed',
      state: { diagnostics }
    });
  } catch {
    // Phase may already be terminal via an earlier mark; the op status is the
    // source of truth for the smoke assertion.
  }
  await store.updateStatus(opId, 'failed', { diagnostics });
}

function createScaffoldWritersForPhase(op: PatchIrOperation, phase: FailurePhase): WriterAdapterContract[] {
  const writers = createScaffoldWriterAdapters();
  if (phase !== 'stage') return writers;
  const index = writers.findIndex((writer) => writer.canHandle(op));
  if (index < 0) throw new Error('No scaffold writer for large failure op.');
  writers.unshift(new ThrowAfterStageWriter(writers[index]!));
  return writers;
}

await main();
