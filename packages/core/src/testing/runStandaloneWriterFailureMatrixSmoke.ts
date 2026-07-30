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
import type { ResourceKind, ValidatorContract, ValidatorResult } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
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

interface FormatSpec {
  testRole: string;
  legacyPath: string;
  bridgeCommand: string;
  resourceKind: ResourceKind;
  label: string;
  mutationOptions: Record<string, unknown>;
}

const FORMATS: FormatSpec[] = [
  {
    testRole: 'emevd-primary',
    legacyPath: '../../mods/event/common.emevd.dcx',
    bridgeCommand: 'write-emevd',
    resourceKind: 'event',
    label: 'EMEVD',
    mutationOptions: {
      mutation: 'set_rest_behavior',
      eventId: 10,
      restBehavior: 1
    }
  },
  {
    testRole: 'msb-primary',
    legacyPath: '../../mods/map/mapstudio/m10_00_00_00.msb.dcx',
    bridgeCommand: 'write-msb',
    resourceKind: 'map',
    label: 'MSB',
    mutationOptions: {
      mutation: 'set_part_position',
      partName: 'm10_00_00_00',
      position: [0, 0, 0]
    }
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
  const results: Array<{
    phase: FailurePhase;
    code: string;
    originalRestored: boolean;
    stagingCleaned: boolean;
    failureAudited: boolean;
  }> = [];

  for (const phase of ['stage', 'validate', 'commit', 're-read'] as const) {
    await copyFile(source, target);
    const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

    // Read the document to get the source hash.
    const readCmd = spec.bridgeCommand === 'write-emevd' ? 'read-emevd-document' : 'read-msb-document';
    const before = await runBridge<Record<string, unknown>>({
      command: readCmd as 'read-emevd-document',
      filePath: target,
      allowedRoots: [overlayRoot],
      timeoutMs: 120_000
    });
    const sourceHash = (before.data?.sourceHash as string) ?? '';

    // Stage the mutation via Bridge.
    const stagedPath = join(stagingRoot, `${spec.label}-${phase}-staged.dcx`);
    await runBridge({
      command: spec.bridgeCommand as 'write-emevd',
      filePath: target,
      allowedRoots: [overlayRoot],
      writableRoots: [stagingRoot],
      timeoutMs: 120_000,
      commandOptions: { ...spec.mutationOptions, outputPath: stagedPath }
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
        targetUri: `file://${subDir}/${fileName}`,
        targetPath: target,
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
    const restored = (await readFile(target)).equals(original);
    if (!restored) throw new Error(`${spec.label} ${phase} failure did not preserve original bytes.`);
    const stagingCleaned = (await readdir(stagingRoot)).length === 0;
    if (!stagingCleaned) throw new Error(`${spec.label} ${phase} staging directory leaked.`);
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
