import { createHash } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import {
  rollbackFile,
  rollbackOperation,
  type KnowledgeRefreshResult,
  type WorkspaceSession
} from '@soulforge/core';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  SaveTextResourceResult
} from '@soulforge/shared';
import {
  sanitizeDiagnostics,
  toRendererHistoryEntry,
  type RendererPatchHistoryEntry
} from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { TrustedIpcHandle } from './registration.js';

export interface RollbackOperationIpcResult {
  ok: boolean;
  opId: string;
  inverseOpId?: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
  knowledgeRefresh?: NonNullable<SaveTextResourceResult['knowledgeRefresh']>;
}

/** Prevent duplicate rollback dialogs/transactions while one request is in flight. */
const activeRollbackRequests = new Set<string>();

export interface OperationIpcDeps {
  handle: TrustedIpcHandle;
  readonly activeSession: WorkspaceSession | null;
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
  refreshActiveIndexAfterNativeWrite(
    changedSources?: readonly string[],
    carrier?: { knowledgeRefresh?: SaveTextResourceResult['knowledgeRefresh'] }
  ): Promise<KnowledgeRefreshResult | void>;
}

export function registerOperationIpcHandlers(deps: OperationIpcDeps): void {
  deps.handle('operation.list', async (): Promise<RendererPatchHistoryEntry[]> => {
    if (!deps.activeSession || !deps.activeOperationLog) return [];
    const history = await deps.activeOperationLog.history(deps.activeSession.meta.workspaceId);
    const reversedOperationIds = new Set(
      history
        .filter((entry) => entry.status === 'committed' && entry.inverseOfOpId)
        .map((entry) => entry.inverseOfOpId!)
    );
    // 逆事务属于实现细节，不作为第二条逻辑历史展示；原操作保留并标记为
    // rolled_back。这样 UI 不会给 inverseOfOpId/rollbackScope 再渲染回滚按钮。
    return history
      .filter((entry) => !entry.inverseOfOpId && !entry.rollbackScope)
      .map((entry) => toRendererHistoryEntry(
        reversedOperationIds.has(entry.opId) ? { ...entry, status: 'rolled_back' } : entry,
        deps.indexedFiles
      ));
  });

  deps.handle('operation.rollback', async (_event, opId: string): Promise<RollbackOperationIpcResult> => {
    if (!deps.activeSession || !deps.activeOperationLog) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'WORKSPACE_NOT_OPEN',
          message: 'Open a workspace before rolling back an operation.'
        }]
      };
    }

    const sourceOperation = await deps.activeOperationLog.get(opId);
    if (!sourceOperation) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'OPERATION_NOT_FOUND',
          message: '找不到要回滚的操作。'
        }]
      };
    }
    if (sourceOperation.inverseOfOpId || sourceOperation.rollbackScope) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'ROLLBACK_OF_ROLLBACK_FORBIDDEN',
          message: '逆向事务不能再次回滚；请回滚原始逻辑操作。'
        }]
      };
    }
    const rollbackKey = `operation:${opId}`;
    if (activeRollbackRequests.has(rollbackKey)) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'warning',
          code: 'ROLLBACK_IN_PROGRESS',
          message: '该操作的回滚请求正在处理中，请勿重复提交。'
        }]
      };
    }
    activeRollbackRequests.add(rollbackKey);
    try {
    const confirmation = await deps.requestWriteConfirmation({
      event: _event,
      resourceLabel: sourceOperation.title,
      sourceUri: sourceOperation.files[0]?.targetUri ?? `operation://${opId}`,
      actionLabel: '回滚操作',
      payloadHash: createHash('sha256').update(opId).digest('hex'),
      extraSubjects: [`ROLLBACK_OPERATION:${opId}`]
    });
    if (!confirmation) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'warning',
          code: 'WRITE_CONFIRMATION_CANCELLED',
          message: '用户取消了回滚操作。'
        }]
      };
    }

    const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);

    const result = await rollbackOperation({
      opId,
      store: deps.activeOperationLog,
      session: deps.activeSession,
      confirmation,
      ...storage
    });
    const response: RollbackOperationIpcResult = {
      ok: result.ok,
      opId: result.opId,
      ...(result.inverseOpId ? { inverseOpId: result.inverseOpId } : {}),
      restoredFiles: result.restoredFiles.map((path) => {
        return deps.indexedFiles.find((file) => file.absolutePath === path)?.sourceUri ?? '[本机路径已隐藏]';
      }),
      diagnostics: sanitizeDiagnostics(result.diagnostics)
    };
    if (result.ok && result.restoredFiles.length > 0) {
      await deps.refreshActiveIndexAfterNativeWrite(result.restoredFiles, response);
    }
    return response;
    } finally {
      activeRollbackRequests.delete(rollbackKey);
    }
  });

  deps.handle('operation.rollbackFile', async (_event, opId: string, targetUri: string): Promise<RollbackOperationIpcResult> => {
    if (!deps.activeSession || !deps.activeOperationLog) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'WORKSPACE_NOT_OPEN',
          message: 'Open a workspace before rolling back a file.'
        }]
      };
    }

    const sourceOperation = await deps.activeOperationLog.get(opId);
    if (!sourceOperation) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'OPERATION_NOT_FOUND',
          message: '找不到要回滚的操作。'
        }]
      };
    }
    if (sourceOperation.inverseOfOpId || sourceOperation.rollbackScope) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'ROLLBACK_OF_ROLLBACK_FORBIDDEN',
          message: '逆向事务不能再次回滚；请回滚原始逻辑操作。'
        }]
      };
    }
    const fileRecord = sourceOperation.files.find((file) => file.targetUri === targetUri);
    if (!fileRecord) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'ROLLBACK_FILE_NOT_FOUND',
          message: `操作 ${opId} 中不存在资源 ${targetUri}。`
        }]
      };
    }
    const rollbackKey = `file:${opId}:${targetUri}`;
    if (activeRollbackRequests.has(rollbackKey)) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'warning',
          code: 'ROLLBACK_IN_PROGRESS',
          message: '该文件的回滚请求正在处理中，请勿重复提交。'
        }]
      };
    }
    activeRollbackRequests.add(rollbackKey);
    try {
    const confirmation = await deps.requestWriteConfirmation({
      event: _event,
      resourceLabel: `${sourceOperation.title} · ${targetUri}`,
      sourceUri: targetUri,
      actionLabel: '回滚该文件',
      payloadHash: createHash('sha256').update(`${opId}:${targetUri}`).digest('hex'),
      extraSubjects: [`ROLLBACK_FILE:${opId}:${targetUri}`]
    });
    if (!confirmation) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'warning',
          code: 'WRITE_CONFIRMATION_CANCELLED',
          message: '用户取消了该文件的回滚。'
        }]
      };
    }

    const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);

    const result = await rollbackFile({
      opId,
      targetUri,
      store: deps.activeOperationLog,
      session: deps.activeSession,
      confirmation,
      ...storage
    });
    const response: RollbackOperationIpcResult = {
      ok: result.ok,
      opId: result.opId,
      ...(result.inverseOpId ? { inverseOpId: result.inverseOpId } : {}),
      restoredFiles: result.restoredFiles.map((path) => {
        return deps.indexedFiles.find((file) => file.absolutePath === path)?.sourceUri ?? '[本机路径已隐藏]';
      }),
      diagnostics: sanitizeDiagnostics(result.diagnostics)
    };
    if (result.ok && result.restoredFiles.length > 0) {
      await deps.refreshActiveIndexAfterNativeWrite(result.restoredFiles, response);
    }
    return response;
    } finally {
      activeRollbackRequests.delete(rollbackKey);
    }
  });
}
