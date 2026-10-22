import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RendererIndexedFile, RendererSaveResult } from '../../../main/rendererDto.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import { shouldLoadFmg } from '../workbench/documentLoadGates.js';

export type TextDocumentBridge = Pick<NonNullable<RendererRuntime['bridge']>, 'readFmgDocument' | 'applyFmgMutation'>;
export interface TextDocumentOptions {
  bridge: TextDocumentBridge | null;
  selectedFile: Pick<RendererIndexedFile,
    'sourceUri' | 'relativePath' | 'resourceKind' | 'formatKind' | 'compoundExtension'> | null;
  setStatus(message: string): void;
  pushToast(message: string, kind?: 'ok' | 'warn'): void;
}
export interface TextPanelMutation {
  kind: 'fmg_entry_upsert' | 'fmg_entry_delete' | 'fmg_entry_add';
  id: number;
  text?: string;
  tableId?: string;
}
export interface TextDocumentReadResult {
  ok?: boolean;
  data?: {
    sourceHash?: string;
    entries?: Array<{ id: number; text: string }>;
    entryCount?: number;
    authority?: string;
  } | null;
}
const EMPTY_FMG_ENTRIES: Array<{ id: number; text: string }> = [];

function readLevelLabel(authority: string): string {
  switch (authority) {
    case 'partial': return '读取不完整';
    case 'candidate': return '候选读取';
    case 'fixture-confirmed': return '样本已确认';
    case 'native-verified': return '原生读取已验证';
    case 'unverified': return '尚未验证';
    default: return authority;
  }
}

