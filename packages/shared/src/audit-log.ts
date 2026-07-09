/**
 * Audit log scaffold (architecture fork areas for transaction / AI tool audit).
 * JSONL or SQLite-ready interface; no full DB driver required.
 */

import type { StructuredDiagnostic } from './diagnostics.js';
import type { ValidationResult } from './types.js';

export type AuditActorKind = 'user' | 'system' | 'agent';

export type AuditEventKind =
  | 'transaction_created'
  | 'patch_added'
  | 'staging_created'
  | 'patch_applied_to_staging'
  | 'validation'
  | 'commit'
  | 'rollback'
  | 'tool_call'
  | 'policy_decision'
  | 'confirmation'
  | 'failure_recovery';

export interface AuditActor {
  kind: AuditActorKind;
  id: string;
  displayName?: string;
}

export interface ConfirmationReceiptRef {
  receiptId: string;
  subjects: string[];
  confirmedAt: string;
  note?: string;
}

export interface AuditLogEntry {
  entryId: string;
  operationId?: string;
  transactionId?: string;
  actor: AuditActor;
  timestamp: string;
  eventKind: AuditEventKind;
  toolCallId?: string;
  patchId?: string;
  affectedResources: string[];
  validationResult?: Pick<ValidationResult, 'ok' | 'retryable'> & {
    diagnosticCodes: string[];
  };
  commitResult?: {
    ok: boolean;
    committedPaths: string[];
  };
  rollbackResult?: {
    ok: boolean;
    restoredPaths: string[];
  };
  diagnostics: StructuredDiagnostic[];
  confirmationReceipts: ConfirmationReceiptRef[];
  details?: Record<string, unknown>;
}

/**
 * SQLite-ready row shape.
 */
export interface AuditLogRow {
  entry_id: string;
  operation_id: string | null;
  transaction_id: string | null;
  actor_kind: string;
  actor_id: string;
  timestamp: string;
  event_kind: string;
  tool_call_id: string | null;
  patch_id: string | null;
  affected_resources_json: string;
  payload_json: string;
  diagnostics_json: string;
}

export interface AuditLogStore {
  append(entry: AuditLogEntry): void;
  list(filter?: {
    transactionId?: string;
    operationId?: string;
    patchId?: string;
    limit?: number;
  }): AuditLogEntry[];
  clear?(): void;
}
