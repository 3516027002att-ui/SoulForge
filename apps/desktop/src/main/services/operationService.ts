import { createHash } from 'node:crypto';
import { rollbackFile as nativeRollbackFile, rollbackOperation as nativeRollbackOperation, type KnowledgeRefreshResult, type WorkspaceSession } from '@soulforge/core';
import type { Diagnostic, IndexedFile, SaveTextResourceResult } from '@soulforge/shared';
import { sanitizeDiagnostics, toRendererHistoryEntry, type RendererPatchHistoryEntry, type RendererResourceLabelSource } from '../rendererDto.js';
import { runCallerOwnedPostCommit } from '../knowledgeRefreshOwnership.js';
import { appendRendererPostCommitFailureDiagnostic } from '../rendererPostCommitDiagnostic.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
// Forensics counters (V1, pure diagnostic — no business logic change).
const _forensicsRbCounters = new Map<string, number>();
function _forensicsRbInc(key: string, delta = 1): void { _forensicsRbCounters.set(key, (_forensicsRbCounters.get(key) ?? 0) + delta); }
export function getRollbackForensicsCounters(): Record<string, number> { return Object.fromEntries(_forensicsRbCounters); }
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
const rollbackOwnerIds = new WeakMap<WorkspaceSession, number>();
let nextRollbackOwnerId = 0;
function rollbackOwnerKey(session: WorkspaceSession, generation: number, key: string): string {
    let id = rollbackOwnerIds.get(session);
    if (id === undefined) {
        id = ++nextRollbackOwnerId;
        rollbackOwnerIds.set(session, id);
    }
    return `${id}:${generation}:${key}`;
}
function supersededRollback(opId: string): RollbackOperationIpcResult {
    return { ok: false, opId, restoredFiles: [], diagnostics: [{ severity: 'warning', code: 'WORKSPACE_ROLLBACK_SUPERSEDED', message: '工作区会话已更换，旧回滚请求未启动事务。' }] };
}
export function hasActiveRollbackRequests(): boolean {
    return activeRollbackRequests.size > 0;
}
export interface OperationServiceDeps {
    getActiveSession(): WorkspaceSession | null;
    getActiveWorkspaceSessionGeneration(): number;
    getActiveOperationLog(): OperationLogUtilityClient | null;
    getIndexedFiles(): readonly IndexedFile[];
    durableStoragePaths(workspaceId: string): {
        root: string;
        backupBaseDir: string;
        recoveryDir: string;
        stagingRoot: string;
    };
    refreshActiveIndexAfterNativeWrite(changedSources?: readonly string[], carrier?: {
        knowledgeRefresh?: SaveTextResourceResult['knowledgeRefresh'];
    }): Promise<KnowledgeRefreshResult | void>;
}
import type { ResourceWriteConfirmation } from './resourceWriteContext.js';
/** Existing history/rollback application boundary; transaction authority stays in core. */
export function createOperationService(input: OperationServiceDeps) {
    const ports = Object.freeze({ ...input });
    const deps = Object.freeze({ get activeSession() { return ports.getActiveSession(); }, get activeOperationLog() { return ports.getActiveOperationLog(); }, get indexedFiles() { return ports.getIndexedFiles(); }, durableStoragePaths: ports.durableStoragePaths, refreshActiveIndexAfterNativeWrite: ports.refreshActiveIndexAfterNativeWrite });
    function captureOwner() {
        const session = ports.getActiveSession(), log = ports.getActiveOperationLog();
        const generation = ports.getActiveWorkspaceSessionGeneration();
        const workspaceId = session?.meta.workspaceId;
        const receiptFiles: readonly RendererResourceLabelSource[] = ports.getIndexedFiles().map(file => Object.freeze({ absolutePath: file.absolutePath, sourcePath: file.sourcePath, sourceUri: file.sourceUri }));
        const isCurrent = () => ports.getActiveSession() === session
            && ports.getActiveWorkspaceSessionGeneration() === generation && ports.getActiveOperationLog() === log;
        return { session, log, generation, workspaceId, receiptFiles, isCurrent };
    }
    async function refreshCommittedResult(owner: ReturnType<typeof captureOwner>, sourceUri: string, changedSources: readonly string[], response: RollbackOperationIpcResult): Promise<RollbackOperationIpcResult> {
        return runCallerOwnedPostCommit(response, {
            prepare: () => { },
            refresh: async (carrier) => {
                if (!owner.isCurrent()) {
                    carrier.diagnostics.push({ severity: 'warning', code: 'POSTCOMMIT_WORKSPACE_SUPERSEDED', sourceUri, message: '回滚已提交，但工作区会话已更换；未向当前会话发布旧投影。' });
                    return;
                }
                await deps.refreshActiveIndexAfterNativeWrite(changedSources, carrier);
            },
            onRefreshError: (carrier, error) => appendRendererPostCommitFailureDiagnostic(carrier, 'OPERATION_POSTCOMMIT_REFRESH_FAILED', sourceUri, error, '回滚已提交，但提交后的刷新失败；已保留原回滚结果。')
        });
    }
    const list = async (): Promise<RendererPatchHistoryEntry[]> => {
        const owner = captureOwner();
        if (!owner.session || !owner.log)
            return [];
        const history = await owner.log.history(owner.workspaceId);
        if (!owner.isCurrent())
            return [];
        const inverses = new Map<string, { wholeOperation: boolean; filePaths: Set<string> }>();
        for (const entry of history) {
            if (entry.status !== 'committed' || !entry.inverseOfOpId)
                continue;
            const inverse = inverses.get(entry.inverseOfOpId) ?? { wholeOperation: false, filePaths: new Set<string>() };
            // Unscoped legacy inverses were whole-operation rollbacks.
            if (!entry.rollbackScope || entry.rollbackScope === 'operation')
                inverse.wholeOperation = true;
            else if (entry.rollbackScope === 'file')
                entry.changedPaths.forEach(path => inverse.filePaths.add(path));
            inverses.set(entry.inverseOfOpId, inverse);
        }
        // Keep inverse transactions out of the logical history. Only complete
        // reversal marks the original rolled_back; partial file state stays actionable.
        return history
            .filter((entry) => !entry.inverseOfOpId && !entry.rollbackScope)
            .map((entry) => {
                const inverse = inverses.get(entry.opId);
                // Compare physical identities before masking: hidden labels can be identical.
                const fullyReversed = inverse?.wholeOperation || (entry.fileCount > 0
                    && entry.changedPaths.length === entry.fileCount
                    && entry.changedPaths.every(path => inverse?.filePaths.has(path)));
                const projected = toRendererHistoryEntry(fullyReversed ? { ...entry, status: 'rolled_back' } : entry, owner.receiptFiles);
                if (inverse && projected.status === 'committed') {
                    projected.partialRollback = { rolledBackPaths: projected.changedPaths.filter((_path, index) => inverse.filePaths.has(entry.changedPaths[index]!)) };
                }
                return projected;
            });
    };
    const rollback = async (requestConfirmation: ResourceWriteConfirmation, opId: string): Promise<RollbackOperationIpcResult> => {
        _forensicsRbInc('rollback:main:operation.rollback:count');
        const owner = captureOwner();
        if (!owner.session || !owner.log) {
            return {
                ok: false,
                opId,
                restoredFiles: [],
                diagnostics: [{
                        severity: 'error',
                        code: 'WORKSPACE_NOT_OPEN',
                        message: '请先打开工作区，再回滚操作。'
                    }]
            };
        }
        const sourceOperation = await owner.log.get(opId);
        if (!owner.isCurrent())
            return supersededRollback(opId);
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
        const rollbackKey = rollbackOwnerKey(owner.session, owner.generation, `operation:${opId}`);
        const receiptSourceUri = sourceOperation.files[0]?.targetUri ?? `operation://${opId}`;
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
            const confirmation = await requestConfirmation({
                resourceLabel: sourceOperation.title,
                sourceUri: receiptSourceUri,
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
            if (!owner.isCurrent())
                return supersededRollback(opId);
            const storage = deps.durableStoragePaths(owner.workspaceId!);
            const result = await nativeRollbackOperation({
                opId,
                store: owner.log,
                session: owner.session,
                confirmation,
                ...storage
            });
            const response: RollbackOperationIpcResult = {
                ok: result.ok,
                opId: result.opId,
                ...(result.inverseOpId ? { inverseOpId: result.inverseOpId } : {}),
                restoredFiles: result.restoredFiles.map((path) => {
                    return owner.receiptFiles.find((file) => file.absolutePath === path)?.sourceUri ?? '[本机路径已隐藏]';
                }),
                diagnostics: sanitizeDiagnostics(result.diagnostics)
            };
            if (result.ok && result.restoredFiles.length > 0) {
                await refreshCommittedResult(owner, `operation://${opId}`, result.restoredFiles, response);
            }
            return response;
        }
        finally {
            activeRollbackRequests.delete(rollbackKey);
        }
    };
    const rollbackFile = async (requestConfirmation: ResourceWriteConfirmation, opId: string, targetUri: string): Promise<RollbackOperationIpcResult> => {
        _forensicsRbInc('rollback:main:operation.rollbackFile:count');
        const owner = captureOwner();
        if (!owner.session || !owner.log) {
            return {
                ok: false,
                opId,
                restoredFiles: [],
                diagnostics: [{
                        severity: 'error',
                        code: 'WORKSPACE_NOT_OPEN',
                        message: '请先打开工作区，再回滚文件。'
                    }]
            };
        }
        const sourceOperation = await owner.log.get(opId);
        if (!owner.isCurrent())
            return supersededRollback(opId);
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
        const rollbackKey = rollbackOwnerKey(owner.session, owner.generation, `file:${opId}:${targetUri}`);
        const receiptSourceUri = targetUri;
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
            const confirmation = await requestConfirmation({
                resourceLabel: `${sourceOperation.title} · ${targetUri}`,
                sourceUri: receiptSourceUri,
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
            if (!owner.isCurrent())
                return supersededRollback(opId);
            const storage = deps.durableStoragePaths(owner.workspaceId!);
            const result = await nativeRollbackFile({
                opId,
                targetUri,
                store: owner.log,
                session: owner.session,
                confirmation,
                ...storage
            });
            const response: RollbackOperationIpcResult = {
                ok: result.ok,
                opId: result.opId,
                ...(result.inverseOpId ? { inverseOpId: result.inverseOpId } : {}),
                restoredFiles: result.restoredFiles.map((path) => {
                    return owner.receiptFiles.find((file) => file.absolutePath === path)?.sourceUri ?? '[本机路径已隐藏]';
                }),
                diagnostics: sanitizeDiagnostics(result.diagnostics)
            };
            if (result.ok && result.restoredFiles.length > 0) {
                await refreshCommittedResult(owner, `operation://${opId}`, result.restoredFiles, response);
            }
            return response;
        }
        finally {
            activeRollbackRequests.delete(rollbackKey);
        }
    };
    return Object.freeze({ list, rollback, rollbackFile });
}
export type OperationService = ReturnType<typeof createOperationService>;
