import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RendererIndexedFile, RendererPatchHistoryEntry, RendererSaveResult } from '../../../main/rendererDto.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import { ChangeControlStore, type CandidateChange, type ChangeDiagnostic, type ProposeInput } from '../staging/changeControl.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import type { TextDocumentController } from './useTextDocumentController.js';
import type { ParamDocumentController } from './useParamDocumentController.js';

export type OperationHistoryRefreshOutcome = void | { ok: false };

export type ChangeOperationsBridge = Pick<NonNullable<RendererRuntime['bridge']>,
  'listOperations' | 'rollbackOperation' | 'rollbackFile' | 'applyParamMutation'>;
export interface ChangeOperationsOptions extends Pick<ResourceDocumentController, 'applyTextResourceAndReload'>,
  Pick<TextDocumentController, 'applyFmgMutationAndReload'>,
  Pick<ParamDocumentController, 'reloadParamRowsFromSource' | 'applyParamFieldMutationFromPanel'> {
  bridge: ChangeOperationsBridge | null;
  workspace: { workspaceSessionId: string } | null;
  selectedFile: Pick<RendererIndexedFile, 'sourceUri'> | null;
  editDirty: boolean;
  fmgSourceHash: string | null;
  paramSourceHash: string | null;
  setStatus(message: string): void;
  pushToast(message: string, kind?: 'ok' | 'warn'): void;
  announceDesktopOnly(operation: string): void;
  describeBridgeAbsence(operation: string): string;
  /** Shell reloads the selected resource after history refresh; this owner stores no view state. */
  onRollbackCommitted(): Promise<void>;
}
export type ChangeApplyResult = Partial<Omit<RendererSaveResult, 'ok' | 'diagnostics'>> & {
  ok: boolean;
  diagnostics?: ChangeDiagnostic[];
};
const mapDiagnostics = (diagnostics?: readonly ChangeDiagnostic[]): ChangeDiagnostic[] =>
  (diagnostics ?? []).map(({ code, message }) => ({ code, message }));
const staleChange = (): ChangeApplyResult => ({ ok: false, diagnostics: [{ code: 'CHANGE_WORKSPACE_CHANGED',
  message: 'Mod 工作区已切换，未提交旧暂存变更。' }] });

