import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  ResourceFieldEditOp,
  SaveTextResourceResult
} from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { readMsbDocumentViaBridge } from './msbBridgeRead.js';
import {
  MSB_SEMANTIC_VALIDATOR_ID,
  MSB_SEMANTIC_WRITER_ID,
  msbPartPositionFieldUri,
  msbRegionPositionFieldUri,
  positionObjectValue
} from './msbSemanticContract.js';

interface CommitMsbPositionOptions {
  file: IndexedFile;
  expectedHash: string;
  posX: number;
  posY: number;
  posZ: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

export interface CommitMsbPartPositionOptions extends CommitMsbPositionOptions {
  partName: string;
}

export interface CommitMsbRegionPositionOptions extends CommitMsbPositionOptions {
  regionName: string;
}

/** Commit one MSB part position edit through typed PatchIR + native writer. */
export async function commitMsbPartPositionThroughPatchIr(
  options: CommitMsbPartPositionOptions
): Promise<SaveTextResourceResult> {
  return commitMsbPositionThroughPatchIr({
    ...options,
    entityKind: 'part',
    entityName: options.partName
  });
}

/** Commit one MSB region position edit through typed PatchIR + native writer. */
export async function commitMsbRegionPositionThroughPatchIr(
  options: CommitMsbRegionPositionOptions
): Promise<SaveTextResourceResult> {
  return commitMsbPositionThroughPatchIr({
    ...options,
    entityKind: 'region',
    entityName: options.regionName
  });
}

async function commitMsbPositionThroughPatchIr(
  options: CommitMsbPositionOptions & {
    entityKind: 'part' | 'region';
    entityName: string;
  }
): Promise<SaveTextResourceResult> {
  const entityLabel = options.entityKind === 'part' ? 'part' : 'region';
  const confirmationSubject = options.entityKind === 'part'
    ? 'MSB_SEMANTIC_PART_POSITION'
    : 'MSB_SEMANTIC_REGION_POSITION';
  const confirmation = options.confirmation;
  if (!confirmation
    || confirmation.riskLevel !== 'high'
    || confirmation.sourceUri !== options.file.sourceUri
    || !confirmation.subjects.includes(options.file.sourceUri)) {
    return {
      ok: false,
      changedFiles: [],
      requiresConfirmation: true,
      diagnostics: [{
        severity: 'error',
        code: 'EDIT_CONFIRMATION_REQUIRED',
        message: `原生 MSB ${entityLabel} 位置修改需要绑定当前资源 URI 的高风险确认凭据。`,
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!options.entityName
    || ![options.posX, options.posY, options.posZ].every((n) => Number.isFinite(n))) {
    return fail(
      options.file.sourceUri,
      'MSB_SEMANTIC_INPUT_INVALID',
      `MSB ${entityLabel} 名称或坐标无效。`
    );
  }

  const read = await readMsbDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    maxParts: 10_000,
    maxRegions: 10_000
  });
  if (!read.ok || !read.data) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: read.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity as Diagnostic['severity'],
        code: diagnostic.code,
        message: diagnostic.message,
        sourceUri: options.file.sourceUri
      }))
    };
  }
  if (read.data.sourceHash !== options.expectedHash) {
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 MSB 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const entity = options.entityKind === 'part'
    ? read.data.parts.find((item) => item.name === options.entityName)
    : read.data.regions.find((item) => item.name === options.entityName);
  if (!entity) {
    return fail(
      options.file.sourceUri,
      options.entityKind === 'part' ? 'MSB_SEMANTIC_PART_NOT_FOUND' : 'MSB_SEMANTIC_REGION_NOT_FOUND',
      `未找到 ${entityLabel} ${options.entityName}。`
    );
  }
  if (entity.posX === options.posX && entity.posY === options.posY && entity.posZ === options.posZ) {
    return fail(options.file.sourceUri, 'MSB_SEMANTIC_NOOP_BLOCKED', `${entityLabel} 位置未变化，已阻止空提交。`);
  }

  const fieldUri = options.entityKind === 'part'
    ? msbPartPositionFieldUri({
        documentUri: options.file.sourceUri,
        partName: options.entityName
      })
    : msbRegionPositionFieldUri({
        documentUri: options.file.sourceUri,
        regionName: options.entityName
      });
  const previousValue = positionObjectValue({ x: entity.posX, y: entity.posY, z: entity.posZ });
  const nextValue = positionObjectValue({
    x: options.posX,
    y: options.posY,
    z: options.posZ
  });
  const operation: ResourceFieldEditOp = {
    id: randomUUID(),
    kind: 'resource_field_edit',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'map',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.sourceHash,
    schemaId: `msb:${entityLabel}-position`,
    schemaVersion: '1',
    layoutFingerprint: options.entityKind === 'part'
      ? `msb-parts:${read.data.partCount}`
      : `msb-regions:${read.data.regionCount}`,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.sourceHash,
    writerId: MSB_SEMANTIC_WRITER_ID,
    fieldUri,
    previousValue,
    nextValue,
    inverse: {
      kind: 'resource_field_edit',
      fieldUri,
      value: previousValue
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 MSB 文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'resource_exists',
        description: `目标 MSB ${entityLabel} 必须存在`,
        targetUri: fieldUri
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 MSB semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: MSB_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: MSB_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: MSB_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: MSB_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `MSB ${entityLabel} ${options.entityName} 位置的 typed inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      entityKind: options.entityKind,
      entityName: options.entityName,
      confirmationSubject
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `MSB ${entityLabel} position ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: `原生 MSB ${entityLabel} position typed PatchIR transaction`
  });
  const committed = await executePatchIrThroughTransaction(patch, {
    ...(options.session ? { session: options.session } : {}),
    ...(options.session?.layers.overlayRoot
      ? { workspaceRoot: options.session.layers.overlayRoot }
      : {}),
    ...(options.operationLog ? { operationLog: options.operationLog } : {}),
    ...(options.backupBaseDir ? { backupBaseDir: options.backupBaseDir } : {}),
    ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {}),
    author: 'user'
  });
  return {
    ok: Boolean(committed.operation)
      && committed.changedFiles.length === 1
      && committed.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    opId: committed.opId,
    backupRoot: committed.backupRoot,
    changedFiles: committed.changedFiles,
    diagnostics: committed.diagnostics
  };
}

function fail(
  sourceUri: string,
  code: string,
  message: string,
  details?: Record<string, unknown>
): SaveTextResourceResult {
  return {
    ok: false,
    changedFiles: [],
    diagnostics: [{ severity: 'error', code, message, sourceUri, ...(details ? { details } : {}) }]
  };
}
