import type { OperationHistoryRefreshOutcome } from './useChangeOperationsController.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Diagnostic } from '@soulforge/shared';
import type { RendererIndexedFile, RendererResourcePreview, RendererSaveResult } from '../../../main/rendererDto.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import { extractMsgRows, nextMsgId, serializeMsgRowsToTsv, type EditableMsgRow } from '../format/msgRows.js';
import { planResourceOpen } from '../workbench/documentLoadGates.js';

export type ResourceDocumentBridge = Pick<NonNullable<RendererRuntime['bridge']>,
  'openResourcePreview' | 'saveTextResource' | 'readTaeDocument' | 'readEsdDocument'
  | 'readFlverDocument' | 'applyFlverMutation'>;
export interface ResourceDocumentOptions {
  bridge: ResourceDocumentBridge | null;
  setStatus(message: string): void;
  pushToast(message: string, kind?: 'ok' | 'warn'): void;
  refreshOperationHistory(): Promise<OperationHistoryRefreshOutcome>;
  describeBridgeAbsence(operation: string): string;
  /** Synchronous shell coordination, including the existing document reset registry. */
  onSelectionActivated(): void;
}
export interface ResourceNativeReadResult {
  ok?: boolean;
  data?: Record<string, unknown>;
  diagnostics?: Diagnostic[];
}
export interface FlverMaterialSlotInput { meshStableId: string; materialStableId: string }

function staleSubmission(): RendererSaveResult {
  return { ok: false, changedFiles: [], diagnostics: [{ severity: 'error',
    code: 'RESOURCE_DOCUMENT_STALE', message: '资源文档已切换，请重新提交。' }] };
}
function postcommitWarning(result: RendererSaveResult, code: string, message: string): RendererSaveResult {
  return { ...result, diagnostics: [...result.diagnostics, { severity: 'warning', code, message }] };
}

