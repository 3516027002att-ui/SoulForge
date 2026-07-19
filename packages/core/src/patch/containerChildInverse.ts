/**
 * Capture precise resource-entry inverse PatchIR for native BND4 mutations.
 * Inverse ops are persisted with the original operation and used by
 * rollbackResourceEntry; writers never self-commit.
 */

import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  ContainerChildOp,
  Diagnostic,
  PatchIrOperation
} from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

export interface ResourceEntryChangeInput {
  id: string;
  resourceUri: string;
  entryUri: string;
  changeKind: string;
  beforeHash?: string;
  afterHash?: string;
  inverse: PatchIrOperation;
}

export interface NativeBnd4ChildSnapshot {
  sourceHash: string;
  index: number;
  flags: number;
  unknown: number;
  id: number;
  name: string;
  contentHash: string;
  contentBase64: string;
}

function sha256Base64(contentBase64: string): string {
  return createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex');
}

function isNativeBnd4(op: PatchIrOperation): op is ContainerChildOp {
  return op.kind.startsWith('container_child_')
    && (op as ContainerChildOp).containerFormat === 'BND4_DFLT'
    && op.metadata?.nativeFormatAuthority === true
    && Boolean(op.targetPath);
}

function entryUriFor(op: ContainerChildOp, name: string): string {
  if (op.childUri) return op.childUri;
  return `${op.containerUri || op.targetUri}#bnd4/child/${encodeURIComponent(name)}`;
}

function containerHashOf(op: ContainerChildOp): string {
  return op.expectedContainerHash ?? op.expectedHash ?? '';
}

