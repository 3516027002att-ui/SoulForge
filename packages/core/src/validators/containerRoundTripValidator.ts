/**
 * Validator for container_child_replace operations.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  PatchIR,
  PatchIrOperation,
  ContainerChildOp,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { decompressDcx } from '../containers/dcx.js';
import { readSyntheticBnd } from '../containers/bndSynthetic.js';
import { decodeStrictBase64 } from '../util/base64.js';
import { checkOriginalContentHash } from './textHash.js';
import { runBridge } from '../bridge/runBridge.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function childSelector(op: PatchIrOperation): string {
  if (op.kind !== 'container_child_replace') return '';
  if (op.childPath) return op.childPath;
  if (op.childUri) {
    const hash = op.childUri.indexOf('#');
    const fragment = hash >= 0 ? op.childUri.slice(hash + 1) : op.childUri;
    const parts = fragment.split('/').filter(Boolean);
    const idx = parts.lastIndexOf('child');
    return decodeURIComponent((idx >= 0 ? parts[idx + 1] : parts[parts.length - 1]) ?? '');
  }
  return '';
}

export class ContainerRoundTripValidator implements ValidatorContract {
  readonly validatorId = 'container_roundtrip';
  readonly targetResourceKinds = ['*'] as const;
  readonly validationScope = ['before_staging', 'staged_output', 'after_commit'] as const;

  async validateBeforeStaging(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): Promise<ValidatorResult> {
    const diagnostics: StructuredDiagnostic[] = [];
    for (const op of input.operations) {
      if (isNativeBnd4(op)) {
        const nativeOp = op as ContainerChildOp;
        if (!nativeOp.expectedContainerHash && !nativeOp.expectedHash) diagnostics.push(nativeError(nativeOp, 'CONTAINER_HASH_REQUIRED', '原生 BND4 操作需要容器 expectedHash。'));
        if (nativeOp.kind !== 'container_child_add' && !nativeOp.expectedChildHash) diagnostics.push(nativeError(nativeOp, 'CONTAINER_CHILD_HASH_REQUIRED', '原生 BND4 目标操作需要 expectedChildHash。'));
        if ((nativeOp.kind === 'container_child_replace' || nativeOp.kind === 'container_child_add') && !nativeOp.childContentBase64) diagnostics.push(nativeError(nativeOp, 'CONTAINER_CHILD_PAYLOAD_REQUIRED', '原生 BND4 replace/add 需要子项内容。'));
        const expected = nativeOp.expectedHash ?? nativeOp.expectedContainerHash;
        if (nativeOp.targetPath && expected) diagnostics.push(...await checkOriginalContentHash({ ...nativeOp, expectedHash: expected }, 'before_staging'));
        continue;
      }
      if (op.kind !== 'container_child_replace') continue;

      if (!op.expectedContainerHash && !op.expectedHash) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_HASH_REQUIRED',
          message: 'expectedContainerHash required before staging.',
          targetUri: op.targetUri
        }));
      }
      if (!op.expectedChildHash) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_CHILD_HASH_REQUIRED',
          message: 'expectedChildHash required before staging.',
          targetUri: op.targetUri
        }));
      }
      if (!op.childContentBase64) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_CHILD_PAYLOAD_REQUIRED',
          message: 'childContentBase64 required before staging.',
          targetUri: op.targetUri
        }));
      } else {
        try {
          decodeStrictBase64(op.childContentBase64, { allowEmpty: false });
        } catch (error) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'BASE64_INVALID',
            message: error instanceof Error ? error.message : 'Invalid childContentBase64.',
            targetUri: op.targetUri
          }));
        }
      }

      const expected = op.expectedHash ?? op.expectedContainerHash;
      if (expected && op.targetPath) {
        const hashOp: PatchIrOperation = {
          ...op,
          expectedHash: expected
        };
        diagnostics.push(...await checkOriginalContentHash(hashOp, 'before_staging'));
      }
    }
    return {
      ok: diagnostics.every((d) => d.severity !== 'error'),
      diagnostics,
      scope: 'before_staging',
      validatorId: this.validatorId
    };
  }

  async validateStagedOutput(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    stagedPaths: string[];
    stagingRoot: string;
  }): Promise<ValidatorResult> {
    const diagnostics: StructuredDiagnostic[] = [];
    for (const op of input.operations) {
      if (isNativeBnd4(op)) {
        const nativeOp = op as ContainerChildOp;
        const staged = findStagedPath(nativeOp, input.stagedPaths);
        if (!staged) diagnostics.push(nativeError(nativeOp, 'CONTAINER_STAGED_PATH_MISSING', '找不到原生 BND4 暂存输出。'));
        else diagnostics.push(...await validateNativeMutation(nativeOp, staged, nativeOp.targetPath));
        continue;
      }
      if (op.kind !== 'container_child_replace') continue;
      if (!op.targetPath) continue;

      const baseName = op.targetPath.split(/[/\\]/).pop() ?? '';
      const staged = input.stagedPaths.find((p) =>
        p.includes(op.id.slice(0, 8)) || (baseName.length > 0 && p.endsWith(baseName))
      );
      if (!staged) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_STAGED_PATH_MISSING',
          message: 'No staged path found for container_child_replace validation.',
          targetUri: op.targetUri
        }));
        continue;
      }

      let stagedBytes: Buffer;
      let original: Buffer;
      try {
        stagedBytes = await readFile(staged);
        original = await readFile(op.targetPath);
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_STAGED_READ_FAILED',
          message: error instanceof Error ? error.message : 'Failed to read staged container.',
          targetUri: op.targetUri
        }));
        continue;
      }

      const selector = childSelector(op);
      let newChildHash = '';
      try {
        newChildHash = sha256(decodeStrictBase64(op.childContentBase64 ?? '', { allowEmpty: false }));
      } catch {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_CHILD_PAYLOAD_INVALID',
          message: 'Cannot decode childContentBase64 for staged validation.',
          targetUri: op.targetUri
        }));
        continue;
      }

      const originalChildren = await listChildHashes(original);
      const stagedChildren = await listChildHashes(stagedBytes);
      if (!stagedChildren.ok || !originalChildren.ok) {
        diagnostics.push(...originalChildren.diagnostics, ...stagedChildren.diagnostics);
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_STAGED_UNPACK_FAILED',
          message: 'Staged container could not be unpacked.',
          targetUri: op.targetUri
        }));
        continue;
      }

      if (stagedChildren.children.length !== originalChildren.children.length) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_CHILD_COUNT_CHANGED',
          message: 'Staged container child count differs from original.',
          targetUri: op.targetUri,
          details: {
            original: originalChildren.children.length,
            staged: stagedChildren.children.length
          }
        }));
      }

      for (const oc of originalChildren.children) {
        const sc = stagedChildren.children.find((c) => c.name === oc.name || c.id === oc.id);
        if (!sc) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'CONTAINER_CHILD_MISSING',
            message: `Child ${oc.name} missing after repack.`,
            targetUri: op.targetUri
          }));
          continue;
        }
        const isTarget = oc.name === selector || String(oc.id) === selector;
        if (isTarget) {
          if (sc.hash !== newChildHash) {
            diagnostics.push(createDiagnostic({
              severity: 'error',
              code: 'CONTAINER_TARGET_CHILD_HASH_MISMATCH',
              message: 'Target child hash in staged container does not match new content.',
              targetUri: op.targetUri,
              details: { expected: newChildHash, actual: sc.hash }
            }));
          }
        } else if (sc.hash !== oc.hash) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'CONTAINER_UNMODIFIED_CHILD_CHANGED',
            message: `Unmodified child ${oc.name} hash changed after repack.`,
            targetUri: op.targetUri,
            details: { expected: oc.hash, actual: sc.hash }
          }));
        }
      }

      const expected = op.expectedHash ?? op.expectedContainerHash;
      if (expected) {
        const hashOp: PatchIrOperation = {
          ...op,
          expectedHash: expected
        };
        diagnostics.push(...await checkOriginalContentHash(hashOp, 'staged_output'));
      }
    }

    return {
      ok: diagnostics.every((d) => d.severity !== 'error'),
      diagnostics,
      scope: 'staged_output',
      validatorId: this.validatorId
    };
  }

  async validateAfterCommit(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    committedPaths: string[];
  }): Promise<ValidatorResult> {
    const diagnostics: StructuredDiagnostic[] = [];
    for (const op of input.operations) {
      if (isNativeBnd4(op)) {
        const nativeOp = op as ContainerChildOp;
        if (nativeOp.targetPath) diagnostics.push(...await validateNativeMutation(nativeOp, nativeOp.targetPath));
        continue;
      }
      if (op.kind !== 'container_child_replace') continue;
      const path = op.targetPath;
      if (!path) continue;
      try {
        const bytes = await readFile(path);
        const list = await listChildHashes(bytes);
        if (!list.ok) {
          diagnostics.push(...list.diagnostics);
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'CONTAINER_AFTER_COMMIT_INSPECT_FAILED',
            message: 'Committed container could not be re-inspected.',
            targetUri: op.targetUri
          }));
          continue;
        }
        const selector = childSelector(op);
        const newChildHash = sha256(decodeStrictBase64(op.childContentBase64 ?? '', { allowEmpty: false }));
        const child = list.children.find((c) => c.name === selector || String(c.id) === selector);
        if (!child || child.hash !== newChildHash) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'CONTAINER_AFTER_COMMIT_CHILD_MISMATCH',
            message: 'Committed container does not contain expected replaced child.',
            targetUri: op.targetUri
          }));
        }
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'CONTAINER_AFTER_COMMIT_READ_FAILED',
          message: error instanceof Error ? error.message : 'Failed after commit read.',
          targetUri: op.targetUri
        }));
      }
    }
    return {
      ok: diagnostics.every((d) => d.severity !== 'error'),
      diagnostics,
      scope: 'after_commit',
      validatorId: this.validatorId
    };
  }
}

interface NativeBndEnvelope {
  nested?: { entryCount: number; entries: Array<{ id: number; name: string; contentHash: string }> };
}

function isNativeBnd4(op: PatchIrOperation): boolean {
  return op.kind.startsWith('container_child_')
    && 'containerFormat' in op
    && op.containerFormat === 'BND4_DFLT'
    && op.metadata?.nativeFormatAuthority === true;
}

function findStagedPath(op: ContainerChildOp, stagedPaths: string[]): string | undefined {
  const baseName = op.targetPath?.split(/[/\\]/).pop() ?? '';
  return stagedPaths.find((path) => path.includes(op.id.slice(0, 8)) || (baseName && path.endsWith(baseName)));
}

async function validateNativeMutation(op: ContainerChildOp, candidatePath: string, originalPath?: string): Promise<StructuredDiagnostic[]> {
  const candidate = await runBridge<NativeBndEnvelope>({
    command: 'read-dcx-document', filePath: candidatePath,
    allowedRoots: [candidatePath.split(/[/\\]/).slice(0, -1).join('/') || '.'], timeoutMs: 120_000
  });
  if (candidate.parseStatus === 'failed' || !candidate.data?.nested) {
    return [nativeError(op, 'BND4_NATIVE_REREAD_FAILED', '原生 BND4 输出无法由 Bridge 重读。')];
  }
  const entries = candidate.data.nested.entries;
  const index = typeof op.metadata?.nativeEntryIndex === 'number' ? op.metadata.nativeEntryIndex : -1;
  let ok = true;
  if (op.kind === 'container_child_replace') {
    const expected = sha256(decodeStrictBase64(op.childContentBase64 ?? '', { allowEmpty: false }));
    ok = index >= 0 && entries[index]?.contentHash === expected;
  } else if (op.kind === 'container_child_add') {
    ok = entries.some((entry) => entry.id === op.metadata?.nativeEntryId && entry.name === (op.newChildPath ?? op.childPath));
  } else if (op.kind === 'container_child_rename') {
    ok = index >= 0 && entries[index]?.name === op.newChildPath;
  } else if (op.kind === 'container_child_move') {
    const toIndex = Number(op.metadata?.toIndex);
    ok = Number.isInteger(toIndex) && entries[toIndex]?.id === op.metadata?.nativeEntryId;
    if (op.metadata?.nativeEntryId === undefined && originalPath) {
      const original = await runBridge<NativeBndEnvelope>({ command: 'read-dcx-document', filePath: originalPath, allowedRoots: [originalPath.split(/[/\\]/).slice(0, -1).join('/') || '.'], timeoutMs: 120_000 });
      ok = Number.isInteger(toIndex) && original.data?.nested?.entries[index]?.id === entries[toIndex]?.id;
    }
  } else if (op.kind === 'container_child_delete') {
    if (originalPath) {
      const original = await runBridge<NativeBndEnvelope>({ command: 'read-dcx-document', filePath: originalPath, allowedRoots: [originalPath.split(/[/\\]/).slice(0, -1).join('/') || '.'], timeoutMs: 120_000 });
      ok = candidate.data.nested.entryCount === (original.data?.nested?.entryCount ?? -1) - 1;
    } else ok = op.metadata?.nativeEntryId !== undefined
      ? entries.every((entry) => entry.id !== op.metadata?.nativeEntryId)
      : entries.every((entry) => entry.contentHash !== op.expectedChildHash);
  }
  return ok ? [] : [nativeError(op, 'BND4_NATIVE_MUTATION_MISMATCH', `原生 BND4 ${op.kind} 重读结果与请求不一致。`)];
}

function nativeError(op: PatchIrOperation, code: string, message: string): StructuredDiagnostic {
  return createDiagnostic({ severity: 'error', code, message, targetUri: op.targetUri });
}

async function listChildHashes(bytes: Buffer): Promise<{
  ok: boolean;
  children: Array<{ id: number; name: string; hash: string }>;
  diagnostics: StructuredDiagnostic[];
}> {
  // DCX nested
  if (bytes.subarray(0, 4).equals(Buffer.from('DCX\0', 'ascii'))) {
    const decomp = decompressDcx(bytes);
    if (!decomp.ok || !decomp.payload) {
      return { ok: false, children: [], diagnostics: decomp.diagnostics };
    }
    return listChildHashes(decomp.payload);
  }
  const read = readSyntheticBnd(bytes);
  if (!read.ok) {
    return { ok: false, children: [], diagnostics: read.diagnostics };
  }
  return {
    ok: true,
    children: read.children.map((c) => ({ id: c.id, name: c.name, hash: c.hash })),
    diagnostics: read.diagnostics
  };
}