/** Owns resource selection and bounded renderer projections. Native writes and receipts stay in main. */
export function useResourceDocumentController(options: ResourceDocumentOptions) {
  const { bridge } = options;
  const portsRef = useRef(options);
  portsRef.current = options;
  const [selectedFile, setSelectedFile] = useState<RendererIndexedFile | null>(null);
  const [preview, setPreview] = useState<RendererResourcePreview | null>(null);
  const [editText, setEditTextState] = useState('');
  const [lastSavedText, setLastSavedText] = useState('');
  const [msgRows, setMsgRows] = useState<EditableMsgRow[]>([]);
  const [saveDiagnostics, setSaveDiagnostics] = useState<string[]>([]);
  const [openTabs, setOpenTabs] = useState<RendererIndexedFile[]>([]);
  const [taeData, setTaeData] = useState<Record<string, unknown> | null>(null);
  const [esdData, setEsdData] = useState<Record<string, unknown> | null>(null);
  const [flverData, setFlverData] = useState<Record<string, unknown> | null>(null);
  const [, setResourceOwnerEpoch] = useState(0);
  const selectedRef = useRef<RendererIndexedFile | null>(null);
  const tabsRef = useRef<RendererIndexedFile[]>([]);
  const generationRef = useRef(0);
  const previewRequestRef = useRef(0);
  const draftRevisionRef = useRef(0);
  const flverRequestRef = useRef(0);
  const lifetimeRef = useRef<{ mounted: boolean; bridge: ResourceDocumentBridge | null }>({ mounted: false, bridge });

  const invalidate = useCallback(() => {
    generationRef.current++;
    previewRequestRef.current++;
    flverRequestRef.current++;
    setResourceOwnerEpoch(epoch => epoch + 1);
  }, []);
  const clearPlainDocument = useCallback(() => {
    setPreview(null); setEditTextState(''); setLastSavedText(''); setMsgRows([]); setSaveDiagnostics([]);
  }, []);
  const clearNativeDocuments = useCallback(() => { setTaeData(null); setEsdData(null); setFlverData(null); }, []);
  useEffect(() => {
    lifetimeRef.current = { mounted: true, bridge };
    clearPlainDocument(); clearNativeDocuments();
    return () => {
      lifetimeRef.current.mounted = false;
      generationRef.current++;
      previewRequestRef.current++;
      flverRequestRef.current++;
    };
  }, [bridge, clearPlainDocument, clearNativeDocuments]);

  const ownsBridge = useCallback(() => lifetimeRef.current.mounted
    && lifetimeRef.current.bridge === bridge, [bridge]);
  const renderGeneration = generationRef.current;
  const ownsDocument = useCallback(() => ownsBridge() && generationRef.current === renderGeneration,
    [ownsBridge, renderGeneration]);

  // Stable callbacks are retained by the existing reset registry. Invalidation is synchronous.
  const resetTaeDocument = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    invalidate(); setTaeData(null);
  }, [invalidate]);
  const resetEsdDocument = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    invalidate(); setEsdData(null);
  }, [invalidate]);
  const resetFlverDocument = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    invalidate(); setFlverData(null);
  }, [invalidate]);
  const resetWorkspaceDocuments = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    invalidate(); selectedRef.current = null; tabsRef.current = [];
    setSelectedFile(null); setOpenTabs([]); clearPlainDocument(); clearNativeDocuments();
  }, [invalidate, clearPlainDocument, clearNativeDocuments]);
  const clearResourceSelection = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    invalidate(); selectedRef.current = null; setSelectedFile(null); setPreview(null);
  }, [invalidate]);
  const clearResourcePreview = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    invalidate(); setPreview(null);
  }, [invalidate]);

  const activateSelection = useCallback((file: RendererIndexedFile, addTab: boolean) => {
    invalidate(); selectedRef.current = file; setSelectedFile(file);
    if (addTab && !tabsRef.current.some(tab => tab.sourceUri === file.sourceUri)) {
      tabsRef.current = [...tabsRef.current, file]; setOpenTabs(tabsRef.current);
    }
    clearPlainDocument();
    // This can call all three stable resets and advance the owner generation again.
    portsRef.current.onSelectionActivated();
    return generationRef.current;
  }, [invalidate, clearPlainDocument]);

  const selectFile = useCallback(async (file: RendererIndexedFile): Promise<void> => {
    if (!ownsBridge()) return;
    const generation = activateSelection(file, true);
    const request = ++previewRequestRef.current;
    const isCurrent = () => ownsBridge() && generationRef.current === generation
      && previewRequestRef.current === request && selectedRef.current === file;
    if (!bridge) {
      portsRef.current.setStatus(portsRef.current.describeBridgeAbsence(`打开 ${file.relativePath}`));
      return;
    }
    portsRef.current.setStatus(`正在打开 ${file.relativePath}...`);
    try {
      const nextPreview = await bridge.openResourcePreview(file.sourceUri);
      if (!isCurrent()) return;
      setPreview(nextPreview);
      const text = nextPreview?.text ?? '';
      setEditTextState(text); setLastSavedText(text); setMsgRows(extractMsgRows(nextPreview));
      const openPlan = planResourceOpen(file);
      if (openPlan.ipcMethods.includes('readTaeDocument') && typeof bridge.readTaeDocument === 'function') {
        try {
          const result = await bridge.readTaeDocument(file.sourceUri) as ResourceNativeReadResult;
          if (!isCurrent()) return;
          setTaeData(result.ok && result.data ? result.data : {
            format: 'TAE_READ_FAILED', diagnostics: result.diagnostics?.length ? result.diagnostics : [
              { severity: 'error', code: 'TAE_READ_FAILED', message: '原生动作文档读取失败。' }
            ]
          });
        } catch (error) {
          if (!isCurrent()) return;
          setTaeData({ format: 'TAE_READ_FAILED', diagnostics: [{ severity: 'error', code: 'TAE_READ_FAILED',
            message: error instanceof Error ? error.message : String(error) }] });
        }
      }
      if (openPlan.ipcMethods.includes('readEsdDocument') && typeof bridge.readEsdDocument === 'function') {
        const result = await bridge.readEsdDocument(file.sourceUri) as ResourceNativeReadResult;
        if (!isCurrent()) return;
        if (result.ok && result.data) setEsdData(result.data);
      }
      if (openPlan.ipcMethods.includes('readFlverDocument') && typeof bridge.readFlverDocument === 'function') {
        const result = await bridge.readFlverDocument(file.sourceUri) as ResourceNativeReadResult;
        if (!isCurrent()) return;
        if (result.ok && result.data) setFlverData(result.data);
      }
      if (isCurrent()) portsRef.current.setStatus(nextPreview ? `已打开 ${file.relativePath}` : '无法预览该资源');
    } catch (error) {
      if (!isCurrent()) return;
      throw error;
    }
  }, [bridge, ownsBridge, activateSelection]);
  const switchToOpenTab = useCallback((file: RendererIndexedFile): void => {
    if (!ownsBridge() || !tabsRef.current.some(tab => tab.sourceUri === file.sourceUri)) return;
    activateSelection(file, false);
  }, [ownsBridge, activateSelection]);
  const closeTab = useCallback((file: RendererIndexedFile): void => {
    if (!ownsBridge()) return;
    const next = tabsRef.current.filter(tab => tab.sourceUri !== file.sourceUri);
    tabsRef.current = next; setOpenTabs(next);
    if (selectedRef.current?.sourceUri !== file.sourceUri) return;
    const fallback = next.at(-1);
    if (fallback) void selectFile(fallback);
    else clearResourceSelection();
  }, [ownsBridge, selectFile, clearResourceSelection]);

  const setEditText = useCallback((text: string): void => {
    if (ownsDocument()) { draftRevisionRef.current++; setEditTextState(text); }
  }, [ownsDocument]);
  const updateMsgRow = useCallback((index: number, patch: Partial<EditableMsgRow>): void => {
    if (!ownsDocument()) return;
    draftRevisionRef.current++;
    const rows = msgRows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row);
    setMsgRows(rows); setEditTextState(serializeMsgRowsToTsv(rows));
  }, [ownsDocument, msgRows]);
  const addMsgRow = useCallback((): void => {
    if (!ownsDocument()) return;
    draftRevisionRef.current++;
    const rows = [...msgRows, { textId: nextMsgId(msgRows), text: '', ...(msgRows[0]?.category ? { category: msgRows[0].category } : {}) }];
    setMsgRows(rows); setEditTextState(serializeMsgRowsToTsv(rows));
  }, [ownsDocument, msgRows]);
  const removeMsgRow = useCallback((index: number): void => {
    if (!ownsDocument()) return;
    draftRevisionRef.current++;
    const rows = msgRows.filter((_row, rowIndex) => rowIndex !== index);
    setMsgRows(rows); setEditTextState(serializeMsgRowsToTsv(rows));
  }, [ownsDocument, msgRows]);

  const applyTextResourceAndReload = useCallback(async (sourceUri: string, newText: string): Promise<RendererSaveResult> => {
    if (!ownsDocument()) return staleSubmission();
    if (!bridge) return { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'BRIDGE_UNAVAILABLE',
      message: portsRef.current.describeBridgeAbsence('写入文本变更') }] };
    const savedDraftRevision = draftRevisionRef.current;
    const result = await bridge.saveTextResource(sourceUri, newText);
    if (!result.ok || !ownsDocument() || selectedRef.current?.sourceUri !== sourceUri) return result;
    const request = ++previewRequestRef.current;
    const isCurrent = () => ownsDocument() && previewRequestRef.current === request
      && selectedRef.current?.sourceUri === sourceUri;
    try {
      const refreshed = await bridge.openResourcePreview(sourceUri);
      if (!isCurrent()) return result;
      setPreview(refreshed);
      const text = refreshed?.text ?? newText;
      setLastSavedText(text);
      // A committed baseline can advance while the same document has a newer
      // unsaved draft. The delayed readback must not replace that user edit.
      if (draftRevisionRef.current === savedDraftRevision) {
        setEditTextState(text); setMsgRows(extractMsgRows(refreshed));
      }
      return result;
    } catch {
      return isCurrent() ? postcommitWarning(result, 'POSTCOMMIT_TEXT_PREVIEW_FAILED', '文本已保存，但预览重读失败。') : result;
    }
  }, [bridge, ownsDocument]);

  const saveCurrentText = useCallback(async (): Promise<RendererSaveResult | null> => {
    if (!ownsDocument() || !selectedFile || !preview) return null;
    if (!bridge) {
      portsRef.current.setStatus(portsRef.current.describeBridgeAbsence(`保存 ${selectedFile.relativePath}`));
      return null;
    }
    let result = await applyTextResourceAndReload(selectedFile.sourceUri, editText);
    if (!ownsDocument()) return result;
    if (!result.ok) {
      const message = result.diagnostics?.[0]?.message ?? '文本写入失败。';
      portsRef.current.setStatus(`保存失败：${message}`); portsRef.current.pushToast(`保存失败：${message}`, 'warn');
      return result;
    }
    try {
      const history = await portsRef.current.refreshOperationHistory();
      if (history?.ok === false) throw new Error('History refresh failed');
    }
    catch {
      if (ownsDocument()) result = postcommitWarning(result, 'POSTCOMMIT_TEXT_HISTORY_FAILED', '文本已保存，但操作历史刷新失败。');
    }
    if (!ownsDocument()) return result;
    const warning = result.diagnostics.find(diagnostic => diagnostic.code === 'POSTCOMMIT_TEXT_PREVIEW_FAILED'
      || diagnostic.code === 'POSTCOMMIT_TEXT_HISTORY_FAILED');
    portsRef.current.setStatus(warning?.message ?? '已保存。');
    portsRef.current.pushToast(warning?.message ?? '已保存', warning ? 'warn' : undefined);
    return result;
  }, [bridge, ownsDocument, selectedFile, preview, editText, applyTextResourceAndReload]);

  const applyFlverMaterialSlotSetAndReload = useCallback(async (input: FlverMaterialSlotInput): Promise<RendererSaveResult | null> => {
    if (!ownsDocument()) return null;
    if (!selectedFile || !flverData) { portsRef.current.setStatus('尚未打开可写的 FLVER 文档。'); return null; }
    if (!bridge) { portsRef.current.setStatus(portsRef.current.describeBridgeAbsence('提交 FLVER 材质槽')); return null; }
    if (typeof bridge.applyFlverMutation !== 'function') { portsRef.current.setStatus('当前预加载未暴露 applyFlverMutation。'); return null; }
    const sourceHash = flverData.sourceHash;
    portsRef.current.setStatus(`正在提交 FLVER 材质槽 ${input.meshStableId}…`);
    let result = await bridge.applyFlverMutation(selectedFile.sourceUri, typeof sourceHash === 'string' ? sourceHash : '',
      { kind: 'material-slot-set', meshStableId: input.meshStableId, slotIndex: 0, materialStableId: input.materialStableId });
    if (!ownsDocument()) return result;
    if (!result.ok) { portsRef.current.setStatus(result.diagnostics?.[0]?.message ?? 'FLVER 材质槽提交失败'); return result; }
    const request = ++flverRequestRef.current;
    const isCurrent = () => ownsDocument() && flverRequestRef.current === request;
    try {
      const reload = await bridge.readFlverDocument(selectedFile.sourceUri) as ResourceNativeReadResult;
      if (!isCurrent()) return result;
      if (reload.ok && reload.data) setFlverData(reload.data);
    } catch {
      if (!isCurrent()) return result;
      result = postcommitWarning(result, 'POSTCOMMIT_FLVER_RELOAD_FAILED', 'FLVER 已保存，但文档重读失败。');
    }
    try {
      const history = await portsRef.current.refreshOperationHistory();
      if (history?.ok === false) throw new Error('History refresh failed');
    }
    catch {
      if (isCurrent()) result = postcommitWarning(result, 'POSTCOMMIT_FLVER_HISTORY_FAILED', 'FLVER 已保存，但操作历史刷新失败。');
    }
    if (!isCurrent()) return result;
    const warning = result.diagnostics.find(diagnostic => diagnostic.code === 'POSTCOMMIT_FLVER_RELOAD_FAILED'
      || diagnostic.code === 'POSTCOMMIT_FLVER_HISTORY_FAILED');
    portsRef.current.setStatus(warning?.message ?? '已保存。');
    portsRef.current.pushToast(warning?.message ?? '已保存', warning ? 'warn' : undefined);
    return result;
  }, [bridge, ownsDocument, selectedFile, flverData]);

  const canEditText = preview?.previewKind === 'text' && preview.structuredPreview?.editable === true && !preview.truncated;
  return { selectedFile, preview, editText, lastSavedText, msgRows, saveDiagnostics, openTabs, taeData, esdData, flverData,
    canEditText, hasMsgTable: canEditText && msgRows.length > 0, editDirty: editText !== lastSavedText,
    selectFile, switchToOpenTab, closeTab, clearResourceSelection, clearResourcePreview, resetWorkspaceDocuments,
    resetTaeDocument, resetEsdDocument, resetFlverDocument, setEditText, updateMsgRow, addMsgRow, removeMsgRow,
    saveCurrentText, applyTextResourceAndReload, applyFlverMaterialSlotSetAndReload };
}
export type ResourceDocumentController = ReturnType<typeof useResourceDocumentController>;
