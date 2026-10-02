import { useEffect, useMemo, useRef, useState } from 'react';
import { PARAM_PAGE_SIZE, createParamSessionMaterializationTracker, paramPhysicalRowKey } from '@soulforge/shared';
import type { Diagnostic, ParamDefDocument, ParamFieldDef, ParamIndexRow, ParamNativeTelemetry, ParamPhysicalRowIdentity, ParamSessionMaterializationSnapshot } from '@soulforge/shared';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import type { ParamRowView } from '../editors/ParamTablePanel.js';
import { shouldLoadParam } from '../workbench/documentLoadGates.js';
import { base64ToUint8Array } from '../utils/binary.js';

export interface ParamDocumentOptions {
  bridge: Pick<NonNullable<RendererRuntime['bridge']>, 'openParamSession' | 'readParamIndexPage' | 'readParamRows' | 'applyParamFieldMutation'> | null;
  selectedFile: RendererIndexedFile | null;
  setStatus(message: string): void;
  pushToast(message: string, kind?: 'ok' | 'warn'): void;
  refreshOperationHistory(): Promise<void>;
  describeBridgeAbsence(operation: string): string;
}

const EMPTY_PARAM_ROWS: ParamRowView[] = [];

function paramRowViewFromIndex(row: ParamIndexRow): ParamRowView {
  return {
    rowIndex: row.rowIndex,
    id: row.id,
    dataHash: row.dataHash,
    dataHexPreview: '',
    ...(row.name !== null ? { name: row.name } : {})
  };
}

function mergeParamRowViews(
  existing: readonly ParamRowView[],
  incoming: readonly ParamIndexRow[]
): ParamRowView[] {
  const byRowIndex = new Map(existing.map((row) => [row.rowIndex, row]));
  for (const row of incoming) {
    const next = paramRowViewFromIndex(row);
    const previous = byRowIndex.get(row.rowIndex);
    byRowIndex.set(row.rowIndex, previous
      ? { ...next, ...(previous.dataBase64 ? { dataBase64: previous.dataBase64 } : {}), ...(previous.dataHexPreview ? { dataHexPreview: previous.dataHexPreview } : {}) }
      : next);
  }
  return [...byRowIndex.values()].sort((left, right) => left.rowIndex - right.rowIndex);
}

