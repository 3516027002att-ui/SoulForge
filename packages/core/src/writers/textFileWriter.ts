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
    const writtenPaths: string[] = [];
    const diagnostics = [];

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

      const stagingPath = join(input.stagingRoot, stagingRelativeName(op));
      await mkdir(dirname(stagingPath), { recursive: true });

      // Seed staging from original when present.
      if (input.workspaceRoot || op.targetPath) {
        try {
          const original = await readFile(op.targetPath);
          await writeFile(stagingPath, original);
        } catch {
          // New file create path — empty seed.
          await writeFile(stagingPath, Buffer.alloc(0));
        }
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

      writtenPaths.push(stagingPath);
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
      notes: `Text rollback for ${input.operations.length} op(s)`
    };
  }
}

function stagingRelativeName(op: PatchIrOperation): string {
  const safe = op.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_');
  const base = op.targetPath?.split(/[/\\]/).pop() ?? 'file.txt';
  return join(safe, base);
}
