import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { createDiagnostic, createSyntheticFixtureProvenance } from '@soulforge/shared';

/**
 * Synthetic resource writer for event/param/map/msg-like test resources.
 * Does NOT represent a native FromSoftware writer.
 */
export class SyntheticResourceWriter implements WriterAdapterContract {
  readonly writerId = 'writer:synthetic-resource';
  readonly supportedResourceKinds = ['event', 'param', 'map', 'msg', 'other'] as const;
  readonly supportedOperations = ['synthetic_resource_edit'] as const;
  readonly inputSchemaVersion = 'soulforge.syntheticResourceEdit.v1';
  readonly preconditions = [
    'synthetic fixture only',
    'nativeFormatAuthority must remain false',
    'staging only'
  ] as const;

  canHandle(operation: PatchIrOperation): boolean {
    return operation.kind === 'synthetic_resource_edit';
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    const handled = operations.filter((op) => this.canHandle(op));
    return {
      writerId: this.writerId,
      operations: handled,
      stagingRelativePaths: handled.map((op) => `${safeName(op)}.json`),
      preconditions: handled.flatMap((op) => op.preconditions),
      estimatedRisk: 'caution',
      notes: `SyntheticResourceWriter plan for patch ${patch.patchId} (not native)`
    };
  }

  async applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult> {
    const writtenTargets: WriterWrittenTarget[] = [];
    const diagnostics: StructuredDiagnostic[] = [];
    const provenance = createSyntheticFixtureProvenance('synthetic-resource-writer');

    for (const op of input.operations) {
      if (op.kind !== 'synthetic_resource_edit') continue;

      const body = {
        kind: op.kind,
        syntheticKind: op.syntheticKind,
        targetUri: op.targetUri,
        payload: op.payload,
        nativeFormatAuthority: false,
        syntheticFixture: true,
        provenance
      };

      const stagingPath = join(input.stagingRoot, `${safeName(op)}.json`);
      await mkdir(input.stagingRoot, { recursive: true });
      await writeFile(stagingPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      writtenTargets.push({
        opId: op.id,
        targetUri: op.targetUri,
        ...(op.targetPath ? { targetPath: op.targetPath } : {}),
        stagingPath
      });

      diagnostics.push(createDiagnostic({
        severity: 'info',
        code: 'SYNTHETIC_NOT_NATIVE',
        message: 'Synthetic resource edit applied to staging. Not a native format write.',
        targetUri: op.targetUri,
        details: { writerId: this.writerId, nativeFormatAuthority: false }
      }));
    }

    return {
      ok: true,
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
      notes: 'Synthetic resource rollback restores staging backups only.'
    };
  }
}

function safeName(op: PatchIrOperation): string {
  return `${op.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_')}_${op.id.slice(0, 8)}`;
}
