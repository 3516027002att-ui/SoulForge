/**
 * GPARAM 四栏工作台（对照 Smithbox Graphics Param Editor）。
 *
 * 左一：Banks   —— gparam 域全部磁盘文件（drawparam 等）
 * 左二：Groups  —— 选中 bank 的面板（group name1 为主、name2 为次）
 * 中右：Fields/Values —— 选中 group 的 param（名 + 类型 + 值）
 * 最右：Tools   —— 诚实空态（GPARAM-11B 只读，写控件由 11C 接线）
 *
 * ── 为什么是它 ──
 *
 * 打开 .gparam.dcx 之前只有「未接入」占位。GPARAM-11A 已在 Bridge 侧给出
 * read-gparam-document：DCX 解压 / loose 直读、round-trip 逐字节比对、
 * 分组分页。本组件是它的第一个消费者 —— 与 ParamWorkbench 对
 * readContainerParamPage 的关系相同。
 *
 * ── 层级 ──
 *
 * bank（文件）→ group（面板）→ param（同一组值控制同一图形参数的多个情景）。
 * 值类型有单值（byte/short/int/bool/float）与多分量（float2/3/4、byte4），
 * 解码已在 Bridge 完成，这里只按类型展开显示。
 *
 * ── 只读与失败 ──
 *
 * 11B 不提供任何写入控件：Tools 栏是诚实空态，不做假按钮（11C 接线前
 * 「可编辑」是谎言）。读取失败的 bank 保留在列表并标记失败，Fields/Values
 * 栏给出结构化诊断 —— 不能把 read failure 显示成空 bank。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { GparamDocument, GparamValueTypeName } from '@soulforge/shared';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout, type WorkbenchColumnSpec } from './WorkbenchLayout.js';

/** Banks 栏的一个条目：工作区索引里的 gparam 文件。 */
export interface GparamBankView {
  /** 稳定标识（文件浏览器与索引共用）。 */
  sourceUri: string;
  /** 物理相对路径（仅进 metadata details，不做显示名）。 */
  relativePath: string;
}

export interface GparamWorkbenchProps {
  /** 该域的全部 gparam 文件（banks）。 */
  banks: GparamBankView[];
  /** 打开时默认选中的 bank（当前选中文件）。 */
  initialUri?: string;
}

/** 每栏分页大小：Groups/Params 数量随 bank 不同可达数百，硬约束 17 要求分页。 */
const LIST_PAGE_SIZE = 60;

/** bank 显示名：文件名去扩展，物理路径只在 title/details。 */
function bankDisplayName(file: GparamBankView): string {
  const base = file.relativePath.split(/[\\/]/).pop() ?? file.relativePath;
  return base.replace(/\.gparam\.dcx$/i, '').replace(/\.gparam$/i, '');
}

/** 值类型的分量数（与 Bridge GparamValueTypeSizes 的分量定义一致）。 */
function componentCount(type: GparamValueTypeName): number {
  switch (type) {
    case 'float2': return 2;
    case 'float3': return 3;
    case 'float4': return 4;
    case 'byte4': return 4;
    default: return 1;
  }
}

/** 单值展示：float 家族保留小数位，其余按整数。 */
function formatValue(type: GparamValueTypeName, value: number): string {
  if (type === 'float' || type === 'float2' || type === 'float3' || type === 'float4') {
    // 保留 6 位有效数字，避免 0.30000000000000004 这类尾巴。
    const rounded = Number(value.toFixed(6));
    return String(rounded);
  }
  return String(Math.trunc(value));
}

