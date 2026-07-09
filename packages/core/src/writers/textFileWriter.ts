import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  WriterAdapterContract,
  WriterApplyResult,
  WriterRollbackMetadata,
  WriterWritePlan,
  WriterWrittenTarget
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { checkOriginalContentHash } from '../validators/textHash.js';

export class TextFileWriter implements WriterAdapterContract {
  readonly writerId = 'writer:text-file';
  readonly supportedResourceKinds = [
    'msg', 'event', 'script', 'action', 'other', 'unknown', 'menu', 'ai'
  ] as const;
  readonly supportedOperations = ['text_edit', 'file_replace'] as const;
  readonly inputSchemaVersion = 'soulforge.textContentEdit.v1';
  readonly preconditions = [
    'target is staging path only',
    'UTF-8 text content',
    'commit owned by WorkspaceTransaction'
  ] as const;

  canHandle(operation: PatchIrOperation): boolean {
    return operation.kind === 'text_edit' || operation.kind === 'file_replace';
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    const handled = operations.filter((op) => this.canHandle(op));
    return {
      writerId: this.writerId,
      operations: handled,
      stagingRelativePaths: handled.map((op) => stagingRelativeName(op)),
      preconditions: handled.flatMap((op) => op.preconditions),
      estimatedRisk: 'safe',
      notes: `TextFileWriter plan for patch ${patch.patchId}`
    };
  }

  async applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult> {
    const writtenTargets: WriterWrittenTarget[] = [];
    const diagnostics: StructuredDiagnostic[] = [];

    for (const op of input.operations) {
      if (!this.canHandle(op)) continue;
      if (!op.targetPath) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'TEXT_WRITER_MISSING_PATH',
          message: 'TextFileWriter requires targetPath.',
          targetUri: op.targetUri
        }));
        continue;
      }

      const hashDiagnostics = await checkOriginalContentHash(op, 'apply_to_staging');
      if (hashDiagnostics.length > 0) {
        diagnostics.push(...hashDiagnostics);
        continue;
      }

      const stagingPath = join(input.stagingRoot, stagingRelativeName(op));
      await mkdir(dirname(stagingPath), { recursive: true });

      try {
        const original = await readFile(op.targetPath);
        await writeFile(stagingPath, original);
      } catch {
        await writeFile(stagingPath, Buffer.alloc(0));
      }

      if (op.kind === 'text_edit') {
        await writeFile(stagingPath, op.newText, 'utf8');
      } else if (op.kind === 'file_replace') {
        if (typeof op.newText === 'string') {
          await writeFile(stagingPath, op.newText, 'utf8');
        } else if (op.newContentBase64) {
          await writeFile(stagingPath, Buffer.from(op.newContentBase64, 'base64'));
        }
      }

      writtenTargets.push({
        opId: op.id,
        targetUri: op.targetUri,
        targetPath: op.targetPath,
        stagingPath
      });
    }

    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      writtenTargets,
      writtenPaths: writtenTargets.map((item) => item.stagingPath),
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
      notes: `Text rollback for ${input.operations.length} op(s)`
    };
  }
}

function stagingRelativeName(op: PatchIrOperation): string {
  const safe = op.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_');
  const base = op.targetPath?.split(/[/\\]/).pop() ?? 'file.txt';
  return join(safe, op.id.slice(0, 8), base);
}
