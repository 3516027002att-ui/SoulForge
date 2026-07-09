/**
 * Validator for container_child_replace operations.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { decompressDcx } from '../containers/dcx.js';
import { readSyntheticBnd } from '../containers/bndSynthetic.js';
import { decodeStrictBase64 } from '../util/base64.js';
import { checkOriginalContentHash } from './textHash.js';

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

