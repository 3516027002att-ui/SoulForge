import type { Diagnostic, ValidationResult } from '@soulforge/shared';

export interface DiagnosticsGateOptions {
  /**
   * When true, warning-level diagnostics also fail the gate.
   * Default false: only error severity blocks commit.
   */
  failOnWarning?: boolean;
  /**
   * Codes that always block regardless of severity (e.g. policy tags).
   */
  hardBlockCodes?: readonly string[];
}

/**
 * Patch Engine diagnostics gate.
 * Diagnostics are not logs — they drive UI, AI prompts, and commit policy.
 */
export function evaluateDiagnosticsGate(
  diagnostics: readonly Diagnostic[],
  options: DiagnosticsGateOptions = {}
): ValidationResult {
  const hard = new Set(options.hardBlockCodes ?? []);
  const blocking = diagnostics.filter((diagnostic) => {
    if (hard.has(diagnostic.code)) return true;
    if (diagnostic.severity === 'error') return true;
    if (options.failOnWarning && diagnostic.severity === 'warning') return true;
    return false;
  });

  return {
    ok: blocking.length === 0,
    diagnostics: [...diagnostics],
    retryable: blocking.every((diagnostic) => diagnostic.severity !== 'error' || isRetryableCode(diagnostic.code))
  };
}

export function mergeValidationResults(...results: ValidationResult[]): ValidationResult {
  const diagnostics = results.flatMap((result) => result.diagnostics);
  const ok = results.every((result) => result.ok);
  const retryable = results.some((result) => result.retryable);
  return { ok, diagnostics, retryable };
}

function isRetryableCode(code: string): boolean {
  return code !== 'ORIGINAL_CHANGED_DURING_STAGING'
    && code !== 'WRITE_TO_BASE_FORBIDDEN'
    && code !== 'WRITER_CONTRACT_ABSENT'
    && code !== 'BINARY_WRITER_DISABLED'
    && code !== 'STRUCTURED_WRITER_NOT_IMPLEMENTED';
}
