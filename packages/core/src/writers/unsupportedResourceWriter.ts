import type {
  PatchIR,
  PatchIrOperation,
  WriterAdapterContract,
  WriterApplyResult,
  WriterRollbackMetadata,
  WriterWritePlan
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

/**
 * Always rejects structured/native writes with clear diagnostics.
 */
export class UnsupportedResourceWriter implements WriterAdapterContract {
  readonly writerId = 'writer:unsupported';
  readonly supportedResourceKinds = [
    'event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai',
    'sfx', 'chr', 'obj', 'other', 'unknown'
  ] as const;
  readonly supportedOperations = ['structured_edit', 'container_child_edit'] as const;
  readonly inputSchemaVersion = '';
  readonly preconditions = [
    'native writer not registered',
    'structured write forbidden without fixture-confirmed implementation'
  ] as const;

  canHandle(_operation: PatchIrOperation): boolean {
    return true;
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    return {
      writerId: this.writerId,
      operations,
      stagingRelativePaths: [],
      preconditions: operations.flatMap((op) => op.preconditions),
      estimatedRisk: 'blocked',
      notes: `Unsupported writer rejects patch ${patch.patchId}`
    };
  }

  async applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult> {
    const diagnostics = input.operations.map((op) => createDiagnostic({
      severity: 'error',
      code: 'WRITER_CONTRACT_ABSENT',
      message: `No scaffold writer can apply operation ${op.kind}. Native writers are not implemented.`,
      targetUri: op.targetUri,
      details: {
        writerId: this.writerId,
        operationKind: op.kind,
        nativeFormatAuthority: false
      }
    }));

    return {
      ok: false,
      writtenTargets: [],
      writtenPaths: [],
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
      strategy: 'none',
      backupPaths: input.backupPaths,
      notes: `No writes performed for ${input.operations.length} rejected op(s)`
    };
  }
}
