import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  WriterAdapterContract,
  WriterApplyResult,
  WriterRollbackMetadata,
  WriterWritePlan
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

export class RawFileWriter implements WriterAdapterContract {
  readonly writerId = 'writer:raw-file';
  readonly supportedResourceKinds = ['other', 'unknown', 'obj', 'chr', 'sfx'] as const;
  readonly supportedOperations = ['raw_byte_range_edit', 'file_replace'] as const;
  readonly inputSchemaVersion = 'soulforge.rawByteRangeEdit.v1';
  readonly preconditions = [
    'content hash precondition required',
    'staging only',
    'commit owned by WorkspaceTransaction'
  ] as const;

  canHandle(operation: PatchIrOperation): boolean {
    return operation.kind === 'raw_byte_range_edit'
      || (operation.kind === 'file_replace' && operation.newContentBase64 !== undefined);
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    const handled = operations.filter((op) => this.canHandle(op));
    return {
      writerId: this.writerId,
      operations: handled,
      stagingRelativePaths: handled.map((op) => stagingRelativeName(op)),
      preconditions: handled.flatMap((op) => op.preconditions),
      estimatedRisk: 'caution',
      notes: `RawFileWriter plan for patch ${patch.patchId}`
    };
  }

  async applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult> {
    const writtenPaths: string[] = [];
    const diagnostics = [];

    for (const op of input.operations) {
      if (!this.canHandle(op)) continue;
      if (!op.targetPath) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'RAW_WRITER_MISSING_PATH',
          message: 'RawFileWriter requires targetPath.',
          targetUri: op.targetUri
        }));
        continue;
      }

      let original: Buffer;
      try {
        original = await readFile(op.targetPath);
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'RAW_WRITER_READ_FAILED',
          message: error instanceof Error ? error.message : 'Failed to read target for raw edit.',
          targetUri: op.targetUri
        }));
        continue;
      }

      if (op.kind === 'raw_byte_range_edit') {
        const hash = sha256(original);
        if (hash !== op.expectedHash) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'HASH_MISMATCH',
            message: 'Raw edit content hash precondition failed.',
            targetUri: op.targetUri,
            details: { expected: op.expectedHash, actual: hash }
          }));
          continue;
        }

        if (op.offset + op.length > original.length) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'RAW_EDIT_RANGE_OOB',
            message: 'Raw byte range exceeds file length.',
            targetUri: op.targetUri,
            details: { offset: op.offset, length: op.length, fileLength: original.length }
          }));
          continue;
        }

        const replacement = Buffer.from(op.replacementBase64, 'base64');
        const next = Buffer.concat([
          original.subarray(0, op.offset),
          replacement,
          original.subarray(op.offset + op.length)
        ]);

        const stagingPath = join(input.stagingRoot, stagingRelativeName(op));
        await mkdir(dirname(stagingPath), { recursive: true });
        await writeFile(stagingPath, next);
        writtenPaths.push(stagingPath);
      } else if (op.kind === 'file_replace' && op.newContentBase64) {
        const stagingPath = join(input.stagingRoot, stagingRelativeName(op));
        await mkdir(dirname(stagingPath), { recursive: true });
        await writeFile(stagingPath, Buffer.from(op.newContentBase64, 'base64'));
        writtenPaths.push(stagingPath);
      }
    }

    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      writtenPaths,
      diagnostics,
      rollback: this.produceRollbackMetadata({ operations: input.operations, backupPaths: [] })
    };
  }

  produceRollbackMetadata(input: {
    operations: PatchIrOperation[];
    backupPaths: string[];
  }): WriterRollbackMetadata {
    return {
      writerId: this.writerId,
      strategy: 'restore_backup',
      backupPaths: input.backupPaths,
      notes: `Raw rollback for ${input.operations.length} op(s)`
    };
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function stagingRelativeName(op: PatchIrOperation): string {
  const safe = op.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_');
  const base = op.targetPath?.split(/[/\\]/).pop() ?? 'file.bin';
  return join(safe, base);
}
