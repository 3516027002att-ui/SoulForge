/**
 * Writer for container_child_replace — synthetic SFBN BND and DCX(DFLT)+BND only.
 * Explicit writtenTargets; never claims native game BND/DCX authority beyond fixture path.
 */

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
import { replaceContainerChildInMemory } from '../containers/containerService.js';
import { decodeStrictBase64, StrictBase64Error } from '../util/base64.js';
import { checkOriginalContentHash, resolveExpectedHash } from '../validators/textHash.js';

export class ContainerChildReplaceWriter implements WriterAdapterContract {
  readonly writerId = 'writer:container-child-replace';
  readonly supportedResourceKinds = ['msg', 'param', 'event', 'map', 'other', 'unknown'] as const;
  readonly supportedOperations = ['container_child_replace'] as const;
  readonly inputSchemaVersion = 'soulforge.containerChildReplace.v1';
  readonly preconditions = [
    'expectedContainerHash',
    'expectedChildHash',
    'confirmation required',
    'authoritative-repack containers only',
    'staging only'
  ] as const;

  canHandle(operation: PatchIrOperation): boolean {
    return operation.kind === 'container_child_replace'
      && Boolean(operation.childContentBase64)
      && Boolean(operation.expectedChildHash)
      && Boolean(operation.expectedContainerHash || operation.expectedHash);
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    const handled = operations.filter((op) => this.canHandle(op));
    return {
      writerId: this.writerId,
      operations: handled,
      stagingRelativePaths: handled.map((op) => stagingRelativeName(op)),
      preconditions: handled.flatMap((op) => op.preconditions),
      estimatedRisk: 'high',
      notes: `ContainerChildReplaceWriter plan for patch ${patch.patchId}`
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
      if (!this.canHandle(op) || op.kind !== 'container_child_replace') continue;
      if (!op.targetPath) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_WRITER_MISSING_PATH',
          message: 'ContainerChildReplaceWriter requires targetPath.',
          targetUri: op.targetUri
        }));
        continue;
      }

      const hashCheck = await checkOriginalContentHash(op, 'apply_to_staging');
      diagnostics.push(...hashCheck);
      if (hashCheck.some((d) => d.severity === 'error')) continue;

      let original: Buffer;
      try {
        original = await readFile(op.targetPath);
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_WRITER_READ_FAILED',
          message: error instanceof Error ? error.message : 'Failed to read container.',
          targetUri: op.targetUri
        }));
        continue;
      }

      const expectedContainerHash =
        op.expectedContainerHash ?? resolveExpectedHash(op) ?? '';
      const expectedChildHash = op.expectedChildHash ?? '';
      const childSelector = op.childPath
        || (op.childUri ? decodeChildName(op.childUri) : '');

      let newChild: Buffer;
      try {
        newChild = decodeStrictBase64(op.childContentBase64 ?? '', { allowEmpty: false });
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: error instanceof StrictBase64Error ? error.code : 'CONTAINER_CHILD_PAYLOAD_INVALID',
          message: error instanceof Error ? error.message : 'Invalid childContentBase64.',
          targetUri: op.targetUri
        }));
        continue;
      }

      const replaced = replaceContainerChildInMemory(
        original,
        childSelector,
        newChild,
        expectedContainerHash,
        expectedChildHash
      );
      diagnostics.push(...replaced.diagnostics);
      if (!replaced.ok || !replaced.containerBytes) continue;

      const stagingPath = join(input.stagingRoot, stagingRelativeName(op));
      await mkdir(dirname(stagingPath), { recursive: true });
      await writeFile(stagingPath, replaced.containerBytes);
      writtenTargets.push({
        opId: op.id,
        targetUri: op.targetUri,
        targetPath: op.targetPath,
        stagingPath
      });
    }

    return {
      ok: diagnostics.every((item) => item.severity !== 'error') && writtenTargets.length > 0,
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
      notes: `Container child replace rollback for ${input.operations.length} op(s)`
    };
  }
}

function decodeChildName(childUri: string): string {
  const hash = childUri.indexOf('#');
  const fragment = hash >= 0 ? childUri.slice(hash + 1) : childUri;
  const parts = fragment.split('/').filter(Boolean);
  const idx = parts.lastIndexOf('child');
  const raw = idx >= 0 ? parts[idx + 1] : parts[parts.length - 1];
  return decodeURIComponent(raw ?? '');
}

function stagingRelativeName(op: PatchIrOperation): string {
  const safe = op.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_');
  const base = op.targetPath?.split(/[/\\]/).pop() ?? 'container.bin';
  return join(safe, op.id.slice(0, 8), base);
}