/** Owns FMG renderer projections and commands; parsing, transactions and authority remain in main. */
export function useTextDocumentController(options: TextDocumentOptions) {
  const { bridge, selectedFile, setStatus, pushToast } = options;
  const [fmgEntries, setFmgEntriesState] = useState(EMPTY_FMG_ENTRIES);
  const [fmgSourceHash, setFmgSourceHashState] = useState<string | null>(null);
  const [fmgLive, setFmgLive] = useState(false);
  const [resetEpoch, setFmgResetEpoch] = useState(0);
  const documentOwner = useMemo(() => ({}), [bridge, selectedFile, resetEpoch]);
  const lifetimeRef = useRef<{ mounted: boolean; owner: object | null }>({ mounted: false, owner: null });
  const readRequestRef = useRef(0);

  useEffect(() => {
    lifetimeRef.current = { mounted: true, owner: documentOwner };
    return () => { lifetimeRef.current.mounted = false; lifetimeRef.current.owner = null; };
  }, [documentOwner]);

  const ownsDocument = useCallback(() => lifetimeRef.current.mounted
    && lifetimeRef.current.owner === documentOwner, [documentOwner]);
  const clearProjection = useCallback(() => {
    setFmgEntriesState(EMPTY_FMG_ENTRIES);
    setFmgSourceHashState(null);
    setFmgLive(false);
  }, []);
  const resetTextDocument = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    // Registry reset can precede the selection rerender: invalidate outstanding reads and setters now.
    readRequestRef.current++;
    lifetimeRef.current.owner = null;
    setFmgResetEpoch(epoch => epoch + 1);
    clearProjection();
  }, [clearProjection]);

  /** Captured postcommit callbacks cannot publish an older resource into a newer document lifetime. */
  const setFmgEntries = useCallback((entries: Array<{ id: number; text: string }>) => {
    if (ownsDocument()) setFmgEntriesState(entries);
  }, [ownsDocument]);
  const setFmgSourceHash = useCallback((sourceHash: string | null) => {
    if (ownsDocument()) setFmgSourceHashState(sourceHash);
  }, [ownsDocument]);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++readRequestRef.current;
    const isCurrent = () => !cancelled && readRequestRef.current === requestId && ownsDocument();
    clearProjection();
    async function loadFmg(): Promise<void> {
      // Only an explicitly selected text resource opens; no semantic-domain fallback list.
      const target = selectedFile;
      if (!target || !shouldLoadFmg(target) || !bridge || typeof bridge.readFmgDocument !== 'function') {
        clearProjection();
        return;
      }
      setStatus(`正在读取 FMG：${target.relativePath}`);
      try {
        const result = await bridge.readFmgDocument(target.sourceUri) as TextDocumentReadResult;
        if (!isCurrent()) return;
        // A lawful zero-entry table is live when native supplies a source hash; entries alone prove nothing.
        if (!result?.ok || !result.data?.sourceHash) {
          clearProjection();
          setStatus('这个文本资源读不出来。');
          return;
        }
        const loadedEntries = (result.data.entries ?? []).map(entry => ({ id: entry.id, text: entry.text }));
        setFmgEntriesState(loadedEntries);
        setFmgSourceHashState(result.data.sourceHash);
        setFmgLive(true);
        setStatus(`已加载 FMG：${result.data.entryCount ?? loadedEntries.length} 条`
          + (result.data.authority ? ` · 读取级别：${readLevelLabel(result.data.authority)}` : ''));
      } catch (error) {
        if (!isCurrent()) return;
        clearProjection();
        setStatus(error instanceof Error ? error.message : 'FMG 读取异常');
      }
    }
    void loadFmg();
    return () => { cancelled = true; };
    // Feedback callbacks and explicit reset do not reopen a native document.
  }, [bridge, selectedFile]);

  /** Read-only publication after a native commit. This helper never submits or replays a write. */
  const reloadFmgDocument = useCallback(async (sourceUri: string): Promise<TextDocumentReadResult | null> => {
    if (!ownsDocument() || !bridge || typeof bridge.readFmgDocument !== 'function'
      || !selectedFile || !shouldLoadFmg(selectedFile) || selectedFile.sourceUri !== sourceUri) return null;
    const requestId = ++readRequestRef.current;
    const isCurrent = () => readRequestRef.current === requestId && ownsDocument();
    try {
      const result = await bridge.readFmgDocument(sourceUri) as TextDocumentReadResult;
      if (!isCurrent()) return null;
      if (result?.ok && result.data?.sourceHash) {
        setFmgEntriesState((result.data.entries ?? []).map(entry => ({ id: entry.id, text: entry.text })));
        setFmgSourceHashState(result.data.sourceHash);
        setFmgLive(true);
      }
      return result;
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    }
  }, [bridge, selectedFile, ownsDocument]);
  async function readbackAfterCommit(result: RendererSaveResult, sourceUri: string): Promise<RendererSaveResult> {
    if (!result.ok || !ownsDocument()) return result;
    try {
      await reloadFmgDocument(sourceUri);
      return result;
    } catch {
      if (!ownsDocument()) return result;
      const message = '文本已保存，但条目重读失败。';
      setStatus(message);
      pushToast(message, 'warn');
      return { ...result, diagnostics: [...(result.diagnostics ?? []), { severity: 'warning', code: 'POSTCOMMIT_FMG_RELOAD_FAILED', message }] };
    }
  }
  async function applyFmgMutationAndReload(...args: Parameters<TextDocumentBridge['applyFmgMutation']>): Promise<RendererSaveResult> {
    if (!ownsDocument()) {
      return { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'FMG_DOCUMENT_CHANGED', message: '文本工作台已切换，未提交旧请求。' }] };
    }
    if (!bridge || typeof bridge.applyFmgMutation !== 'function') {
      return { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'FMG_WRITE_UNAVAILABLE', message: 'FMG 写入通道不可用。' }] };
    }
    const result = await bridge.applyFmgMutation(...args);
    return readbackAfterCommit(result, args[0]);
  }
  async function submitFmgEntry(mutation: TextPanelMutation): Promise<void> {
    if (!ownsDocument()) return;
    const warn = (message: string) => {
      setStatus(message);
      pushToast(message, 'warn');
    };
    if (!fmgLive || !selectedFile) {
      warn('当前 FMG 未实时加载，不能写入；请先选中可解析资源。');
      return;
    }
    if (!bridge || typeof bridge.applyFmgMutation !== 'function') {
      warn('FMG 写入通道不可用。');
      return;
    }
    // Main retains the original hash concurrency check and container table routing.
    const kind = mutation.kind === 'fmg_entry_delete' ? 'delete' : mutation.kind === 'fmg_entry_add' ? 'add' : 'upsert';
    let result: RendererSaveResult;
    try {
      result = await bridge.applyFmgMutation(selectedFile.sourceUri, fmgSourceHash ?? '', {
        kind, id: mutation.id, ...(mutation.text !== undefined ? { text: mutation.text } : {})
      }, mutation.tableId);
    } catch (error) {
      if (!ownsDocument()) return;
      warn(`FMG 写入异常：${error instanceof Error ? error.message : '写入通道返回未知异常。'}`);
      return;
    }
    if (!ownsDocument()) return;
    if (result.ok) {
      setStatus(mutation.kind === 'fmg_entry_delete' ? '条目已删除。' : '已保存。');
      pushToast(mutation.kind === 'fmg_entry_delete' ? '条目已删除' : '已保存');
      await readbackAfterCommit(result, selectedFile.sourceUri);
    } else {
      const diagnostic = result.diagnostics?.[0];
      const code = diagnostic?.code ? `[${diagnostic.code}] ` : '';
      warn(`FMG 写入失败：${code}${diagnostic?.message ?? 'FMG 写入失败。'}`);
    }
  }
  return { fmgEntries, fmgSourceHash, fmgLive, setFmgEntries, setFmgSourceHash,
    resetTextDocument, reloadFmgDocument, applyFmgMutationAndReload, submitFmgEntry };
}
export type TextDocumentController = ReturnType<typeof useTextDocumentController>;
