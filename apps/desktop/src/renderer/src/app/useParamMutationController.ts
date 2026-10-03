import { useEffect, useMemo, useRef } from 'react';
import { paramPhysicalRowKey } from '@soulforge/shared';
import type { RendererIndexedFile, RendererSaveResult } from '../../../main/rendererDto.js';
import type { ParamTablePanelProps } from '../editors/ParamTablePanel.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import type { ParamWorkbenchProps } from '../workbench/ParamWorkbench.js';
import type { ParamDocumentController } from './useParamDocumentController.js';
import type { OperationHistoryRefreshOutcome } from './useChangeOperationsController.js';

export type ParamMutationBridge = Pick<NonNullable<RendererRuntime['bridge']>,
  'applyContainerParamFieldMutation' | 'applyContainerParamRowNameMutation' | 'applyContainerParamRowMutations' | 'applyParamMutation'>;
export interface ParamMutationOptions extends Pick<ParamDocumentController,
  'paramLive' | 'paramSourceHash' | 'paramRowPayloads' | 'reloadParamRowsFromSource' | 'ownsParamDocument'> {
  bridge: ParamMutationBridge | null;
  selectedFile: RendererIndexedFile | null;
  paramWorkbenchFile: RendererIndexedFile | null;
  setStatus(message: string): void;
  pushToast(message: string, kind?: 'ok' | 'warn'): void;
  refreshOperationHistory(): Promise<OperationHistoryRefreshOutcome>;
  describeBridgeAbsence(operation: string): string;
}
export type ParamMutationResult = RendererSaveResult & { message?: string };
type FieldInput = Parameters<NonNullable<ParamWorkbenchProps['onApplyFieldMutation']>>[0];
type NameInput = Parameters<NonNullable<ParamWorkbenchProps['onApplyRowNameMutation']>>[0];
type RowInput = Parameters<NonNullable<ParamWorkbenchProps['onApplyRowMutation']>>[0];
type RawInput = Parameters<NonNullable<ParamTablePanelProps['onMutation']>>[0];

function unavailable(message: string): ParamMutationResult {
  return { ok: false, message, changedFiles: [], diagnostics: [] };
}
function staleSubmission(): ParamMutationResult {
  const message = 'PARAM 文档已切换，未提交旧编辑。';
  return { ok: false, message, changedFiles: [], diagnostics: [{ severity: 'error', code: 'PARAM_DOCUMENT_CHANGED', message }] };
}

