import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmevdEditorDocument } from '@soulforge/shared';
import type { EventSourceSubmitResult, EventSourceTabData } from '../editors/EventSourceWorkbenchPanel.js';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import { shouldLoadEmevd } from '../workbench/documentLoadGates.js';
import { emevdPendingTabFromFullDocument } from '../emevd/emevdPendingTab.js';
import { assembleEmevdSource } from '../emevd/assembleEmevdSource.js';

export type EventDocumentBridge = Pick<NonNullable<RendererRuntime['bridge']>,
  'readEmevdFullDocument' | 'cancelEmevdFullDocument' | 'readEmevdSourceSlice' | 'submitEmevdDslPlan'>;
export interface EventDocumentOpenFailure {
  kind: 'event-open-failed';
  document: string;
  code: string;
  message: string;
}
export interface EventDocumentOptions {
  bridge: EventDocumentBridge | null;
  selectedFile: Pick<RendererIndexedFile,
    'sourceUri' | 'relativePath' | 'resourceKind' | 'formatKind' | 'compoundExtension'> | null;
  setStatus(message: string): void;
  onEventOpenFailure(failure: EventDocumentOpenFailure | null): void;
  describeBridgeAbsence(operation: string): string;
}
export type EventDocumentReloadTarget = Pick<EventSourceTabData,
  'tabId' | 'title' | 'resourceUri' | 'sourceStyle'>;

const EMPTY_EMEVD_DOCUMENT: EmevdEditorDocument = {
  schemaVersion: 1,
  resourceUri: '',
  revision: 0,
  bytesBase64: '',
  events: [],
  diagnostics: []
};

function eventTabShortTitle(relativePath: string): string {
  const base = relativePath.split(/[\\/]/).pop() ?? relativePath;
  return base.replace(/\.emevd(\.dcx)?$/i, '').replace(/\.dcx$/i, '');
}

function readLevelLabel(authority: string | null | undefined): string {
  switch (authority) {
    case 'partial': return '读取不完整';
    case 'candidate': return '候选读取';
    case 'fixture-confirmed': return '样本已确认';
    case 'native-verified': return '原生读取已验证';
    case 'unverified': return '尚未验证';
    default: return authority ?? '未报告';
  }
}

