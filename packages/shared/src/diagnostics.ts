/**
 * Structured diagnostics for safety gates (architecture forks #109, #151 area).
 * Extends the lightweight Diagnostic used across the product with URI / provenance hooks.
 */

import type { ConfidenceAssessment } from './confidence.js';
import type { ProvenanceChain } from './provenance.js';
import type { Diagnostic, DiagnosticSeverity } from './types.js';

export type DiagnosticCode =
  | string
  | 'UNSUPPORTED_FORMAT'
  | 'PARSE_FAILED'
  | 'PARSE_PARTIAL'
  | 'WRITER_CONTRACT_ABSENT'
  | 'VALIDATOR_FAILED'
  | 'PRECONDITION_FAILED'
  | 'HASH_MISMATCH'
  | 'POLICY_DENIED'
  | 'TRANSACTION_FAILED'
  | 'ROLLBACK_FAILED'
  | 'SCHEMA_MISMATCH'
  | 'INSUFFICIENT_EVIDENCE'
  | 'SYNTHETIC_NOT_NATIVE'
  | 'STAGING_INVALID'
  | 'COMMIT_BLOCKED';

export interface StructuredDiagnostic {
  severity: DiagnosticSeverity;
  code: DiagnosticCode;
  message: string;
  /** ResourceURI / FieldURI / file URI target when known. */
  targetUri?: string;
  sourceUri?: string;
  provenance?: ProvenanceChain;
  confidence?: ConfidenceAssessment;
  details?: unknown;
  /** ISO-8601 */
  recordedAt?: string;
}

export interface DiagnosticAttachment {
  targetUri: string;
  diagnostics: StructuredDiagnostic[];
}

export function toLegacyDiagnostic(item: StructuredDiagnostic): Diagnostic {
  const diagnostic: Diagnostic = {
    severity: item.severity,
    code: String(item.code),
    message: item.message
  };
  if (item.sourceUri !== undefined) diagnostic.sourceUri = item.sourceUri;
  else if (item.targetUri !== undefined) diagnostic.sourceUri = item.targetUri;
  if (item.details !== undefined) diagnostic.details = item.details;
  return diagnostic;
}

export function fromLegacyDiagnostic(item: Diagnostic): StructuredDiagnostic {
  const diagnostic: StructuredDiagnostic = {
    severity: item.severity,
    code: item.code,
    message: item.message
  };
  if (item.sourceUri !== undefined) {
    diagnostic.sourceUri = item.sourceUri;
    diagnostic.targetUri = item.sourceUri;
  }
  if (item.details !== undefined) diagnostic.details = item.details;
  return diagnostic;
}

export function createDiagnostic(
  partial: Omit<StructuredDiagnostic, 'recordedAt'> & { recordedAt?: string }
): StructuredDiagnostic {
  const diagnostic: StructuredDiagnostic = {
    severity: partial.severity,
    code: partial.code,
    message: partial.message,
    recordedAt: partial.recordedAt ?? new Date().toISOString()
  };
  if (partial.targetUri !== undefined) diagnostic.targetUri = partial.targetUri;
  if (partial.sourceUri !== undefined) diagnostic.sourceUri = partial.sourceUri;
  if (partial.provenance !== undefined) diagnostic.provenance = partial.provenance;
  if (partial.confidence !== undefined) diagnostic.confidence = partial.confidence;
  if (partial.details !== undefined) diagnostic.details = partial.details;
  return diagnostic;
}

export function hasErrorDiagnostics(items: readonly StructuredDiagnostic[]): boolean {
  return items.some((item) => item.severity === 'error');
}

export function collectDiagnosticCodes(items: readonly StructuredDiagnostic[]): string[] {
  return [...new Set(items.map((item) => String(item.code)))];
}