function baseInverseFields(op: ContainerChildOp): Omit<ContainerChildOp, 'id' | 'kind' | 'childPath'> {
  const hash = containerHashOf(op);
  return {
    targetUri: op.targetUri,
    ...(op.targetPath ? { targetPath: op.targetPath } : {}),
    ...(op.resourceKind ? { resourceKind: op.resourceKind } : {}),
    containerUri: op.containerUri || op.targetUri,
    containerFormat: 'BND4_DFLT',
    ...(hash ? { expectedContainerHash: hash, expectedHash: hash } : {}),
    preconditions: [{
      type: 'content_hash',
      description: '回滚前容器必须仍等于原操作 afterHash',
      expectedHash: hash,
      targetUri: op.targetUri
    }],
    validatorRequirements: [
      { validatorId: 'container_roundtrip', scope: 'before_staging', required: true },
      { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
      { validatorId: 'container_roundtrip', scope: 'after_commit', required: true },
      { validatorId: 'file_risk', scope: 'before_staging', required: true }
    ],
    riskLevel: 'high'
  };
}

async function snapshotChild(
  op: ContainerChildOp,
  workspaceRoot: string
): Promise<{ snapshot?: NativeBnd4ChildSnapshot; diagnostic?: Diagnostic }> {
  if (!op.targetPath) {
    return {
      diagnostic: {
        severity: 'error',
        code: 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED',
        message: '原生 BND4 条目逆操作需要 targetPath。',
        details: { targetUri: op.targetUri }
      }
    };
  }
  const result = await runBridge<NativeBnd4ChildSnapshot>({
    command: 'snapshot-bnd4-child',
    filePath: op.targetPath,
    resourceUri: op.targetUri,
    allowedRoots: [workspaceRoot, dirname(op.targetPath)],
    workspaceSessionId: `inverse-snapshot-${op.id}`,
    timeoutMs: 60_000,
    commandOptions: {
      ...(typeof op.metadata?.nativeEntryIndex === 'number' ? { entryIndex: op.metadata.nativeEntryIndex } : {}),
      ...(op.childPath ? { childPath: op.childPath } : {}),
      ...(op.expectedChildHash ? { expectedChildHash: op.expectedChildHash } : {})
    }
  });
  if (result.parseStatus === 'failed' || !result.data?.contentHash || !result.data.contentBase64) {
    return {
      diagnostic: {
        severity: 'error',
        code: 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED',
        message: result.diagnostics[0]?.message ?? '无法捕获 BND4 子项快照，已阻止写入。',
        details: { targetUri: op.targetUri, childPath: op.childPath }
      }
    };
  }
  if (op.expectedChildHash && result.data.contentHash !== op.expectedChildHash) {
    return {
      diagnostic: {
        severity: 'error',
        code: 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED',
        message: '条目快照 hash 与 expectedChildHash 不一致，已阻止写入。',
        details: { expectedChildHash: op.expectedChildHash, actual: result.data.contentHash }
      }
    };
  }
  return { snapshot: result.data };
}

function buildInverseFromSnapshot(
  op: ContainerChildOp,
  snapshot: NativeBnd4ChildSnapshot
): ResourceEntryChangeInput {
  const fields = baseInverseFields(op);
  const entryUri = entryUriFor(op, snapshot.name);
  const mutation = op.kind.slice('container_child_'.length);

  if (mutation === 'replace') {
    if (!op.childContentBase64) {
      throw new Error('container_child_replace inverse requires new child content for afterHash.');
    }
    const afterHash = sha256Base64(op.childContentBase64);
    return {
      id: randomUUID(),
      resourceUri: op.targetUri,
      entryUri,
      changeKind: 'replace',
      beforeHash: snapshot.contentHash,
      afterHash,
      inverse: {
        id: randomUUID(),
        kind: 'container_child_replace',
        ...fields,
        childPath: snapshot.name,
        childUri: entryUri,
        childContentBase64: snapshot.contentBase64,
        expectedChildHash: afterHash,
        rollbackHint: { strategy: 'inverse_patch', notes: `资源条目 ${entryUri} 的 replace 逆操作` },
        metadata: {
          inverseResourceEntry: true,
          entryUri,
          nativeFormatAuthority: true,
          nativeEntryIndex: snapshot.index,
          nativeEntryId: snapshot.id
        }
      }
    };
  }

  if (mutation === 'delete') {
    return {
      id: randomUUID(),
      resourceUri: op.targetUri,
      entryUri,
      changeKind: 'delete',
      beforeHash: snapshot.contentHash,
      inverse: {
        id: randomUUID(),
        kind: 'container_child_add',
        ...fields,
        childPath: snapshot.name,
        newChildPath: snapshot.name,
        childUri: entryUri,
        childContentBase64: snapshot.contentBase64,
        rollbackHint: { strategy: 'inverse_patch', notes: `资源条目 ${entryUri} 的 delete 逆操作（重新添加）` },
        metadata: {
          inverseResourceEntry: true,
          entryUri,
          nativeFormatAuthority: true,
          nativeEntryId: snapshot.id,
          nativeEntryFlags: snapshot.flags,
          nativeEntryUnknown: snapshot.unknown
        }
      }
    };
  }

  if (mutation === 'rename') {
    const newName = op.newChildPath;
    if (!newName) throw new Error('container_child_rename requires newChildPath.');
    return {
      id: randomUUID(),
      resourceUri: op.targetUri,
      entryUri,
      changeKind: 'rename',
      beforeHash: snapshot.contentHash,
      afterHash: snapshot.contentHash,
      inverse: {
        id: randomUUID(),
        kind: 'container_child_rename',
        ...fields,
        childPath: newName,
        newChildPath: snapshot.name,
        childUri: entryUriFor(op, newName),
        expectedChildHash: snapshot.contentHash,
        rollbackHint: { strategy: 'inverse_patch', notes: `资源条目 ${entryUri} 的 rename 逆操作` },
        metadata: {
          inverseResourceEntry: true,
          entryUri,
          nativeFormatAuthority: true,
          nativeEntryIndex: snapshot.index,
          nativeEntryId: snapshot.id
        }
      }
    };
  }

  if (mutation === 'move') {
    const toIndex = op.metadata?.toIndex;
    if (typeof toIndex !== 'number') throw new Error('container_child_move requires metadata.toIndex.');
    return {
      id: randomUUID(),
      resourceUri: op.targetUri,
      entryUri,
      changeKind: 'move',
      beforeHash: snapshot.contentHash,
      afterHash: snapshot.contentHash,
      inverse: {
        id: randomUUID(),
        kind: 'container_child_move',
        ...fields,
        childPath: snapshot.name,
        childUri: entryUri,
        expectedChildHash: snapshot.contentHash,
        rollbackHint: { strategy: 'inverse_patch', notes: `资源条目 ${entryUri} 的 move 逆操作` },
        metadata: {
          inverseResourceEntry: true,
          entryUri,
          nativeFormatAuthority: true,
          // After the forward move the entry sits at toIndex; restore original index.
          nativeEntryIndex: toIndex,
          nativeEntryId: snapshot.id,
          toIndex: snapshot.index
        }
      }
    };
  }

  throw new Error(`Unsupported BND4 mutation for inverse: ${op.kind}`);
}

function buildAddInverse(op: ContainerChildOp): ResourceEntryChangeInput {
  const name = op.newChildPath ?? op.childPath;
  if (!name || !op.childContentBase64) {
    throw new Error('container_child_add inverse requires name and childContentBase64.');
  }
  const afterHash = sha256Base64(op.childContentBase64);
  const entryUri = entryUriFor(op, name);
  const fields = baseInverseFields(op);
  return {
    id: randomUUID(),
    resourceUri: op.targetUri,
    entryUri,
    changeKind: 'add',
    afterHash,
    inverse: {
      id: randomUUID(),
      kind: 'container_child_delete',
      ...fields,
      childPath: name,
      childUri: entryUri,
      expectedChildHash: afterHash,
      rollbackHint: { strategy: 'inverse_patch', notes: `资源条目 ${entryUri} 的 add 逆操作（删除）` },
      metadata: {
        inverseResourceEntry: true,
        entryUri,
        nativeFormatAuthority: true,
        ...(typeof op.metadata?.nativeEntryId === 'number' ? { nativeEntryId: op.metadata.nativeEntryId } : {})
      }
    }
  };
}

/**
 * Capture resource-entry inverse records for native BND4 ops in a patch.
 * Returns diagnostics when capture fails; callers must refuse the write.
 */
export async function captureNativeBnd4ResourceEntryChanges(
  operations: PatchIrOperation[],
  workspaceRoot: string
): Promise<{ changes: ResourceEntryChangeInput[]; diagnostics: Diagnostic[] }> {
  const changes: ResourceEntryChangeInput[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const op of operations) {
    if (!isNativeBnd4(op)) continue;
    try {
      if (op.kind === 'container_child_add') {
        changes.push(buildAddInverse(op));
        continue;
      }
      const { snapshot, diagnostic } = await snapshotChild(op, workspaceRoot);
      if (diagnostic || !snapshot) {
        if (diagnostic) diagnostics.push(diagnostic);
        continue;
      }
      changes.push(buildInverseFromSnapshot(op, snapshot));
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED',
        message: error instanceof Error ? error.message : '捕获 BND4 条目逆操作失败。',
        details: { targetUri: op.targetUri, kind: op.kind }
      });
    }
  }

  return { changes, diagnostics };
}