export function GparamWorkbench(props: GparamWorkbenchProps): ReactElement {
  const bridge = getRendererBridge();

  const [selectedBankUri, setSelectedBankUri] = useState<string | null>(props.initialUri ?? null);
  /** 选中 bank 的读取结果；null 表示未选或失败。 */
  const [document, setDocument] = useState<GparamDocument | null>(null);
  /** bank → 读取失败诊断；失败 bank 保留在列表并标记。 */
  const [bankFailures, setBankFailures] = useState<Map<string, { code: string; message: string }>>(new Map());
  const [loading, setLoading] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [selectedParamId, setSelectedParamId] = useState<number | null>(null);

  // ── 选择链：bank → group → param ──
  useEffect(() => {
    setSelectedGroupId(null);
    setSelectedParamId(null);
  }, [selectedBankUri]);
  useEffect(() => {
    setSelectedParamId(null);
  }, [selectedGroupId]);

  // ── 读取选中 bank ──
  useEffect(() => {
    if (!bridge || typeof bridge.readGparamDocument !== 'function') return;
    if (selectedBankUri === null) {
      setDocument(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    bridge.readGparamDocument(selectedBankUri)
      .then((raw) => {
        if (cancelled) return;
        const result = raw as { ok: boolean; data?: GparamDocument; diagnostics?: Array<{ code?: string; message?: string }> };
        if (result.ok && result.data) {
          setDocument(result.data);
          // 成功则清掉该 bank 的失败标记（上次可能因未挂载失败，现已可读）。
          setBankFailures((current) => {
            if (!current.has(selectedBankUri)) return current;
            const next = new Map(current);
            next.delete(selectedBankUri);
            return next;
          });
        } else {
          setDocument(null);
          const first = result.diagnostics?.[0];
          setBankFailures((current) => {
            const next = new Map(current);
            next.set(selectedBankUri, {
              code: first?.code ?? 'GPARAM_READ_FAILED',
              message: first?.message ?? 'GPARAM 读取失败。'
            });
            return next;
          });
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDocument(null);
        setBankFailures((current) => {
          const next = new Map(current);
          next.set(selectedBankUri, {
            code: 'GPARAM_READ_EXCEPTION',
            message: error instanceof Error ? error.message : 'GPARAM 读取异常。'
          });
          return next;
        });
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [bridge, selectedBankUri]);

  // ── 本地分页（Groups / Params 都可能有数百条）──
  const [groupPage, setGroupPage] = useState(0);
  const [paramPage, setParamPage] = useState(0);
  useEffect(() => { setGroupPage(0); }, [selectedBankUri]);
  useEffect(() => { setParamPage(0); }, [selectedGroupId]);

  const groups = document?.groups ?? [];
  const groupPageCount = Math.max(1, Math.ceil(groups.length / LIST_PAGE_SIZE));
  const groupSlice = groups.slice(groupPage * LIST_PAGE_SIZE, (groupPage + 1) * LIST_PAGE_SIZE);

  const selectedGroup = useMemo(
    () => document?.groups.find((g) => g.groupId === selectedGroupId) ?? null,
    [document, selectedGroupId]
  );
  const params = selectedGroup?.params ?? [];
  const paramPageCount = Math.max(1, Math.ceil(params.length / LIST_PAGE_SIZE));
  const paramSlice = params.slice(paramPage * LIST_PAGE_SIZE, (paramPage + 1) * LIST_PAGE_SIZE);

  const selectedParam = useMemo(
    () => selectedGroup?.params.find((p) => p.paramId === selectedParamId) ?? null,
    [selectedGroup, selectedParamId]
  );

  // ── Fields/Values：选中 param 的值列表 ──
  const valueLines = useMemo(() => {
    if (!selectedParam) return [];
    const comps = componentCount(selectedParam.type);
    const lines: Array<{ index: number; values: string[]; valueId: number; unkFloat: number }> = [];
    for (let i = 0; i < selectedParam.valueCount; i += 1) {
      const parts: string[] = [];
      for (let c = 0; c < comps; c += 1) {
        const value = selectedParam.values[i * comps + c];
        parts.push(value === undefined ? '—' : formatValue(selectedParam.type, value));
      }
      lines.push({
        index: i,
        values: parts,
        valueId: selectedParam.valueIds[i] ?? 0,
        unkFloat: selectedParam.unkFloats[i] ?? 0
      });
    }
    return lines;
  }, [selectedParam]);

  const bankError = selectedBankUri ? bankFailures.get(selectedBankUri) : undefined;

  const columns: WorkbenchColumnSpec[] = [
    {
      id: 'banks',
      title: 'Banks',
      // bank 数量按当前索引实测（任务开始时 34 个是快照，不是验收常量）。
      hint: `${props.banks.length} banks`,
      initialFlex: 0.18,
      minWidth: 150,
      children: (
        <div className="wb-list">
          {props.banks.length === 0 && <p className="wb-empty">工作区中没有 GPARAM 文件。</p>}
          {props.banks.map((bank, index) => {
            const failure = bankFailures.get(bank.sourceUri);
            return (
              <div
                key={bank.sourceUri}
                className={failure ? 'wb-row wb-row--failed' : 'wb-row'}
                {...selectableRowAttributes({
                  selected: selectedBankUri === bank.sourceUri,
                  isTabEntry: isRowTabEntry(index, selectedBankUri !== null),
                  onSelect: () => setSelectedBankUri(bank.sourceUri)
                })}
              >
                <span className="wb-row__name" title={bank.relativePath}>{bankDisplayName(bank)}</span>
                {failure && <span className="wb-row__meta diag-error">读取失败</span>}
              </div>
            );
          })}
        </div>
      )
    },
    {
      id: 'groups',
      title: 'Groups',
      hint: `${groups.length} groups`,
      initialFlex: 0.24,
      minWidth: 200,
      children: (
        <div className="wb-list">
          {selectedBankUri === null && <p className="wb-empty">先在最左栏选择一个 bank。</p>}
          {selectedBankUri !== null && loading && <p className="wb-empty">加载中…</p>}
          {selectedBankUri !== null && !loading && bankError && (
            <p className="wb-empty diag-error">{bankError.message}</p>
          )}
          {selectedBankUri !== null && !loading && !bankError && document === null && (
            <p className="wb-empty">这个 bank 读不出来。</p>
          )}
          {selectedBankUri !== null && !loading && !bankError && document !== null && groupSlice.map((group, index) => (
            <div
              key={group.groupId}
              className="wb-row"
              {...selectableRowAttributes({
                selected: selectedGroupId === group.groupId,
                isTabEntry: isRowTabEntry(index, selectedGroupId !== null),
                onSelect: () => setSelectedGroupId(group.groupId)
              })}
            >
              <span className="wb-row__name" title={group.name2 || undefined}>
                {group.name1 || `Group ${group.groupId}`}
              </span>
              <span className="wb-row__meta">{group.paramCount} params</span>
            </div>
          ))}
          {selectedBankUri !== null && !loading && !bankError && document !== null && groupPageCount > 1 && (
            <div className="wb-pager">
              <button type="button" disabled={groupPage === 0} onClick={() => setGroupPage(groupPage - 1)}>‹</button>
              <span>{groupPage + 1}/{groupPageCount}</span>
              <button type="button" disabled={groupPage >= groupPageCount - 1} onClick={() => setGroupPage(groupPage + 1)}>›</button>
            </div>
          )}
        </div>
      )
    },
    {
      id: 'fields',
      title: 'Fields/Values',
      hint: selectedGroup ? `${selectedGroup.name1} · ${params.length} params` : 'params',
      initialFlex: 0.42,
      minWidth: 280,
      children: (
        <div className="wb-list">
          {selectedGroupId === null && <p className="wb-empty">先在中栏选择一个 group。</p>}
          {selectedGroupId !== null && selectedParamId === null && paramSlice.map((param, index) => (
            <div
              key={param.paramId}
              className="wb-row"
              {...selectableRowAttributes({
                selected: selectedParamId === param.paramId,
                isTabEntry: isRowTabEntry(index, selectedParamId !== null),
                onSelect: () => setSelectedParamId(param.paramId)
              })}
            >
              <span className="wb-row__name" title={param.name2 || undefined}>
                {param.name1 || `Param ${param.paramId}`}
              </span>
              <span className="wb-row__meta">{param.type} · {param.valueCount} 值</span>
            </div>
          ))}
          {selectedGroupId !== null && paramPageCount > 1 && (
            <div className="wb-pager">
              <button type="button" disabled={paramPage === 0} onClick={() => setParamPage(paramPage - 1)}>‹</button>
              <span>{paramPage + 1}/{paramPageCount}</span>
              <button type="button" disabled={paramPage >= paramPageCount - 1} onClick={() => setParamPage(paramPage + 1)}>›</button>
            </div>
          )}
          {selectedParamId !== null && selectedParam && (
            <div className="gparam-values">
              <div className="wb-list__group-label">
                {selectedParam.name1 || `Param ${selectedParam.paramId}`}
                {selectedParam.name2 ? ` · ${selectedParam.name2}` : ''}
              </div>
              <div className="gparam-values__head">
                <span>#</span>
                <span>值</span>
                <span>valueId</span>
                <span>unk f32</span>
              </div>
              {valueLines.map((line) => (
                <div key={line.index} className="gparam-values__row">
                  <span>{line.index}</span>
                  <span>{line.values.join(', ')}</span>
                  <span className="gparam-values__mono">{line.valueId}</span>
                  <span className="gparam-values__mono">{formatValue('float', line.unkFloat)}</span>
                </div>
              ))}
              {valueLines.length === 0 && <p className="wb-empty">该 param 没有值。</p>}
            </div>
          )}
        </div>
      )
    },
    {
      id: 'tools',
      title: 'Tools',
      initialFlex: 0.16,
      minWidth: 140,
      children: (
        <div className="wb-list">
          <p className="wb-empty">暂无已接通的工具</p>
          <p className="wb-empty">
            GPARAM 目前只读：字段写入由 GPARAM-11C 接线后才会出现，不会用假按钮占位。
          </p>
        </div>
      )
    }
  ];

  return (
    <WorkbenchLayout
      label="GPARAM 工作台"
      columns={columns}
      toolbar={
        <>
          <span className="crumb">Graphics Parameters · {props.banks.length} banks</span>
          {document && (
            <span className="muted" style={{ fontSize: 11 }}>
              {document.groupCount} groups · {document.roundTrip?.byteIdentical ? 'round-trip ✓' : ''}
            </span>
          )}
        </>
      }
    />
  );
}