/** Renderer command owner; native transactions, confirmation and readback remain in main. */
export function useParamMutationController(options: ParamMutationOptions) {
  const { bridge, selectedFile, paramWorkbenchFile, ownsParamDocument } = options;
  // The document owner supplies reset invalidation. This additional identity only
  // covers the actual command target, including a preferred, unselected container.
  const submissionOwner = useMemo(() => ({}), [bridge, selectedFile, paramWorkbenchFile]);
  const lifetimeRef = useRef({ mounted: false, submissionOwner });
  useEffect(() => {
    const lifetime = lifetimeRef.current;
    lifetime.mounted = true;
    lifetime.submissionOwner = submissionOwner;
    return () => { lifetime.mounted = false; };
  }, [submissionOwner]);
  const ownsSubmission = () => lifetimeRef.current.mounted
    && lifetimeRef.current.submissionOwner === submissionOwner && ownsParamDocument();

  function reportWarning(result: RendererSaveResult, code: string, message: string): ParamMutationResult {
    const warning = { ...result, message, diagnostics: [...result.diagnostics, { severity: 'warning' as const, code, message }] };
    // A broken renderer notification must not reject an already-committed write.
    if (ownsSubmission()) {
      try { options.setStatus(message); } catch { /* The receipt remains authoritative. */ }
      try { options.pushToast(message, 'warn'); } catch { /* The receipt retains the warning. */ }
    }
    return warning;
  }

  async function finishCommitted(result: RendererSaveResult, success: string, reload: boolean, toast: boolean): Promise<ParamMutationResult> {
    if (!ownsSubmission()) return result;
    const savedLabel = success.endsWith('。') ? success.slice(0, -1) : success;
    if (reload) {
      try {
        const outcome = await options.reloadParamRowsFromSource();
        if (!ownsSubmission()) return result;
        if (outcome?.ok === false) return reportWarning(result, 'POSTCOMMIT_PARAM_RELOAD_FAILED', `${savedLabel}，但文档重读失败。`);
      } catch {
        if (!ownsSubmission()) return result;
        return reportWarning(result, 'POSTCOMMIT_PARAM_RELOAD_FAILED', `${savedLabel}，但文档重读失败。`);
      }
    }
    if (!ownsSubmission()) return result;
    try {
      const outcome = await options.refreshOperationHistory();
      if (!ownsSubmission()) return result;
      if (outcome?.ok === false) return reportWarning(result, 'POSTCOMMIT_HISTORY_REFRESH_FAILED', `${savedLabel}，但操作历史刷新失败。`);
    }
    catch {
      if (!ownsSubmission()) return result;
      return reportWarning(result, 'POSTCOMMIT_HISTORY_REFRESH_FAILED', `${savedLabel}，但操作历史刷新失败。`);
    }
    if (!ownsSubmission()) return result;
    try {
      options.setStatus(success);
      if (toast) options.pushToast('已保存');
    } catch {
      if (!ownsSubmission()) return result;
      return reportWarning(result, 'POSTCOMMIT_PARAM_UI_FAILED', `${savedLabel}，但界面更新失败。`);
    }
    return result;
  }

  async function applyContainerParamFieldMutation(input: FieldInput): Promise<ParamMutationResult> {
    if (!ownsSubmission()) return staleSubmission();
    if (!bridge || typeof bridge.applyContainerParamFieldMutation !== 'function') return unavailable('容器 PARAM 字段写入通道不可用。');
    if (!paramWorkbenchFile) return unavailable('当前 PARAM 容器未加载，不能写入。');
    // Hash fallback and all native proof/physical identity arguments remain unchanged.
    const saved = await bridge.applyContainerParamFieldMutation(paramWorkbenchFile.sourceUri, input.expectedContainerHash || '', {
      entryIndex: input.entryIndex, expectedChildHash: input.expectedChildHash, rowIndex: input.rowIndex,
      rowId: input.rowId, expectedDataHash: input.expectedDataHash,
      ...(input.expectedRowDataSize !== undefined ? { expectedRowDataSize: input.expectedRowDataSize } : {}),
      fieldId: input.fieldId, value: input.value, rowDataBase64: input.rowDataBase64, definition: input.definition
    });
    if (saved.ok) return finishCommitted(saved, `PARAM 字段已写入：${input.paramName} 行 ${input.rowId} 的 ${input.fieldId}。`, false, false);
    const message = saved.diagnostics?.[0]?.message ?? 'PARAM 字段写入失败。';
    if (ownsSubmission()) options.setStatus(`PARAM 字段写入失败：${message}`);
    return { ...saved, message };
  }

  async function applyContainerParamRowNameMutation(input: NameInput): Promise<ParamMutationResult> {
    if (!ownsSubmission()) return staleSubmission();
    if (!bridge || typeof bridge.applyContainerParamRowNameMutation !== 'function') return unavailable('容器 PARAM 行名写入通道不可用。');
    if (!paramWorkbenchFile) return unavailable('当前 PARAM 容器未加载，不能写入。');
    const saved = await bridge.applyContainerParamRowNameMutation(paramWorkbenchFile.sourceUri, input.expectedContainerHash || '', {
      entryIndex: input.entryIndex, expectedChildHash: input.expectedChildHash, rowIndex: input.rowIndex,
      rowId: input.rowId, expectedDataHash: input.expectedDataHash,
      ...(input.expectedRowDataSize !== undefined ? { expectedRowDataSize: input.expectedRowDataSize } : {}),
      name: input.name, rowDataBase64: input.rowDataBase64
    });
    if (saved.ok) return finishCommitted(saved, `PARAM 行名已写入：${input.paramName} 行 ${input.rowId} →「${input.name}」。`, false, false);
    const message = saved.diagnostics?.[0]?.message ?? 'PARAM 行名写入失败。';
    if (ownsSubmission()) options.setStatus(`PARAM 行名写入失败：${message}`);
    return { ...saved, message };
  }

  async function applyContainerParamRowMutation(input: RowInput): Promise<ParamMutationResult> {
    if (!ownsSubmission()) return staleSubmission();
    if (!bridge || typeof bridge.applyContainerParamRowMutations !== 'function') return unavailable('容器 PARAM 行级写入通道不可用。');
    if (!paramWorkbenchFile) return unavailable('当前 PARAM 容器未加载，不能写入。');
    const saved = await bridge.applyContainerParamRowMutations(paramWorkbenchFile.sourceUri, input.expectedContainerHash || '', {
      kind: input.kind, entryIndex: input.entryIndex, expectedChildHash: input.expectedChildHash,
      rowId: input.rowId, rowDataBase64: input.rowDataBase64
    });
    const label = input.kind === 'add' ? '新建' : input.kind === 'copy' ? '复制' : '删除';
    if (saved.ok) return finishCommitted(saved, `PARAM ${label}行已保存：${input.paramName} 行 ${input.rowId}。`, false, false);
    const message = saved.diagnostics?.[0]?.message ?? 'PARAM 行级写入失败。';
    if (ownsSubmission()) options.setStatus(`PARAM ${label}行失败：${message}`);
    return { ...saved, message };
  }

  async function applyParamRowMutationFromPanel(mutation: RawInput): Promise<ParamMutationResult | undefined> {
    if (!ownsSubmission()) return staleSubmission();
    if (!options.paramLive || !selectedFile) {
      options.setStatus('当前 PARAM 未实时加载，不能写入；请先选中可解析资源。');
      return;
    }
    if (!bridge) { options.setStatus(options.describeBridgeAbsence('写入 PARAM 行')); return; }
    const deleting = mutation.kind === 'param_row_delete';
    if (deleting && !mutation.identity) { options.setStatus('缺少物理行身份，拒绝按 id 猜测删除目标。'); return; }
    const payload = mutation.dataBase64 ?? (mutation.sourceIdentity
      ? options.paramRowPayloads.get(paramPhysicalRowKey(mutation.sourceIdentity)) : undefined);
    if (!deleting && !payload) { options.setStatus('缺少 row dataBase64，无法写入（截断行）。'); return; }
    let result: RendererSaveResult;
    try {
      result = await bridge.applyParamMutation(selectedFile.sourceUri, options.paramSourceHash ?? '', deleting
        ? { kind: 'delete', id: mutation.id, rowIndex: mutation.identity!.rowIndex, expectedDataHash: mutation.identity!.dataHash }
        : { kind: 'upsert', id: mutation.id, dataBase64: payload! });
    } catch {
      // No native receipt exists. A void UI callback must not leak a rejection or
      // turn an unknown transaction into a replayable failed write.
      if (ownsSubmission()) {
        const message = 'PARAM 行写入结果未知，请查看操作历史后再处理。';
        try { options.setStatus(message); } catch { /* Notification failure does not authorize replay. */ }
        try { options.pushToast(message, 'warn'); } catch { /* Notification failure does not authorize replay. */ }
      }
      return;
    }
    if (!result.ok) {
      if (ownsSubmission()) {
        const message = result.diagnostics?.[0]?.message ?? (deleting ? 'PARAM 行删除失败。' : 'PARAM 行写入失败。');
        const failure = `${deleting ? 'PARAM 行删除失败' : 'PARAM 行写入失败'}：${message}`;
        options.setStatus(failure); options.pushToast(failure, 'warn');
      }
      return result;
    }
    const success = deleting ? `PARAM 行 ${mutation.id} 已删除并保存。`
      : mutation.sourceId !== undefined ? `PARAM 行 ${mutation.sourceId} 已复制到 ${mutation.id} 并保存。`
      : `PARAM 行 ${mutation.id} 已保存。`;
    return finishCommitted(result, success, true, true);
  }

  return { applyContainerParamFieldMutation, applyContainerParamRowNameMutation, applyContainerParamRowMutation, applyParamRowMutationFromPanel };
}
export type ParamMutationController = ReturnType<typeof useParamMutationController>;
