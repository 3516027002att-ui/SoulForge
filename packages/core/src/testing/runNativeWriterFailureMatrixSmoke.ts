import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidatorContract, ValidatorResult, WriterApplyResult } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import { ContainerChildReplaceWriter } from '../writers/containerChildReplaceWriter.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface NativeBndEnvelope {
  sourceHash: string;
  nested?: {
    entries: Array<{ id: number; name: string; contentHash: string }>;
  };
}

type FailurePhase = 'stage' | 'validate' | 'commit' | 're-read';

class StageFailureWriter extends ContainerChildReplaceWriter {
  override async applyToStaging(input: Parameters<ContainerChildReplaceWriter['applyToStaging']>[0]): Promise<WriterApplyResult> {
    const result = await super.applyToStaging(input);
    if (!result.ok) return result;
    throw new Error('injected native writer stage failure');
  }
}

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

async function main(): Promise<void> {
  const source = await resolveNativeFixture(
    process.argv[2],
    'chrbnd-primary',
    '../../mods/chr/c0000.anibnd.dcx'
  );
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-writer-failure-matrix-'));
  const overlayRoot = join(root, 'mod');
  const backupRoot = join(root, 'backups');
  const stagingRoot = join(root, 'staging');
  await mkdir(join(overlayRoot, 'chr'), { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const target = join(overlayRoot, 'chr', 'failure-matrix.chrbnd.dcx');
  const original = await readFile(source);
  const results: Array<{
    phase: FailurePhase;
    code: string;
    originalRestored: boolean;
    stagingCleaned: boolean;
    failureAudited: boolean;
  }> = [];

  try {
    for (const phase of ['stage', 'validate', 'commit', 're-read'] as const) {
      await copyFile(source, target);
      const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
      const before = await runBridge<NativeBndEnvelope>({
        command: 'read-dcx-document',
        filePath: target,
        allowedRoots: [overlayRoot],
        timeoutMs: 120_000
      });
      const first = before.data?.nested?.entries[0];
      if (!before.data?.sourceHash || !first) {
        throw new Error(`Native BND4 fixture cannot be read: ${JSON.stringify(before.diagnostics)}`);
      }

      const patch = createPatchIr({
        workspaceId: session.meta.workspaceId,
        title: `native writer ${phase} failure matrix`,
        author: 'user',
        operations: [{
          id: `native-writer-${phase}`,
          kind: 'container_child_replace',
          targetUri: 'file://chr/failure-matrix.chrbnd.dcx',
          targetPath: target,
          resourceKind: 'chr',
          containerUri: 'file://chr/failure-matrix.chrbnd.dcx',
          childPath: first.name,
          childContentBase64: Buffer.from(`SoulForge-${phase}-failure-matrix`).toString('base64'),
          expectedContainerHash: before.data.sourceHash,
          expectedHash: before.data.sourceHash,
          expectedChildHash: first.contentHash,
          containerFormat: 'BND4_DFLT',
          preconditions: [{
            type: 'content_hash',
            description: 'container hash must remain unchanged',
            expectedHash: before.data.sourceHash
          }],
          validatorRequirements: [
            { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
            { validatorId: 'container_roundtrip', scope: 'after_commit', required: true }
          ],
          riskLevel: 'high',
          metadata: {
            nativeFormatAuthority: true,
            nativeEntryIndex: 0,
            nativeEntryId: first.id,
            requiresConfirmation: true,
            confirmationReceiptId: `native-writer-${phase}`
          }
        }]
      });

      const blockedBackupRoot = join(root, `blocked-backup-${phase}`);
      if (phase === 'commit') await writeFile(blockedBackupRoot, 'not-a-directory', 'utf8');
      const validators = createScaffoldValidators();
      if (phase === 'validate') validators.push(throwingValidator('staged_output'));
      if (phase === 're-read') validators.push(throwingValidator('after_commit'));
      const transaction = createWorkspaceTransaction({
        workspaceId: session.meta.workspaceId,
        workspaceRoot: overlayRoot,
        stagingBaseDir: stagingRoot,
        backupBaseDir: phase === 'commit' ? blockedBackupRoot : backupRoot,
        ...(phase === 'stage' ? { writers: [new StageFailureWriter()] } : {}),
        validators
      });

      if (!transaction.addPatch(patch).ok) throw new Error(`${phase} patch admission failed.`);
      const staged = await transaction.stage();
      let diagnostics = staged.diagnostics;
      if (phase !== 'stage' && !staged.ok) throw new Error(`${phase} failed before intended stage.`);
      if (phase !== 'stage') {
        const validated = await transaction.validate();
        diagnostics = validated.diagnostics;
        if (phase !== 'validate' && !validated.ok) throw new Error(`${phase} failed before intended validation.`);
        if (phase !== 'validate') {
          const committed = await transaction.commit();
          diagnostics = committed.diagnostics;
          if (committed.ok || committed.committedPaths.length !== 0) {
            throw new Error(`${phase} failure unexpectedly committed files.`);
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
        throw new Error(`${phase} missing ${expectedCode}: ${JSON.stringify(diagnostics)}`);
      }
      if (JSON.stringify(diagnostics).includes(root)) {
        throw new Error(`${phase} diagnostics leaked an absolute local path.`);
      }
      if (transaction.getStatus() !== 'failed') {
        throw new Error(`${phase} transaction status is ${transaction.getStatus()}, expected failed.`);
      }
      const restored = (await readFile(target)).equals(original);
      if (!restored) throw new Error(`${phase} failure did not preserve original bytes.`);
      const stagingCleaned = (await readdir(stagingRoot)).length === 0;
      if (!stagingCleaned) throw new Error(`${phase} staging directory leaked.`);
      const failureAudited = transaction.getAuditLog().list({
        transactionId: transaction.transactionId
      }).some((entry) => entry.eventKind === 'failure_recovery'
        && entry.diagnostics.some((item) => item.code === expectedCode));
      if (!failureAudited) throw new Error(`${phase} failure was not audited.`);
      results.push({
        phase,
        code: expectedCode,
        originalRestored: restored,
        stagingCleaned,
        failureAudited
      });
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'native BND4 writer stage/validate/commit/re-read failure matrix passed',
      fixtureHash: createHash('sha256').update(original).digest('hex'),
      results
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
