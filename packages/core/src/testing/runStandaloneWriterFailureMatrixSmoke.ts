/**
 * Native EMEVD/MSB standalone writer failure matrix.
 *
 * Tests the file_replace pipeline (Bridge write → staging → commit → re-read)
 * with failure injection at each phase for standalone DCX format files.
 *
 * Extends W-A-RECOVERY-NATIVE-02 (BND4/FMG/PARAM container child replace)
 * to cover standalone format writers.
 *
 * Authority cap: partial; only covers actual tested writers.
 */
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  ResourceKind,
  ValidatorContract,
  ValidatorResult,
  WriterAdapterContract,
  WriterApplyResult,
  WriterRollbackMetadata,
  WriterWritePlan
} from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import { createScaffoldWriterAdapters } from '../writers/index.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

type FailurePhase = 'stage' | 'validate' | 'commit' | 're-read';

function throwingValidator(scope: 'staged_output' | 'after_commit'): ValidatorContract {
  const fail = (): ValidatorResult => {
    throw new Error(`injected ${scope} failure`);
  };
  return {
    validatorId: `failure_matrix_${scope}`,
    targetResourceKinds: ['*'],
    validationScope: [scope],
    ...(scope === 'staged_output'
      ? { validateStagedOutput: fail }
      : { validateAfterCommit: fail })
  };
}

/** Injects a deterministic writer failure after a successful staging write. */
class ThrowAfterStageWriter implements WriterAdapterContract {
  readonly writerId: string;
  readonly supportedResourceKinds;
  readonly supportedOperations;
  readonly inputSchemaVersion: string;
  readonly preconditions;

  constructor(private readonly delegate: WriterAdapterContract) {
    this.writerId = `failure-matrix:${delegate.writerId}`;
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
    throw new Error(`injected stage failure for ${this.delegate.writerId}`);
  }
  produceRollbackMetadata(input: { operations: PatchIrOperation[]; backupPaths: string[] }): WriterRollbackMetadata {
    return this.delegate.produceRollbackMetadata(input);
  }
}

function buildStageFailureWriters(operation: PatchIrOperation): WriterAdapterContract[] {
  const writers = createScaffoldWriterAdapters();
  const index = writers.findIndex((writer) => writer.canHandle(operation));
  if (index < 0) throw new Error('No scaffold writer for standalone file_replace op.');
  writers.unshift(new ThrowAfterStageWriter(writers[index]!));
  return writers;
}

interface FormatSpec {
  testRole: string;
  legacyPath: string;
  bridgeCommand: string;
  resourceKind: ResourceKind;
  label: string;
}

const FORMATS: FormatSpec[] = [
  {
    testRole: 'emevd-primary',
    legacyPath: '../../mods/event/common.emevd.dcx',
    bridgeCommand: 'write-emevd',
    resourceKind: 'event',
    label: 'EMEVD'
  },
  {
    testRole: 'msb-primary',
    legacyPath: '../../mods/map/mapstudio/m10_00_00_00.msb.dcx',
    bridgeCommand: 'write-msb',
    resourceKind: 'map',
    label: 'MSB'
  }
];