export function isValidContainerResourceEntryInverse(
  change: { changeKind: string; beforeHash?: string; afterHash?: string; inverse: PatchIrOperation },
  containerAfterHash: string | undefined
): { ok: true } | { ok: false; code: string; message: string } {
  const inverse = change.inverse;
  if (!inverse.kind.startsWith('container_child_')) {
    return { ok: false, code: 'RESOURCE_ENTRY_INVERSE_EVIDENCE_INVALID', message: '资源条目逆操作类型无效。' };
  }
  const containerOp = inverse as ContainerChildOp;
  if (!containerAfterHash || containerOp.expectedContainerHash !== containerAfterHash) {
    return {
      ok: false,
      code: 'RESOURCE_ENTRY_CONTAINER_HASH_INVALID',
      message: '资源条目逆操作没有绑定容器 afterHash。'
    };
  }

  switch (change.changeKind) {
    case 'replace':
      if (inverse.kind !== 'container_child_replace'
        || !change.afterHash
        || containerOp.expectedChildHash !== change.afterHash
        || !containerOp.childContentBase64) {
        return { ok: false, code: 'RESOURCE_ENTRY_INVERSE_EVIDENCE_INVALID', message: 'replace 逆操作证据不完整。' };
      }
      return { ok: true };
    case 'add':
      if (inverse.kind !== 'container_child_delete'
        || !change.afterHash
        || containerOp.expectedChildHash !== change.afterHash) {
        return { ok: false, code: 'RESOURCE_ENTRY_INVERSE_EVIDENCE_INVALID', message: 'add 逆操作证据不完整。' };
      }
      return { ok: true };
    case 'delete':
      if (inverse.kind !== 'container_child_add'
        || !change.beforeHash
        || !containerOp.childContentBase64) {
        return { ok: false, code: 'RESOURCE_ENTRY_INVERSE_EVIDENCE_INVALID', message: 'delete 逆操作证据不完整。' };
      }
      return { ok: true };
    case 'rename':
      if (inverse.kind !== 'container_child_rename'
        || !containerOp.newChildPath
        || !containerOp.expectedChildHash) {
        return { ok: false, code: 'RESOURCE_ENTRY_INVERSE_EVIDENCE_INVALID', message: 'rename 逆操作证据不完整。' };
      }
      return { ok: true };
    case 'move':
      if (inverse.kind !== 'container_child_move'
        || typeof containerOp.metadata?.toIndex !== 'number') {
        return { ok: false, code: 'RESOURCE_ENTRY_INVERSE_EVIDENCE_INVALID', message: 'move 逆操作证据不完整。' };
      }
      return { ok: true };
    default:
      return {
        ok: false,
        code: 'RESOURCE_ENTRY_INVERSE_EVIDENCE_INVALID',
        message: `未知 changeKind：${change.changeKind}。`
      };
  }
}
