import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  ValidatorContract,
  ValidatorResult,
  WriterAdapterContract,
  WriterApplyResult,
  WriterRollbackMetadata,
  WriterWritePlan
} from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import { createScaffoldWriterAdapters } from '../writers/index.js';

const CAPABILITIES = [
  'text_edit',
  'text_file_replace',
  'raw_byte_range_edit',
  'binary_file_replace'
] as const;
const PHASES = ['stage', 'validate', 'commit', 're-read'] as const;

type Capability = typeof CAPABILITIES[number];
type FailurePhase = typeof PHASES[number];

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

  produceRollbackMetadata(input: {
    operations: PatchIrOperation[];
    backupPaths: string[];
  }): WriterRollbackMetadata {
    return this.delegate.produceRollbackMetadata(input);
  }
}

function throwingValidator(scope: 'staged_output' | 'after_commit'): ValidatorContract {
  const fail = (): ValidatorResult => {
    throw new Error(`injected ${scope} failure`);
  };
  return {
    validatorId: `writer_failure_matrix_${scope}`,
    targetResourceKinds: ['*'],
    validationScope: [scope],
    ...(scope === 'staged_output'
      ? { validateStagedOutput: fail }
      : { validateAfterCommit: fail })
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-writer-failure-matrix-'));
  const overlayRoot = join(root, 'mod');
  const backupRoot = join(root, 'backups');
  const stagingRoot = join(root, 'staging');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const results: Array<{
    capability: Capability;
    phase: FailurePhase;
    code: string;
    originalRestored: boolean;
    stagingCleaned: boolean;
    failureAudited: boolean;
  }> = [];

  try {
    for (const capability of CAPABILITIES) {
      for (const phase of PHASES) {
        const target = join(overlayRoot, `${capability}-${phase}.${capability.includes('text') ? 'txt' : 'bin'}`);
        const original = Buffer.from(`before:${capability}:${phase}\n`, 'utf8');
        await writeFile(target, original);
        const operation = buildOperation(capability, target, original);
        const patch = createPatchIr({
          workspaceId: 'writer-failure-matrix',
          title: `${capability} ${phase} failure matrix`,
          author: 'user',
          operations: [operation]
        });
        const writers = createScaffoldWriterAdapters();
        if (phase === 'stage') {
          const writerIndex = writers.findIndex((writer) => writer.canHandle(operation));
          if (writerIndex < 0) throw new Error(`No writer for ${capability}.`);
          writers.unshift(new ThrowAfterStageWriter(writers[writerIndex]!));
        }
        const validators = createScaffoldValidators();
        if (phase === 'validate') validators.push(throwingValidator('staged_output'));
        if (phase === 're-read') validators.push(throwingValidator('after_commit'));
        const blockedBackupRoot = join(root, `blocked-${capability}-${phase}`);
        if (phase === 'commit') await writeFile(blockedBackupRoot, 'not-a-directory', 'utf8');

        const transaction = createWorkspaceTransaction({
          workspaceId: 'writer-failure-matrix',
          workspaceRoot: overlayRoot,
          stagingBaseDir: stagingRoot,
          backupBaseDir: phase === 'commit' ? blockedBackupRoot : backupRoot,
          writers,
          validators
        });
        if (!transaction.addPatch(patch).ok) throw new Error(`${capability}/${phase}: admission failed.`);
        const staged = await transaction.stage();
        let diagnostics = staged.diagnostics;
        if (phase !== 'stage' && !staged.ok) throw new Error(`${capability}/${phase}: failed before target phase.`);
        if (phase !== 'stage') {
          const validated = await transaction.validate();
          diagnostics = validated.diagnostics;
          if (phase !== 'validate' && !validated.ok) throw new Error(`${capability}/${phase}: failed before commit.`);
          if (phase !== 'validate') {
            const committed = await transaction.commit();
            diagnostics = committed.diagnostics;
            if (committed.ok || committed.committedPaths.length !== 0) {
              throw new Error(`${capability}/${phase}: failure unexpectedly committed.`);
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
          throw new Error(`${capability}/${phase}: missing ${expectedCode}: ${JSON.stringify(diagnostics)}`);
        }
        if (JSON.stringify(diagnostics).includes(root)) {
          throw new Error(`${capability}/${phase}: diagnostics leaked an absolute local path.`);
        }
        if (transaction.getStatus() !== 'failed') {
          throw new Error(`${capability}/${phase}: status=${transaction.getStatus()}.`);
        }
        const originalRestored = (await readFile(target)).equals(original);
        if (!originalRestored) throw new Error(`${capability}/${phase}: original bytes changed.`);
        const stagingCleaned = (await readdir(stagingRoot)).length === 0;
        if (!stagingCleaned) throw new Error(`${capability}/${phase}: staging directory leaked.`);
        const failureAudited = transaction.getAuditLog().list({
          transactionId: transaction.transactionId
        }).some((entry) => entry.eventKind === 'failure_recovery'
          && entry.diagnostics.some((item) => item.code === expectedCode));
        if (!failureAudited) throw new Error(`${capability}/${phase}: failure was not audited.`);
        results.push({
          capability,
          phase,
          code: expectedCode,
          originalRestored,
          stagingCleaned,
          failureAudited
        });
      }
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'public writer failure matrix passed',
      capabilities: CAPABILITIES,
      phases: PHASES,
      cases: results.length,
      results
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function buildOperation(
  capability: Capability,
  targetPath: string,
  original: Buffer
): PatchIrOperation {
  const expectedHash = createHash('sha256').update(original).digest('hex');
  const common = {
    id: `op-${capability}`,
    targetUri: `file://${capability}`,
    targetPath,
    resourceKind: 'other' as const,
    expectedHash,
    preconditions: [{
      type: 'content_hash' as const,
      description: 'original hash must match',
      expectedHash
    }],
    riskLevel: 'low' as const
  };
  if (capability === 'text_edit') {
    return {
      ...common,
      kind: 'text_edit',
      newText: 'after:text-edit\n',
      validatorRequirements: [{ validatorId: 'text_file', scope: 'staged_output', required: true }]
    };
  }
  if (capability === 'text_file_replace') {
    return {
      ...common,
      kind: 'file_replace',
      newText: 'after:text-file-replace\n',
      validatorRequirements: [{ validatorId: 'whole_file_replace', scope: 'staged_output', required: true }]
    };
  }
  if (capability === 'raw_byte_range_edit') {
    return {
      ...common,
      kind: 'raw_byte_range_edit',
      offset: 0,
      length: 1,
      replacementBase64: Buffer.from([0x7f]).toString('base64'),
      validatorRequirements: [{ validatorId: 'raw_file', scope: 'staged_output', required: true }]
    };
  }
  return {
    ...common,
    kind: 'file_replace',
    newContentBase64: Buffer.from('after:binary-file-replace\n').toString('base64'),
    validatorRequirements: [{ validatorId: 'whole_file_replace', scope: 'staged_output', required: true }]
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
