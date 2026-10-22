import type { IpcMainInvokeEvent } from 'electron';
import type { KnowledgeRefreshResult, WorkspaceSession } from '@soulforge/core';
import type { ConfirmationReceipt, IndexedFile, SaveTextResourceResult } from '@soulforge/shared';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { TrustedIpcHandle } from './registration.js';
import { createOperationService } from '../services/operationService.js';
export { getRollbackForensicsCounters, hasActiveRollbackRequests } from '../services/operationService.js';
export type { RollbackOperationIpcResult } from '../services/operationService.js';
export interface OperationIpcDeps {
    handle: TrustedIpcHandle;
    readonly activeSession: WorkspaceSession | null;
    readonly activeWorkspaceSessionGeneration: number;
    readonly activeOperationLog: OperationLogUtilityClient | null;
    readonly indexedFiles: readonly IndexedFile[];
    durableStoragePaths(workspaceId: string): {
        root: string;
        backupBaseDir: string;
        recoveryDir: string;
        stagingRoot: string;
    };
    requestWriteConfirmation(input: {
        event?: IpcMainInvokeEvent;
        resourceLabel: string;
        sourceUri: string;
        actionLabel: string;
        payloadHash: string;
        extraSubjects?: string[];
    }): Promise<ConfirmationReceipt | null>;
    refreshActiveIndexAfterNativeWrite(changedSources?: readonly string[], carrier?: {
        knowledgeRefresh?: SaveTextResourceResult['knowledgeRefresh'];
    }): Promise<KnowledgeRefreshResult | void>;
}
export function registerOperationIpcHandlers(deps: OperationIpcDeps): void {
    const service = createOperationService({ getActiveSession: () => deps.activeSession, getActiveWorkspaceSessionGeneration: () => deps.activeWorkspaceSessionGeneration, getActiveOperationLog: () => deps.activeOperationLog, getIndexedFiles: () => deps.indexedFiles, durableStoragePaths: deps.durableStoragePaths, refreshActiveIndexAfterNativeWrite: deps.refreshActiveIndexAfterNativeWrite });
    const requestWriteConfirmation = deps.requestWriteConfirmation;
    deps.handle('operation.list', () => service.list());
    deps.handle('operation.rollback', (event, opId: string) => service.rollback(input => requestWriteConfirmation({ ...input, event }), opId));
    deps.handle('operation.rollbackFile', (event, opId: string, targetUri: string) => service.rollbackFile(input => requestWriteConfirmation({ ...input, event }), opId, targetUri));
}
