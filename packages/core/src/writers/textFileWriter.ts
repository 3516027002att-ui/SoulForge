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
    if (operation.kind === 'text_edit') return true;
    // Prefer text payload; binary base64 replace is handled by RawFileWriter.
    return operation.kind === 'file_replace' && typeof operation.newText === 'string';
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

      // 先把原文件内容铺进暂存区，让后续的部分编辑基于真实原文。
      //
      // 这里曾经是 `catch { writeFile(stagingPath, Buffer.alloc(0)) }`——任何读取
      // 失败（权限、文件被占用、IO 错误）都与「文件不存在」合并成同一个「写空
      // buffer」分支。危险在于 text_edit 允许不带 expectedHash
      // （validators/textHash.ts 对无 hash 的 text_edit 直接放行），所以这条路径上
      // 没有第二道关卡：一次瞬时读失败会被静默当成「这是个新文件」，把原内容
      // 替换成仅含本次编辑结果的文件。表现是静默数据丢失，不是报错。
      //
      // 因此只有 ENOENT（确实不存在，合法新建）才允许空起点，其余 errno 必须
      // 返回结构化诊断并跳过该 op（硬约束 8）。
      try {
        const original = await readFile(op.targetPath);
        await writeFile(stagingPath, original);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT') {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'TEXT_WRITER_ORIGINAL_READ_FAILED',
            message: '读取原文件失败，无法确定暂存起点；拒绝以空内容继续，'
              + '否则本次编辑会静默覆盖原有内容。',
            targetUri: op.targetUri,
            details: { targetPath: op.targetPath, causeCode: code ?? 'UNKNOWN' }
          }));
          continue;
        }
        await writeFile(stagingPath, Buffer.alloc(0));
      }

      if (op.kind === 'text_edit') {
        await writeFile(stagingPath, op.newText, 'utf8');
      } else if (op.kind === 'file_replace') {
        if (typeof op.newText === 'string') {
          if (op.newText.length === 0 && !op.allowEmpty) {
            diagnostics.push(createDiagnostic({
              severity: 'error',
              code: 'FILE_REPLACE_EMPTY_OUTPUT',
              message: 'Empty file replace blocked unless allowEmpty=true.',
              targetUri: op.targetUri
            }));
            continue;
          }
          await writeFile(stagingPath, op.newText, 'utf8');
        } else if (op.newContentBase64) {
          await writeFile(stagingPath, Buffer.from(op.newContentBase64, 'base64'));
        } else {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'FILE_REPLACE_EMPTY',
            message: 'file_replace requires newText or newContentBase64.',
            targetUri: op.targetUri
          }));
          continue;
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