/** Native parsing/source authority stays in main; this owner holds renderer projections and their lifetimes. */
export function useEventDocumentController(options: EventDocumentOptions) {
  const { bridge, selectedFile, setStatus, onEventOpenFailure, describeBridgeAbsence } = options;
  const [eventPendingTab, setEventPendingTab] = useState<EventSourceTabData | null>(null);
  const [eventOpening, setEventOpening] = useState(false);
  const [eventSourcePreview, setEventSourcePreview] = useState<string | null>(null);
  const [resetEpoch, setEventResetEpoch] = useState(0);
  const eventOpenRequestRef = useRef(0);
  const eventMountedRef = useRef(false);
  const commandOwner = useMemo(() => ({}), [bridge, resetEpoch]);
  const commandOwnerRef = useRef<object | null>(commandOwner);
  useEffect(() => {
    commandOwnerRef.current = commandOwner;
    return () => { commandOwnerRef.current = null; };
  }, [commandOwner]);

  const resetEventDocument = useCallback(() => {
    // Reset can precede a selectedFile update; invalidate an awaited old open immediately.
    eventOpenRequestRef.current++;
    commandOwnerRef.current = null;
    setEventResetEpoch(epoch => epoch + 1);
    setEventPendingTab(null);
    setEventOpening(false);
    setEventSourcePreview(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    eventMountedRef.current = true;
    const requestId = eventOpenRequestRef.current + 1;
    eventOpenRequestRef.current = requestId;
    const isCurrent = () => !cancelled && eventOpenRequestRef.current === requestId;
    async function loadEmevd(): Promise<void> {
      // Only the explicitly selected event resource loads; there is no semantic-domain fallback.
      const target = selectedFile;
      if (!target || !shouldLoadEmevd(target)) {
        setEventPendingTab(null);
        setEventSourcePreview(null);
        setEventOpening(false);
        onEventOpenFailure(null);
        return;
      }
      if (!bridge || typeof bridge.readEmevdFullDocument !== 'function') {
        setEventPendingTab(null);
        setEventSourcePreview(null);
        setEventOpening(false);
        return;
      }
      setEventOpening(true);
      setEventSourcePreview(null);
      setStatus(`正在读取 EMEVD：${target.relativePath}`);
      try {
        // A single native full-document read supplies scalar/outline authority and bounded source.
        const full = await bridge.readEmevdFullDocument(
          target.sourceUri,
          `renderer-${target.sourceUri}-${Date.now()}`
        );
        if (!isCurrent()) return;
        // Native cancellation is not a read failure and must never trigger a retry or failure tab.
        if (full?.cancelled) return;
        if (!full?.ok) {
          const failureDiag = full?.diagnostics?.[0];
          const failureCode = failureDiag?.code ?? 'EMEVD_LIVE_READ_FAILED';
          const failureMessage = failureDiag?.message
            ?? (failureCode === 'EMEVD_DOCUMENT_KRAK_OODLE_UNAVAILABLE'
              ? '这份事件是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。'
              : '这个事件脚本读不出来。');
          onEventOpenFailure({
            kind: 'event-open-failed',
            document: target.relativePath,
            code: failureCode,
            message: failureMessage
          });
          setEventPendingTab({
            tabId: target.sourceUri,
            title: eventTabShortTitle(target.relativePath),
            resourceUri: target.sourceUri,
            document: {
              ...EMPTY_EMEVD_DOCUMENT,
              resourceUri: target.sourceUri,
              diagnostics: [{ severity: 'error', code: failureCode, message: failureMessage }]
            },
            sourceHash: null,
            live: false,
            dslTemplate: null,
            dslTemplateTruncated: false,
            dslTemplateTotalLines: 0,
            sourceStyle: 'none'
          });
          setStatus('这个事件脚本读不出来。');
          return;
        }
        onEventOpenFailure(null);
        if (full.sourcePrefix) setEventSourcePreview(full.sourcePrefix);
        // Opening retains prefix + opaque token. The workbench owns viewport source continuation.
        const hasIncrementalSource = Boolean(
          full.sourceToken && full.sourcePrefix !== undefined && full.sourcePrefix !== null
        );
        const dslTemplate = hasIncrementalSource ? null : full.dslTemplate ?? null;
        const dslTemplateTruncated = full.dslTemplateTruncated ?? false;
        const dslTemplateTotalLines = hasIncrementalSource
          ? full.sourceTotalLines ?? full.dslTemplateTotalLines ?? 0
          : full.dslTemplateTotalLines ?? (dslTemplate ? dslTemplate.split('\n').length : 0);
        let sourceStyle: 'dark-script' | 'patch-dsl' | 'none' = full.sourceStyle ?? 'none';
        if (dslTemplate && sourceStyle === 'none') {
          sourceStyle = /^\$Event\(/m.test(dslTemplate) ? 'dark-script' : 'patch-dsl';
        }
        if (!dslTemplate && sourceStyle === 'dark-script' && !hasIncrementalSource) {
          setEventSourcePreview(null);
          setEventPendingTab(null);
          setStatus('事件源码切片未齐，未打开编辑器。');
          return;
        }
        setEventSourcePreview(null);
        setEventPendingTab(emevdPendingTabFromFullDocument({
          tabId: target.sourceUri,
          title: eventTabShortTitle(target.relativePath),
          resourceUri: target.sourceUri,
          full,
          dslTemplate,
          dslTemplateTruncated,
          dslTemplateTotalLines,
          sourceStyle,
          ...(hasIncrementalSource
            ? { sourceToken: full.sourceToken, sourcePrefix: full.sourcePrefix, sourceTotalLines: dslTemplateTotalLines }
            : {})
        }));
        setStatus(
          `已加载 EMEVD：${full.eventCount ?? full.outline?.eventCount ?? 0} 事件 / `
          + `${full.instructionCount ?? full.outline?.instructionTotal ?? 0} 指令`
          + `（读取级别：${readLevelLabel(full.authority)}）`
        );
      } catch (error) {
        if (!isCurrent()) return;
        setEventPendingTab(null);
        setStatus(error instanceof Error ? error.message : 'EMEVD 读取异常');
      } finally {
        // Neither an obsolete request nor an unmounted/reset owner can finish the current opening.
        if (isCurrent()) setEventOpening(false);
      }
    }
    void loadEmevd();
    return () => {
      cancelled = true;
      eventMountedRef.current = false;
      // Keep the legacy window-scoped, no-argument cancellation. Failure is locally harmless.
      void bridge?.cancelEmevdFullDocument?.().catch(() => undefined);
    };
    // Feedback callbacks do not determine document identity or cause native rereads.
  }, [bridge, selectedFile]);

  /**
   * Capture before a native submit, so an old committed result cannot initiate a reread after a
   * selection/reset/unmount. This helper refreshes projections only; the caller keeps the receipt.
   */
  const prepareEventDocumentReload = useCallback((tab: EventDocumentReloadTarget) => {
    const requestId = eventOpenRequestRef.current;
    const { tabId, title, resourceUri, sourceStyle } = tab;
    const isCurrent = () => eventMountedRef.current && commandOwnerRef.current === commandOwner
      && eventOpenRequestRef.current === requestId;
    return async (): Promise<string | null> => {
      if (!isCurrent() || !bridge || typeof bridge.readEmevdFullDocument !== 'function') return null;
      try {
        const reload = await bridge.readEmevdFullDocument(
          resourceUri,
          `renderer-${resourceUri}-${Date.now()}`
        );
        if (!isCurrent() || reload?.cancelled || !reload?.ok) return null;
        // Full source assembly remains explicit post-submit behavior, never an opening dependency.
        const assembled = await assembleEmevdSource({
          dslTemplate: reload.dslTemplate ?? null,
          sourcePrefix: reload.sourcePrefix ?? null,
          sourceToken: reload.sourceToken ?? null,
          sourceTotalLines: reload.sourceTotalLines ?? reload.dslTemplateTotalLines,
          readSlice: async (token, fromLine, lineCount) => {
            if (!isCurrent()) return { cancelled: true };
            if (typeof bridge.readEmevdSourceSlice !== 'function') return { ok: false };
            return bridge.readEmevdSourceSlice(token, fromLine, lineCount);
          },
          isCancelled: () => !isCurrent()
        });
        if (!isCurrent() || assembled.cancelled || assembled.text === null) return null;
        setEventPendingTab(emevdPendingTabFromFullDocument({
          tabId,
          title,
          resourceUri,
          full: reload,
          dslTemplate: assembled.text,
          dslTemplateTruncated: reload.dslTemplateTruncated ?? false,
          dslTemplateTotalLines: reload.dslTemplateTotalLines ?? assembled.text.split('\n').length,
          sourceStyle: reload.sourceStyle ?? sourceStyle ?? 'none'
        }));
        return assembled.text;
      } catch (error) {
        // Refresh failure cannot turn a committed submit into a failed write or invite replay.
        if (isCurrent()) setStatus(error instanceof Error ? error.message : 'EMEVD 读取异常');
        return null;
      }
    };
  }, [bridge, commandOwner, setStatus]);
  async function submitEventDsl(tab: EventSourceTabData, sourceText: string): Promise<EventSourceSubmitResult> {
    if (!tab.live) {
      return { ok: false, diagnostics: [{ severity: 'error', code: 'EMEVD_DSL_NO_LIVE_DOCUMENT', message: '需要实时 EMEVD 文档才能提交 DSL。' }] };
    }
    if (!bridge) {
      return { ok: false, diagnostics: [{ severity: 'error', code: 'BRIDGE_UNAVAILABLE', message: describeBridgeAbsence('提交 EMEVD DSL') }] };
    }
    if (typeof bridge.submitEmevdDslPlan !== 'function') {
      return { ok: false, diagnostics: [{ severity: 'error', code: 'PRELOAD_MISSING', message: '当前预加载未暴露 submitEmevdDslPlan。' }] };
    }
    if (!eventMountedRef.current || commandOwnerRef.current !== commandOwner) {
      return { ok: false, diagnostics: [{ severity: 'error', code: 'EMEVD_DSL_OWNER_CHANGED', message: '事件工作台已切换，未提交旧请求。' }] };
    }
    const reload = prepareEventDocumentReload(tab);
    const result = await bridge.submitEmevdDslPlan(
      tab.resourceUri, sourceText, tab.sourceStyle === 'dark-script' ? 'dark-script' : 'patch'
    );
    if (result.ok) {
      const text = await reload();
      return text !== null ? { ...result, nextDslTemplate: text } : result;
    }
    return {
      ok: result.ok,
      diagnostics: result.diagnostics ?? [{ severity: 'error', code: 'EMEVD_DSL_SUBMIT_FAILED', message: 'DSL 提交失败。' }]
    };
  }
  return { eventPendingTab, eventOpening, eventSourcePreview, resetEventDocument, prepareEventDocumentReload, submitEventDsl };
}
export type EventDocumentController = ReturnType<typeof useEventDocumentController>;
