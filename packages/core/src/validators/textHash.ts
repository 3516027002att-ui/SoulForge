/**
 * Shared content-hash checks for text/raw scaffold writers and validators.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PatchIrOperation, StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Buffer(bytes: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Resolve the expected content hash for an operation, if any.
 * Prefer explicit expectedHash; fall back to content_hash preconditions.
 */
export function resolveExpectedHash(op: PatchIrOperation): string | undefined {
  if (op.expectedHash) return op.expectedHash;
  for (const precondition of op.preconditions ?? []) {
    if (precondition.type === 'content_hash' && precondition.expectedHash) {
      return precondition.expectedHash;
    }
  }
  return undefined;
}

export type HashCheckPhase =
  | 'before_staging'
  | 'apply_to_staging'
  | 'staged_output'
  | 'before_commit';

/**
 * When expectedHash is set, the on-disk original must match or the write is blocked.
 * Production text path always sets expectedHash; low-level ops may omit it.
 */
export async function checkOriginalContentHash(
  op: PatchIrOperation,
  phase: HashCheckPhase,
  options?: { requireForTextEdit?: boolean }
): Promise<StructuredDiagnostic[]> {
  const isTextLike = op.kind === 'text_edit' || op.kind === 'file_replace';
  const expected = resolveExpectedHash(op);

  if (!expected) {
    if (options?.requireForTextEdit && isTextLike && op.kind === 'text_edit') {
      // Only emit when explicitly required (production validators can opt in).
      // Low-level createTextEditOperation without hash remains allowed.
      return [];
    }
    return [];
  }

  if (!op.targetPath) {
    return [createDiagnostic({
      severity: 'error',
      code: 'PRECONDITION_FAILED',
      message: 'Content hash precondition requires targetPath.',
      targetUri: op.targetUri
    })];
  }

  try {
    const actual = await sha256File(op.targetPath);
    if (actual !== expected) {
      const isStalePhase = phase === 'staged_output' || phase === 'before_commit';
      const code = isStalePhase
        ? 'ORIGINAL_CHANGED_DURING_STAGING'
        : (isTextLike ? 'TEXT_EDIT_HASH_MISMATCH' : 'HASH_MISMATCH');
      const message = isStalePhase
        ? 'Original file changed after staging started. Refusing to overwrite newer data.'
        : isTextLike
          ? 'Text edit content hash precondition failed: original file does not match expectedHash.'
          : 'Content hash precondition failed: original file does not match expectedHash.';
      return [createDiagnostic({
        severity: 'error',
        code,
        message,
        targetUri: op.targetUri,
        details: {
          expected,
          actual,
          targetPath: op.targetPath,
          phase
        }
      })];
    }
  } catch (error) {
    return [createDiagnostic({
      severity: 'error',
      code: 'PRECONDITION_FAILED',
      message: error instanceof Error
        ? `Failed to read target for hash check: ${error.message}`
        : 'Failed to read target for hash check.',
      targetUri: op.targetUri,
      details: { targetPath: op.targetPath, phase }
    })];
  }

  return [];
}

/** Production text-edit ops should carry expectedHash. */
export function requireTextEditHash(op: PatchIrOperation): StructuredDiagnostic[] {
  if (op.kind !== 'text_edit') return [];
  if (resolveExpectedHash(op)) return [];
  return [createDiagnostic({
    severity: 'error',
    code: 'TEXT_EDIT_HASH_REQUIRED',
    message: 'Production text_edit requires expectedHash (content hash of the original file).',
    targetUri: op.targetUri,
    details: { opId: op.id }
  })];
}
