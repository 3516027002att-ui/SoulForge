import { AsyncLocalStorage } from 'node:async_hooks';
import type { OperationLogRecord } from '@soulforge/shared';
import type { OperationLogStore } from '../patch/operationLog.js';

export type TransactionOutcomeState = 'not_committed' | 'committed' | 'unknown' | 'recovery_required' | 'rolled_back';
export interface OperationOutcome {
  opId: string;
  state: TransactionOutcomeState;
  operation?: OperationLogRecord;
}
export interface SessionTransactionOutcome {
  state: TransactionOutcomeState;
  /** Present for a single operation; multiple-operation requests use operations. */
  opId?: string;
  operations: OperationOutcome[];
}

// This is request correlation only. Persistent truth remains in OperationLogStore
// and its existing transaction journal, never a second transaction ledger.
export interface OperationRequestIdentity { sessionName: string; id: string; payloadHash: string }
const activeRequest = new AsyncLocalStorage<{ observe: (opId: string, store: OperationLogStore) => void; identity?: OperationRequestIdentity }>();
export function trackRequestOperations<T>(
  observe: (opId: string, store: OperationLogStore) => void,
  execute: () => Promise<T>,
  identity?: OperationRequestIdentity
): Promise<T> {
  return activeRequest.run({ observe, ...(identity ? { identity } : {}) }, execute);
}
export function noteOperationStarted(opId: string, store: OperationLogStore): void {
  activeRequest.getStore()?.observe(opId, store);
}

/** Correlation is metadata in the existing journal, preserved through every phase. */
export function journalStateWithRequest(state: unknown): unknown {
  const request = activeRequest.getStore()?.identity;
  return request ? { ...(state && typeof state === 'object' && !Array.isArray(state) ? state : { state }), request } : state;
}

/** Query authoritative state. Missing receipts and transport failure are unknown. */
export async function queryOperationOutcome(store: OperationLogStore, opId: string): Promise<OperationOutcome> {
  try {
    const operation = await store.get(opId);
    const journal = await store.getTransactionForOperation?.(opId);
    let state: TransactionOutcomeState = 'unknown';
    if (operation?.status === 'recovery_required' || journal?.phase === 'recovery_required') state = 'recovery_required';
    else if (operation?.status === 'rolled_back' || journal?.phase === 'rolled_back') state = 'rolled_back';
    else if (operation?.status === 'committed' && (!journal || journal.phase === 'committed')) state = 'committed';
    return { opId, state, ...(operation ? { operation } : {}) };
  } catch { return { opId, state: 'unknown' }; }
}

export function summarizeOperationOutcomes(operations: OperationOutcome[], notStarted = false): SessionTransactionOutcome {
  let state: TransactionOutcomeState = notStarted ? 'not_committed' : 'unknown';
  if (operations.length) {
    if (operations.some(op => op.state === 'recovery_required')) state = 'recovery_required';
    else if (operations.some(op => op.state === 'unknown')) state = 'unknown';
    else if (operations.some(op => op.state === 'committed')) state = 'committed';
    else if (operations.every(op => op.state === 'rolled_back')) state = 'rolled_back';
    else if (operations.every(op => op.state === 'not_committed')) state = 'not_committed';
  }
  return { state, ...(operations.length === 1 ? { opId: operations[0]!.opId } : {}), operations };
}

/** Known executor receipt fields only; never model text or a tool-name heuristic. */
export function receiptOperationIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 3 || !node || typeof node !== 'object' || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if (typeof record.opId === 'string' && record.opId.trim()) ids.add(record.opId);
    if (typeof record.ok === 'boolean' && typeof record.content === 'string' && record.content.length <= 4 * 1024 * 1024) {
      try { visit(JSON.parse(record.content), depth + 1); } catch { /* Non-JSON diagnostics are not receipts. */ }
    }
    for (const key of ['data', 'operation', 'transaction', 'result']) visit(record[key], depth + 1);
  };
  visit(value, 0);
  return [...ids];
}