/** Owns renderer staging and operation projections. Native transactions and journal facts stay in main. */
export function useChangeOperationsController(options: ChangeOperationsOptions) {
  const { bridge, selectedFile, fmgSourceHash, paramSourceHash, applyTextResourceAndReload,
    applyFmgMutationAndReload, reloadParamRowsFromSource, applyParamFieldMutationFromPanel } = options;
  const portsRef = useRef(options);
  portsRef.current = options;
  const [operationHistory, setOperationHistory] = useState<RendererPatchHistoryEntry[]>([]);
  const [rollbackInFlight, setRollbackInFlight] = useState<string | null>(null);
  const rollbackInFlightRef = useRef<string | null>(null);
  const operationHistoryRefreshRef = useRef<Promise<OperationHistoryRefreshOutcome>>(Promise.resolve());
  const operationHistoryRequestRef = useRef(0);
  const historyFailureRef = useRef<{ owner: object; request: number; message: string } | null>(null);
  const changeStore = useMemo(() => new ChangeControlStore(), []);
  const changeState = useSyncExternalStore(changeStore.subscribe, changeStore.getState);
  const changeOwnersRef = useRef(new Map<string, object>());
  const dispatchedChangeOwnersRef = useRef(new Map<string, object>());
  const [resetEpoch, setChangeResetEpoch] = useState(0);
  const workspaceOwner = useMemo(() => ({}), [bridge, options.workspace?.workspaceSessionId, resetEpoch]);
  const scopeRef = useRef(workspaceOwner);
  const lifetimeRef = useRef<{ mounted: boolean; owner: object | null }>({ mounted: false, owner: null });

  const detachUnstartedChanges = useCallback((nextOwner: object | null) => {
    for (const item of changeStore.getState().items) {
      const dispatchedOwner = dispatchedChangeOwnersRef.current.get(item.id);
      // A dispatched writer must settle into its original store. Never erase its
      // receipt or make it retryable because a renderer workspace changed.
      if (item.status === 'writing' || item.status === 'validating' || item.status === 'written'
        || (dispatchedOwner && dispatchedOwner === changeOwnersRef.current.get(item.id))) continue;
      if (nextOwner && changeOwnersRef.current.get(item.id) === nextOwner) continue;
      changeStore.discard(item.id);
      // Keep ownership while commitAll may still hold this item's snapshot.
      // A newer context must not reuse its ID before that snapshot settles.
    }
  }, [changeStore]);
  useEffect(() => {
    lifetimeRef.current = { mounted: true, owner: workspaceOwner };
    if (scopeRef.current !== workspaceOwner) {
      scopeRef.current = workspaceOwner;
      detachUnstartedChanges(workspaceOwner);
    }
    return () => {
      lifetimeRef.current.mounted = false;
      lifetimeRef.current.owner = null;
      operationHistoryRequestRef.current++;
    };
  }, [workspaceOwner, detachUnstartedChanges]);
  const ownsWorkspace = useCallback(() => lifetimeRef.current.mounted
    && lifetimeRef.current.owner === workspaceOwner, [workspaceOwner]);
  const ownsChange = useCallback((id: string) => ownsWorkspace()
    && changeOwnersRef.current.get(id) === workspaceOwner, [ownsWorkspace, workspaceOwner]);
  const resetChangeWorkspaceState = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    lifetimeRef.current.owner = null;
    operationHistoryRequestRef.current++;
    setOperationHistory([]);
    detachUnstartedChanges(null);
    setChangeResetEpoch(epoch => epoch + 1);
  }, [detachUnstartedChanges]);

  const proposeChange = useCallback((input: ProposeInput): CandidateChange | null => {
    if (!ownsWorkspace()) return null;
    const id = `${input.kind}:${input.sourceUri}:${input.target}`;
    const previousOwner = changeOwnersRef.current.get(id);
    if (previousOwner && previousOwner !== workspaceOwner
      && (changeStore.getState().committing || changeStore.getState().items.some(item => item.id === id))) return null;
    const item = changeStore.propose(input);
    changeOwnersRef.current.set(item.id, workspaceOwner);
    dispatchedChangeOwnersRef.current.delete(item.id);
    return item;
  }, [changeStore, ownsWorkspace, workspaceOwner]);
  const approveChange = useCallback((id: string) => ownsChange(id) && changeStore.approve(id), [changeStore, ownsChange]);
  const rejectChange = useCallback((id: string) => ownsChange(id) && changeStore.reject(id), [changeStore, ownsChange]);
  const undoChangeToDraft = useCallback((id: string) => ownsChange(id) && changeStore.undoToDraft(id), [changeStore, ownsChange]);
  const discardChange = useCallback((id: string) => {
    if (!ownsChange(id)) return;
    changeStore.discard(id); changeOwnersRef.current.delete(id); dispatchedChangeOwnersRef.current.delete(id);
  }, [changeStore, ownsChange]);
  const clearTerminalChanges = useCallback(() => {
    if (!ownsWorkspace()) return;
    for (const item of changeStore.getState().items) {
      if ((item.status === 'written' || item.status === 'rejected') && ownsChange(item.id)) discardChange(item.id);
    }
  }, [changeStore, ownsWorkspace, ownsChange, discardChange]);

  const refreshOperationHistory = useCallback(async (): Promise<OperationHistoryRefreshOutcome> => {
    if (!ownsWorkspace() || !bridge) return;
    const requestId = ++operationHistoryRequestRef.current;
    const isCurrent = () => ownsWorkspace() && requestId === operationHistoryRequestRef.current;
    const load = async (): Promise<OperationHistoryRefreshOutcome> => {
      if (!ownsWorkspace()) return;
      try {
        const history = await bridge.listOperations();
        if (!isCurrent()) return;
        historyFailureRef.current = null;
        setOperationHistory(history);
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : String(error);
        historyFailureRef.current = { owner: workspaceOwner, request: requestId, message };
        portsRef.current.setStatus(`历史刷新失败：${message}`);
        portsRef.current.pushToast(`历史刷新失败：${message}`, 'warn');
        return { ok: false };
      }
    };
    // Journal reads remain serialized across rollback and commit. A superseded
    // snapshot cannot overwrite a later requested projection.
    const next = operationHistoryRefreshRef.current.then(load, load);
    operationHistoryRefreshRef.current = next.catch(() => undefined);
    return await next;
  }, [bridge, ownsWorkspace, workspaceOwner]);

  const applyStagedChange = useCallback(async (change: CandidateChange): Promise<ChangeApplyResult> => {
    const changeOwner = changeOwnersRef.current.get(change.id);
    if (!ownsWorkspace() || (changeOwner && changeOwner !== workspaceOwner)) return staleChange();
    if (!bridge) return { ok: false, diagnostics: [{ code: 'BRIDGE_UNAVAILABLE',
      message: portsRef.current.describeBridgeAbsence('写入暂存变更') }] };
    changeOwnersRef.current.set(change.id, workspaceOwner);
    dispatchedChangeOwnersRef.current.set(change.id, workspaceOwner);
    switch (change.kind) {
      case 'text': {
        const result = await applyTextResourceAndReload(change.sourceUri, change.newValue);
        return { ...result, diagnostics: mapDiagnostics(result.diagnostics) };
      }
      case 'fmg': {
        const payload = change.payload as { op: 'upsert' | 'add' | 'delete'; id: number; text?: string; tableId?: string };
        const result = await applyFmgMutationAndReload(change.sourceUri, fmgSourceHash ?? '', {
          kind: payload.op, id: payload.id, ...(payload.text !== undefined ? { text: payload.text } : {})
        }, payload.tableId);
        return { ...result, diagnostics: mapDiagnostics(result.diagnostics) };
      }
      case 'param-row': {
        const payload = change.payload as { op: 'upsert' | 'delete'; id: number; dataBase64?: string };
        const result = await bridge.applyParamMutation(change.sourceUri, paramSourceHash ?? '', payload.op === 'delete'
          ? { kind: 'delete', id: payload.id }
          : { kind: 'upsert', id: payload.id, dataBase64: payload.dataBase64 ?? '' });
        // Native success is final even after disposal or a workspace/selection
        // change. Only the projection continuation belongs to this renderer.
        const canReload = () => ownsWorkspace() && selectedFile?.sourceUri === change.sourceUri
          && portsRef.current.selectedFile?.sourceUri === change.sourceUri;
        if (result.ok && canReload()) {
          try {
            const reloaded = await reloadParamRowsFromSource();
            if (reloaded?.ok === false) throw new Error('PARAM structured readback failed');
          }
          catch {
            if (canReload()) return { ...result, diagnostics: [...mapDiagnostics(result.diagnostics), {
              code: 'POSTCOMMIT_PARAM_RELOAD_FAILED', message: 'PARAM 已保存，但文档重读失败。' }] };
          }
        }
        return { ...result, diagnostics: mapDiagnostics(result.diagnostics) };
      }
      case 'param-field': {
        const input = change.payload as Parameters<ParamDocumentController['applyParamFieldMutationFromPanel']>[0];
        // The typed Param command retains native field/physical-row identity,
        // proof, readback and any already-committed warning outcome.
        const result = await applyParamFieldMutationFromPanel(input);
        return { ...result, diagnostics: mapDiagnostics(result.diagnostics) };
      }
    }
  }, [bridge, ownsWorkspace, workspaceOwner, selectedFile, fmgSourceHash, paramSourceHash, applyTextResourceAndReload,
    applyFmgMutationAndReload, reloadParamRowsFromSource, applyParamFieldMutationFromPanel]);

  const commitStagedChanges = useCallback(async (): Promise<void> => {
    if (!ownsWorkspace() || changeStore.getState().committing) return;
    portsRef.current.setStatus('正在校验并写入已暂存变更…');
    // A workspace reset detaches unstarted items. This captured applier guards
    // the store's original snapshot tail before every subsequent native call.
    const result = await changeStore.commitAll(applyStagedChange);
    if (!ownsWorkspace()) return;
    const historyRequest = operationHistoryRequestRef.current;
    await refreshOperationHistory();
    if (!ownsWorkspace()) return;
    const historyFailure = historyFailureRef.current;
    const warning = changeStore.getState().items.find(item => ownsChange(item.id) && item.status === 'written'
      && item.diagnostics.some(diagnostic => diagnostic.code.startsWith('POSTCOMMIT_')))?.diagnostics
      .find(diagnostic => diagnostic.code.startsWith('POSTCOMMIT_'))?.message;
    const refreshWarning = historyFailure?.owner === workspaceOwner && historyFailure.request > historyRequest
      ? `已写入，但操作历史刷新失败：${historyFailure.message}` : warning;
    portsRef.current.setStatus(refreshWarning ?? (result.failed === 0
      ? `写入完成：${result.written} 项已写入，原文件已备份，可回滚。`
      : `写入结束：${result.written} 项已写入，${result.failed} 项失败（原因见诊断）。`));
    portsRef.current.pushToast(refreshWarning ?? (result.failed === 0
      ? `写入完成：${result.written} 项已写入，原文件已备份，可回滚`
      : `写入结束：${result.failed} 项失败（原因见诊断）`), refreshWarning || result.failed > 0 ? 'warn' : 'ok');
  }, [changeStore, ownsWorkspace, ownsChange, workspaceOwner, applyStagedChange, refreshOperationHistory]);

  const rollback = useCallback(async (opId: string, targetUri?: string): Promise<void> => {
    if (!ownsWorkspace()) return;
    const fileRollback = targetUri !== undefined;
    const lockKey = fileRollback ? `file:${opId}:${targetUri}` : `operation:${opId}`;
    if (rollbackInFlightRef.current !== null) {
      portsRef.current.pushToast('已有回滚正在处理中，请等待当前操作完成。', 'warn'); return;
    }
    rollbackInFlightRef.current = lockKey; setRollbackInFlight(lockKey);
    let restored = false;
    try {
      if (!bridge) { portsRef.current.announceDesktopOnly(fileRollback ? '文件回滚' : '回滚操作'); return; }
      if (fileRollback && typeof bridge.rollbackFile !== 'function') {
        portsRef.current.pushToast('当前预加载未暴露文件级回滚。', 'warn'); return;
      }
      if (!fileRollback) portsRef.current.setStatus(`正在回滚操作 ${opId.slice(0, 8)}...`);
      const result = fileRollback ? await bridge.rollbackFile(opId, targetUri) : await bridge.rollbackOperation(opId);
      // The dispatched native restore has settled. A changed UI context only
      // suppresses projection work; it never retries or cancels that restore.
      restored = result.ok;
      if (!ownsWorkspace()) return;
      if (!result.ok) {
        const message = result.diagnostics.map(diagnostic => diagnostic.message).join('; ') || (fileRollback ? targetUri : opId);
        if (!fileRollback) portsRef.current.setStatus(`回滚失败：${message}`);
        portsRef.current.pushToast(`${fileRollback ? '文件回滚失败' : '回滚失败'}：${message}`, 'warn');
        await refreshOperationHistory(); return;
      }
      await refreshOperationHistory();
      if (!ownsWorkspace()) return;
      await portsRef.current.onRollbackCommitted();
      if (!ownsWorkspace()) return;
      if (fileRollback) portsRef.current.pushToast(`已回滚文件（${result.restoredFiles.length} 个）`);
      else {
        portsRef.current.setStatus(`已回滚 ${result.restoredFiles.length} 个文件`);
        portsRef.current.pushToast(`已回滚 ${result.restoredFiles.length} 个文件`);
      }
    } catch (error) {
      if (!ownsWorkspace()) return;
      const message = error instanceof Error ? error.message : String(error);
      const prefix = restored ? (fileRollback ? '文件已回滚，但资源界面重载失败' : '回滚已完成，但资源界面重载失败')
        : (fileRollback ? '文件回滚异常' : '回滚异常');
      portsRef.current.setStatus(`${prefix}：${message}`); portsRef.current.pushToast(`${prefix}：${message}`, 'warn');
    } finally {
      rollbackInFlightRef.current = null;
      // The lock is shared by the controller lifetime, including a workspace
      // switch while the native restore is still awaiting its receipt.
      if (lifetimeRef.current.mounted) setRollbackInFlight(null);
    }
  }, [bridge, ownsWorkspace, refreshOperationHistory]);
  const rollbackOp = useCallback((opId: string) => rollback(opId), [rollback]);
  const rollbackFileOp = useCallback((opId: string, targetUri: string) => rollback(opId, targetUri), [rollback]);

  const pendingChangeCount = changeState.items.filter(item => changeOwnersRef.current.get(item.id) === workspaceOwner
    && (item.status === 'draft' || item.status === 'staged' || item.status === 'failed')).length;
  const hasUncommittedChanges = options.editDirty || changeState.items.some(item => changeOwnersRef.current.get(item.id) === workspaceOwner
    && (item.status === 'draft' || item.status === 'staged'));
  const draftChanges = changeState.items.filter(item => changeOwnersRef.current.get(item.id) === workspaceOwner && item.status === 'draft');
  const lastOperation = operationHistory.length > 0 ? operationHistory[0] : null;
  return { operationHistory, rollbackInFlight, changeState, pendingChangeCount, hasUncommittedChanges, draftChanges, lastOperation,
    proposeChange, approveChange, rejectChange, undoChangeToDraft, discardChange, clearTerminalChanges,
    resetChangeWorkspaceState, refreshOperationHistory, applyStagedChange, commitStagedChanges, rollbackOp, rollbackFileOp };
}
export type ChangeOperationsController = ReturnType<typeof useChangeOperationsController>;