async function runFormatMatrix(
  spec: FormatSpec,
  root: string
): Promise<Array<{ phase: FailurePhase; code: string; originalRestored: boolean; stagingCleaned: boolean; failureAudited: boolean }>> {
  const source = await resolveNativeFixture(
    process.argv[2],
    spec.testRole,
    spec.legacyPath
  );
  const overlayRoot = join(root, 'mod');
  const backupRoot = join(root, 'backups');
  const stagingRoot = join(root, 'staging');
  const subDir = spec.resourceKind;
  await mkdir(join(overlayRoot, subDir), { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const fileName = `failure-matrix.${spec.resourceKind}.dcx`;
  const target = join(overlayRoot, subDir, fileName);
  const original = await readFile(source);
  // Bridge read/write commands operate on decompressed EVD/MSB bytes; the
  // fixture is DFLT-wrapped DCX. The transaction replaces the decompressed raw
  // file while the original .dcx fixture stays untouched.
  const rawOriginal = decompressDfltDcx(original);
  const rawName = `failure-matrix.${spec.resourceKind}.raw`;
  const rawTarget = join(overlayRoot, subDir, rawName);
  const results: Array<{
    phase: FailurePhase;
    code: string;
    originalRestored: boolean;
    stagingCleaned: boolean;
    failureAudited: boolean;
  }> = [];

  for (const phase of ['stage', 'validate', 'commit', 're-read'] as const) {
    await copyFile(source, target);
    await writeFile(rawTarget, rawOriginal);
    const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

    // Read the decompressed document to get the source hash.
    const readCmd = spec.bridgeCommand === 'write-emevd' ? 'read-emevd-document' : 'read-msb-document';
    const before = await runBridge<Record<string, unknown>>({
      command: readCmd as 'read-emevd-document',
      filePath: rawTarget,
      allowedRoots: [overlayRoot],
      timeoutMs: 120_000
    });
    if (before.data?.sourceHash == null) {
      throw new Error(`${spec.label} fixture cannot be read: ${JSON.stringify(before.diagnostics)}`);
    }
    const sourceHash = (before.data.sourceHash as string) ?? '';

    // Stage the mutation via Bridge using a real document target from the read envelope.
    const stagedPath = join(stagingRoot, `${spec.label}-${phase}-staged.raw`);
    const mutationOptions = buildMutationOptions(spec, before.data, sourceHash);
    await runBridge({
      command: spec.bridgeCommand as 'write-emevd',
      filePath: rawTarget,
      allowedRoots: [overlayRoot],
      writableRoots: [stagingRoot],
      timeoutMs: 120_000,
      commandOptions: { ...mutationOptions, outputPath: stagedPath }
    });
    const stagedContent = await readFile(stagedPath);

    // Create a file_replace PatchIR with the staged content.
    const patch = createPatchIr({
      workspaceId: session.meta.workspaceId,
      title: `${spec.label} standalone writer ${phase} failure matrix`,
      author: 'user',
      operations: [{
        id: `${spec.testRole}-${phase}`,
        kind: 'file_replace',
        targetUri: `file://${subDir}/${rawName}`,
        targetPath: rawTarget,
        resourceKind: spec.resourceKind,
        newContentBase64: stagedContent.toString('base64'),
        expectedHash: sourceHash,
        preconditions: [{
          type: 'content_hash',
          description: 'source hash must remain unchanged',
          expectedHash: sourceHash
        }],
        validatorRequirements: [
          { validatorId: 'binary_roundtrip', scope: 'staged_output', required: false },
          { validatorId: 'binary_roundtrip', scope: 'after_commit', required: false }
        ],
        riskLevel: 'high',
        metadata: {
          nativeFormatAuthority: true,
          requiresConfirmation: true,
          confirmationReceiptId: `${spec.testRole}-${phase}`
        }
      }]
    });

    const blockedBackupRoot = join(root, `blocked-backup-${spec.testRole}-${phase}`);
    if (phase === 'commit') await writeFile(blockedBackupRoot, 'not-a-directory', 'utf8');
    const validators = createScaffoldValidators();
    if (phase === 'validate') validators.push(throwingValidator('staged_output'));
    if (phase === 're-read') validators.push(throwingValidator('after_commit'));
    const transaction = createWorkspaceTransaction({
      workspaceId: session.meta.workspaceId,
      workspaceRoot: overlayRoot,
      stagingBaseDir: stagingRoot,
      backupBaseDir: phase === 'commit' ? blockedBackupRoot : backupRoot,
      ...(phase === 'stage' ? { writers: buildStageFailureWriters(patch.operations[0]!) } : {}),
      validators
    });

    if (!transaction.addPatch(patch).ok) throw new Error(`${spec.label} ${phase} patch admission failed.`);
    const staged = await transaction.stage();
    let diagnostics = staged.diagnostics;
    if (phase !== 'stage' && !staged.ok) throw new Error(`${spec.label} ${phase} failed before intended stage.`);
    if (phase !== 'stage') {
      const validated = await transaction.validate();
      diagnostics = validated.diagnostics;
      if (phase !== 'validate' && !validated.ok) throw new Error(`${spec.label} ${phase} failed before intended validation.`);
      if (phase !== 'validate') {
        const committed = await transaction.commit();
        diagnostics = committed.diagnostics;
        if (committed.ok || committed.committedPaths.length !== 0) {
          throw new Error(`${spec.label} ${phase} failure unexpectedly committed files.`);
        }
      }
    }

    const expectedCode = phase === 'stage'
      ? 'WRITER_STAGING_FAILED'
      : phase === 'validate'
        ? 'VALIDATOR_STAGED_OUTPUT_FAILED'
        : phase === 'commit'
          ? 'BACKUP_CREATE_FAILED'
          : 'VALIDATOR_AFTER_COMMIT_FAILED';
    if (!diagnostics.some((item) => item.code === expectedCode)) {
      throw new Error(`${spec.label} ${phase} missing ${expectedCode}: ${JSON.stringify(diagnostics)}`);
    }
    if (transaction.getStatus() !== 'failed') {
      throw new Error(`${spec.label} ${phase} transaction status is ${transaction.getStatus()}, expected failed.`);
    }
    const restored = (await readFile(rawTarget)).equals(rawOriginal);
    if (!restored) throw new Error(`${spec.label} ${phase} failure did not preserve original bytes.`);
    const stagingCleaned = (await readdir(stagingRoot))
      .filter((name) => name.startsWith('soulforge-staging-')).length === 0;
    if (!stagingCleaned) throw new Error(`${spec.label} ${phase} transaction staging directory leaked.`);
    const failureAudited = transaction.getAuditLog().list({
      transactionId: transaction.transactionId
    }).some((entry) => entry.eventKind === 'failure_recovery'
      && entry.diagnostics.some((item) => item.code === expectedCode));
    if (!failureAudited) throw new Error(`${spec.label} ${phase} failure was not audited.`);
    results.push({
      phase,
      code: expectedCode,
      originalRestored: restored,
      stagingCleaned,
      failureAudited
    });
  }
  return results;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-standalone-writer-failure-matrix-'));
  const allResults: Record<string, Array<{ phase: FailurePhase; code: string; originalRestored: boolean; stagingCleaned: boolean; failureAudited: boolean }>> = {};

  try {
    for (const spec of FORMATS) {
      allResults[spec.label] = await runFormatMatrix(spec, root);
    }

    const totalCases = Object.values(allResults).reduce((sum, results) => sum + results.length, 0);
    console.log(JSON.stringify({
      ok: true,
      message: `standalone writer stage/validate/commit/re-read failure matrix passed (${FORMATS.map((f) => f.label).join('/')})`,
      fixtures: FORMATS.map((f) => f.label),
      totalCases,
      results: allResults
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

/** Build a real mutation target from the read envelope (event/part must exist). */
function buildMutationOptions(
  spec: FormatSpec,
  readData: Record<string, unknown> | undefined,
  sourceHash: string
): Record<string, unknown> {
  if (spec.bridgeCommand === 'write-emevd') {
    const events = readData?.events as Array<{ id: number }> | undefined;
    const target = events?.find((event) => event.id !== 0) ?? events?.[0];
    if (!target) throw new Error(`${spec.label}: no event target in read envelope`);
    return {
      mutation: 'set_rest_behavior',
      eventId: target.id,
      restBehavior: 1,
      expectedDocumentHash: sourceHash
    };
  }
  const parts = readData?.parts as Array<{ name: string; offset: number; posX: number; posY: number; posZ: number }> | undefined;
  const part = parts?.[0];
  if (!part) throw new Error(`${spec.label}: no part target in read envelope`);
  return {
    mutation: 'set_part_position',
    family: 'part',
    nativeOffset: part.offset,
    expectedName: part.name,
    posX: part.posX + 1,
    posY: part.posY,
    posZ: part.posZ,
    expectedDocumentHash: sourceHash
  };
}