function paramDataHexPreview(dataBase64: string): string {
  try {
    return Array.from(base64ToUint8Array(dataBase64).slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join(' ');
  } catch {
    return '';
  }
}

export function useParamDocumentController(options: ParamDocumentOptions) {
  const { bridge, selectedFile, setStatus, pushToast, refreshOperationHistory, describeBridgeAbsence } = options;
  const [paramTypeName, setParamTypeName] = useState('');
  const [paramRows, setParamRows] = useState(EMPTY_PARAM_ROWS);
  const [paramRowCount, setParamRowCount] = useState(0);
  const [paramSourceHash, setParamSourceHash] = useState<string | null>(null);
  const [paramLive, setParamLive] = useState(false);
  const [paramSessionToken, setParamSessionToken] = useState<string | null>(null);
  const paramSessionTokenRef = useRef<string | null>(null);
  const [paramRowPayloads, setParamRowPayloads] = useState<Map<string, string>>(new Map());
  const paramMaterializationRef = useRef<ReturnType<typeof createParamSessionMaterializationTracker> | null>(null);
  const [paramMaterialization, setParamMaterialization] = useState<ParamSessionMaterializationSnapshot | null>(null);
  const [paramNativeTelemetry, setParamNativeTelemetry] = useState<ParamNativeTelemetry | null>(null);
  const [paramIndexLoading, setParamIndexLoading] = useState(false);
  const [paramIndexDiagnostic, setParamIndexDiagnostic] = useState<string | null>(null);
  /**
   * 主进程给出的 SoulForge 内置字段定义与缺失原因。
   *
   * main 侧只接受版本化、内容寻址的 first-party schema，并在返回前完成
   * 包来源、行宽和描述符匹配。字段定义不再依赖用户安装的第三方编辑器；
   * 未覆盖或行宽不匹配时保留结构化诊断并维持只读。
   */

  /**
   * 字段枚举表（enumRef → 值列表）。
   *
   * 主进程早就随 readParamDocument 返回 fieldEnums（ipc.ts 的 fieldEnums 分支），
   * 但渲染器此前**零引用**——数据被丢弃，于是枚举字段只显示裸数字。
   * 这是「最后一跳断线」的又一处：后端产出、前端不取，没有任何编译或测试信号。
   */

  /**
   * 字段定义的来源。first-party 只有在内置包校验、行宽核对和描述符匹配通过后
   * 才能放行写入；fixture 及覆盖缺口保持只读。渲染器只消费主进程裁定的值。
   */

  const [paramFieldDefs, setParamFieldDefs] = useState<ParamFieldDef[] | null>(null);
  const [paramFieldEnums, setParamFieldEnums] = useState<
    Array<{ id: string; name: string; values: Array<{ value: number; label: string }> }> | null
  >(null);
  const [paramFieldDefsOrigin, setParamFieldDefsOrigin] = useState<
    'first-party' | 'fixture' | 'imported' | 'user-derived'
  >('fixture');
  const [paramFieldDefsDiagnostic, setParamFieldDefsDiagnostic] = useState<
    { code: string; message: string } | null
  >(null);
  const [paramRowDataSize, setParamRowDataSize] = useState<number>(16);
  /** S31：PARAM 面板的外部 reveal 请求（行 id）；面板处理后经回调清除。 */
  const [paramRevealRowId, setParamRevealRowId] = useState<number | null>(null);
  const [resetEpoch, setParamResetEpoch] = useState(0);
  const submissionOwner = useMemo(() => ({}), [bridge, selectedFile, resetEpoch]);
  const documentLifetimeRef = useRef({ bridge, selectedFile, submissionOwner, mounted: false, generation: 0 });
  useEffect(() => {
    const lifetime = documentLifetimeRef.current;
    lifetime.bridge = bridge;
    lifetime.selectedFile = selectedFile;
    lifetime.submissionOwner = submissionOwner;
    lifetime.mounted = true;
    lifetime.generation++;
    return () => { lifetime.mounted = false; lifetime.generation++; };
  }, [bridge, selectedFile, submissionOwner]);
  function ownsDocument(generation: number): boolean {
    const lifetime = documentLifetimeRef.current;
    return lifetime.mounted && lifetime.generation === generation && lifetime.bridge === bridge && lifetime.selectedFile === selectedFile;
  }

  function resetParamDocument(): void {
    documentLifetimeRef.current.generation++;
    documentLifetimeRef.current.submissionOwner = {};
    setParamResetEpoch(epoch => epoch + 1);
    setParamRows(EMPTY_PARAM_ROWS);
    setParamTypeName('');
    setParamSourceHash(null);
    setParamLive(false);
    setParamRowPayloads(new Map());
    setParamRowCount(0);
    setParamSessionToken(null);
    paramSessionTokenRef.current = null;
    setParamMaterialization(null);
    paramMaterializationRef.current = null;
    setParamNativeTelemetry(null);
    setParamIndexLoading(false);
    setParamIndexDiagnostic(null);
    // 字段定义必须一起清：两张 param 表的行宽通常不同，残留的字段列会让用户
    // 对着上一张表的字段名看新表的字节。
    setParamFieldDefs(null);
    setParamFieldEnums(null);
    setParamFieldDefsDiagnostic(null);
    // 来源回落到只读：上一个 param 的 first-party 定义若残留，新 param 的字段
    // 会被错误地显示为可写。写入判定必须由新文档的 fieldDefsOrigin 重新给出。
    setParamFieldDefsOrigin('fixture');
    // S31：一次性 PARAM reveal 请求随 param 族清空，避免残留到别的表误滚动。
    setParamRevealRowId(null);
  }

  useEffect(() => {
    let cancelled = false;
    const generation = documentLifetimeRef.current.generation;
    const isCurrent = () => !cancelled && ownsDocument(generation);
    async function loadParam(): Promise<void> {
      // SHELL-09：语义领域不再有兜底文件列表；只有用户显式选中的 param 文件才加载。
      const target = selectedFile;
      // P2 裁定：gparam 文件（.gparam/.gparam.dcx）走 GPARAM 工作台，绝不让
      // PARAM 读链去碰它——否则会串域报「这个 PARAM 读不出来」。
      if (!target || !shouldLoadParam(target)) {
        setParamRows(EMPTY_PARAM_ROWS);
        setParamTypeName('');
        setParamSourceHash(null);
        setParamLive(false);
        setParamRowCount(0);
        setParamSessionToken(null);
        paramSessionTokenRef.current = null;
        setParamRowPayloads(new Map());
        return;
      }
      if (!bridge || typeof bridge.openParamSession !== 'function') {
        setParamRows(EMPTY_PARAM_ROWS);
        setParamTypeName('');
        setParamSourceHash(null);
        setParamLive(false);
        setParamRowCount(0);
        setParamSessionToken(null);
        paramSessionTokenRef.current = null;
        setParamRowPayloads(new Map());
        return;
      }
      setStatus(`正在读取 PARAM：${target.relativePath}`);
      setParamIndexLoading(true);
      setParamIndexDiagnostic(null);
      try {
        const result = await bridge.openParamSession({ sourceUri: target.sourceUri });
        if (!isCurrent()) return;
        if (!result.ok) {
          setParamRows(EMPTY_PARAM_ROWS);
          setParamLive(false);
          setParamSourceHash(null);
          setParamRowCount(0);
          setParamSessionToken(null);
          paramSessionTokenRef.current = null;
          setParamRowPayloads(new Map());
          setParamFieldDefs(null);
          setParamFieldEnums(null);
          setParamFieldDefsDiagnostic(null);
          // 读取失败同样要清来源：否则上一个 param 的 first-party 残留，会让
          // 这个读不出来的资源看起来仍可写入字段。
          setParamFieldDefsOrigin('fixture');
          setStatus(result.diagnostics?.[0]?.message ?? '这个 PARAM 读不出来。');
          return;
        }
        const sessionToken = result.sessionToken;
        paramSessionTokenRef.current = sessionToken;
        setParamSessionToken(sessionToken);
        setParamRowCount(result.rowCount);
        setParamSourceHash(result.sourceHash);
        setParamTypeName(result.metadata.typeName || target.relativePath);
        setParamRowDataSize(result.metadata.rowDataSize);
        setParamFieldDefs(result.metadata.fieldDefs);
        setParamFieldEnums(result.metadata.fieldEnums);
        setParamFieldDefsOrigin(
          result.metadata.fieldDefsOrigin === 'first-party'
            || result.metadata.fieldDefsOrigin === 'imported'
            || result.metadata.fieldDefsOrigin === 'user-derived'
            ? result.metadata.fieldDefsOrigin
            : 'fixture'
        );
        setParamFieldDefsDiagnostic(
          result.metadata.fieldDefsDiagnostic
            ? { code: result.metadata.fieldDefsDiagnostic.code, message: result.metadata.fieldDefsDiagnostic.message }
            : null
        );
        setParamNativeTelemetry(result.nativeTelemetry);
        const tracker = createParamSessionMaterializationTracker(result.rowCount);
        paramMaterializationRef.current = tracker;
        tracker.observeIndex(result.firstPage.rows);
        setParamRows(result.firstPage.rows.map(paramRowViewFromIndex));
        setParamMaterialization(tracker.snapshot());
        setParamRowPayloads(new Map());
        setParamLive(true);
        setParamIndexLoading(true);
        setStatus(
          `已打开 PARAM：${result.rowCount} 行索引（首批 ${result.firstPage.rows.length} 行）`
        );
        let loadedThrough = result.firstPage.rows.reduce(
          (max, row) => Math.max(max, row.rowIndex + 1),
          0
        );
        let page = result.firstPage.page + 1;
        while (isCurrent() && loadedThrough < result.rowCount) {
          const pageResult = await bridge.readParamIndexPage({
            sourceUri: target.sourceUri,
            sessionToken,
            page,
            pageSize: PARAM_PAGE_SIZE
          });
          if (!isCurrent()) return;
          if (!pageResult.ok) {
            setParamIndexDiagnostic(pageResult.diagnostics?.[0]?.message ?? 'PARAM 索引续读失败。');
            break;
          }
          tracker.observeIndex(pageResult.rows);
          setParamRows((current) => mergeParamRowViews(current, pageResult.rows));
          setParamMaterialization(tracker.snapshot());
          setParamNativeTelemetry(pageResult.nativeTelemetry);
          const nextLoadedThrough = pageResult.rows.reduce(
            (max, row) => Math.max(max, row.rowIndex + 1),
            loadedThrough
          );
          if (pageResult.rows.length === 0 || nextLoadedThrough <= loadedThrough) break;
          loadedThrough = nextLoadedThrough;
          page += 1;
          if (pageResult.rows.length < PARAM_PAGE_SIZE) break;
        }
      } catch (error) {
        if (!isCurrent()) return;
        setParamLive(false);
        setParamSessionToken(null);
        paramSessionTokenRef.current = null;
        setStatus(error instanceof Error ? error.message : 'PARAM 读取异常');
      } finally {
        if (isCurrent()) setParamIndexLoading(false);
      }
    }
    void loadParam();
    return () => {
      cancelled = true;
    };
  }, [bridge, selectedFile]);

  async function readParamRowsForPanel(
    identities: readonly ParamPhysicalRowIdentity[]
  ): Promise<ReadonlyArray<{ identity: ParamPhysicalRowIdentity; dataBase64: string }>> {
    if (!bridge || !selectedFile || !paramSessionToken || identities.length === 0) {
      throw new Error('PARAM 会话未就绪，无法读取选中行。');
    }
    if (typeof bridge.readParamRows !== 'function') {
      throw new Error('当前预加载未暴露 readParamRows。');
    }
    const generation = documentLifetimeRef.current.generation;
    if (!ownsDocument(generation)) throw new Error('PARAM 会话已切换，无法读取选中行。');
    const result = await bridge.readParamRows({
      sourceUri: selectedFile.sourceUri,
      sessionToken: paramSessionToken,
      rows: [...identities]
    });
    if (!result.ok) {
      throw new Error(result.diagnostics?.[0]?.message ?? '读取选中 PARAM 行失败。');
    }
    // The caller still receives its original scoped read result; a late reply
    // cannot populate the currently selected document's tracker or payload cache.
    if (!ownsDocument(generation)) return result.rows;
    const tracker = paramMaterializationRef.current;
    tracker?.observePayload(identities, result.rows);
    if (tracker) setParamMaterialization(tracker.snapshot());
    setParamNativeTelemetry(result.nativeTelemetry);
    const payloadByKey = new Map(result.rows.map((row) => [paramPhysicalRowKey(row.identity), row.dataBase64]));
    setParamRowPayloads((current) => {
      const next = new Map(current);
      for (const row of result.rows) next.set(paramPhysicalRowKey(row.identity), row.dataBase64);
      return next;
    });
    setParamRows((current) => current.map((row) => {
      const identity = { rowIndex: row.rowIndex, id: row.id, dataHash: row.dataHash };
      const dataBase64 = payloadByKey.get(paramPhysicalRowKey(identity));
      return dataBase64
        ? { ...row, dataBase64, dataHexPreview: paramDataHexPreview(dataBase64) }
        : row;
    }));
    return result.rows;
  }

  async function reloadParamRowsFromSource(): Promise<void> {
    if (!bridge || !selectedFile || typeof bridge.openParamSession !== 'function') return;
    const generation = documentLifetimeRef.current.generation;
    if (!ownsDocument(generation)) return;
    const reload = await bridge.openParamSession({ sourceUri: selectedFile.sourceUri });
    if (!ownsDocument(generation)) return;
    if (!reload.ok) {
      setParamLive(false);
      setParamIndexDiagnostic(reload.diagnostics?.[0]?.message ?? 'PARAM 写回后重开会话失败。');
      return;
    }
    const sessionToken = reload.sessionToken;
    paramSessionTokenRef.current = sessionToken;
    setParamSessionToken(sessionToken);
    setParamSourceHash(reload.sourceHash);
    setParamTypeName(reload.metadata.typeName || selectedFile.relativePath);
    setParamRowDataSize(reload.metadata.rowDataSize);
    setParamRowCount(reload.rowCount);
    setParamFieldDefs(reload.metadata.fieldDefs);
    setParamFieldEnums(reload.metadata.fieldEnums);
    setParamFieldDefsOrigin(
      reload.metadata.fieldDefsOrigin === 'first-party'
        || reload.metadata.fieldDefsOrigin === 'imported'
        || reload.metadata.fieldDefsOrigin === 'user-derived'
        ? reload.metadata.fieldDefsOrigin
        : 'fixture'
    );
    setParamFieldDefsDiagnostic(reload.metadata.fieldDefsDiagnostic);
    setParamNativeTelemetry(reload.nativeTelemetry);
    const tracker = createParamSessionMaterializationTracker(reload.rowCount);
    paramMaterializationRef.current = tracker;
    tracker.observeIndex(reload.firstPage.rows);
    setParamRows(reload.firstPage.rows.map(paramRowViewFromIndex));
    setParamRowPayloads(new Map());
    setParamMaterialization(tracker.snapshot());
    setParamLive(true);
    setParamIndexLoading(true);
    setParamIndexDiagnostic(null);
    try {
      let loadedThrough = reload.firstPage.rows.reduce(
        (max, row) => Math.max(max, row.rowIndex + 1),
        0
      );
      let page = reload.firstPage.page + 1;
      while (ownsDocument(generation) && loadedThrough < reload.rowCount) {
        const pageResult = await bridge.readParamIndexPage({
          sourceUri: selectedFile.sourceUri,
          sessionToken,
          page,
          pageSize: PARAM_PAGE_SIZE
        });
        if (!ownsDocument(generation)) return;
        if (!pageResult.ok) {
          setParamIndexDiagnostic(pageResult.diagnostics?.[0]?.message ?? 'PARAM 写回后索引续读失败。');
          break;
        }
        tracker.observeIndex(pageResult.rows);
        setParamRows((current) => mergeParamRowViews(current, pageResult.rows));
        setParamMaterialization(tracker.snapshot());
        setParamNativeTelemetry(pageResult.nativeTelemetry);
        const nextLoadedThrough = pageResult.rows.reduce(
          (max, row) => Math.max(max, row.rowIndex + 1),
          loadedThrough
        );
        if (pageResult.rows.length === 0 || nextLoadedThrough <= loadedThrough) break;
        loadedThrough = nextLoadedThrough;
        page += 1;
        if (pageResult.rows.length < PARAM_PAGE_SIZE) break;
      }
    } finally {
      if (ownsDocument(generation)) setParamIndexLoading(false);
    }
  }

  async function applyParamFieldMutationFromPanel(input: {
    rowId: number;
    identity?: ParamPhysicalRowIdentity;
    fieldId: string;
    value: number | string | boolean;
    rowDataBase64: string;
    definition: unknown;
  }): Promise<{ ok: boolean; diagnostics?: Array<{ code: string; message: string }> }> {
    if (!selectedFile) {
      return {
        ok: false,
        diagnostics: [{ code: 'PARAM_FIELD_NO_LIVE_DOCUMENT', message: '需要实时 PARAM 文档才能提交字段。' }]
      };
    }
    if (!bridge) {
      return {
        ok: false,
        diagnostics: [{ code: 'BRIDGE_UNAVAILABLE', message: describeBridgeAbsence('提交 PARAM 字段') }]
      };
    }
    if (typeof bridge.applyParamFieldMutation !== 'function') {
      return {
        ok: false,
        diagnostics: [{ code: 'PRELOAD_MISSING', message: '当前预加载未暴露 applyParamFieldMutation。' }]
      };
    }
    const generation = documentLifetimeRef.current.generation;
    if (!ownsDocument(generation) || documentLifetimeRef.current.submissionOwner !== submissionOwner) {
      return {
        ok: false,
        diagnostics: [{ code: 'PARAM_FIELD_DOCUMENT_CHANGED', message: 'PARAM 文档已切换，未提交旧字段。' }]
      };
    }
    setStatus('正在保存 PARAM 字段…');
    // S29：哈希只留 main 做并发凭据，renderer 空串不拒写（main 写时现算兜底）。
    const result = await bridge.applyParamFieldMutation(
      selectedFile.sourceUri,
      paramSourceHash ?? '',
      {
        rowId: input.rowId,
        ...(input.identity
          ? { rowIndex: input.identity.rowIndex, expectedDataHash: input.identity.dataHash }
          : {}),
        fieldId: input.fieldId,
        value: input.value,
        rowDataBase64: input.rowDataBase64,
        definition: input.definition
      }
    );
    if (result.ok) {
      // This is an already-committed result. Switching the renderer selection
      // only invalidates its projection; it never cancels or replays the write.
      if (!ownsDocument(generation)) return result;
      try {
        await reloadParamRowsFromSource();
      } catch {
        if (!ownsDocument(generation)) return result;
        const message = `PARAM 字段 ${input.fieldId} 已保存，但文档重读失败。`;
        setStatus(message);
        pushToast(message, 'warn');
        return { ...result, diagnostics: [...(result.diagnostics ?? []), { code: 'POSTCOMMIT_PARAM_RELOAD_FAILED', message }] };
      }
      if (!ownsDocument(generation)) return result;
      try {
        await refreshOperationHistory();
      } catch {
        if (!ownsDocument(generation)) return result;
        const message = `PARAM 字段 ${input.fieldId} 已保存，但操作历史刷新失败。`;
        setStatus(message);
        pushToast(message, 'warn');
        return { ...result, diagnostics: [...(result.diagnostics ?? []), { code: 'POSTCOMMIT_HISTORY_REFRESH_FAILED', message }] };
      }
      if (!ownsDocument(generation)) return result;
      setStatus(`PARAM 字段 ${input.fieldId} 已保存。`);
      pushToast('已保存');
      return result;
    }
    return {
      ok: false,
      diagnostics: (result.diagnostics ?? []).map((diagnostic: Diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message
      }))
    };
  }

  const paramFieldDefinition = useMemo<ParamDefDocument | null>(() => {
    if (!paramFieldDefs || paramFieldDefs.length === 0) return null;
    return {
      schemaVersion: 1,
      typeName: paramTypeName,
      version: 0,
      rowDataSize: paramRowDataSize,
      origin: paramFieldDefsOrigin,
      fields: paramFieldDefs
    };
  }, [paramFieldDefs, paramTypeName, paramRowDataSize, paramFieldDefsOrigin]);

  return { paramTypeName, paramRows, paramRowCount, paramSourceHash, paramLive, paramRowPayloads, paramIndexLoading, paramIndexDiagnostic, paramFieldDefs, paramFieldEnums, paramFieldDefsOrigin, paramFieldDefsDiagnostic, paramRowDataSize, paramRevealRowId, setParamRevealRowId, readParamRowsForPanel, reloadParamRowsFromSource, applyParamFieldMutationFromPanel, paramFieldDefinition, resetParamDocument };
}
export type ParamDocumentController = ReturnType<typeof useParamDocumentController>;
