/**
 * GPARAM 五区工作台（对照 Smithbox Graphics Param Editor，§8.1）。
 *
 * 左一：Files     —— gparam 域全部逻辑 bank（drawparam 等；物理文件名只在 title/details）
 * 左二：Groups    —— 选中 bank 的面板（group name1 为主、name2 为次）
 * 中三：Fields    —— 选中 group 的 param（field）列表（名 + 类型 + 值数）
 * 中四：Values    —— 选中 field 的逐值展开（分量输入 / valueId / unk f32）
 * 最右：Toolbar   —— 搜索/工具操作；write 未通时写控件隐藏
 *
 * ── 为什么是它 ──
 *
 * §8.1 明确「禁止把 Fields 和 Values 合成 Fields/Values 一栏」。早期四栏合并
 * 实现（Banks | Groups | Fields/Values | Tools）把 field 列表与 value 展开塞进
 * 同一栏、靠 selection 切换显示，已按规范返工为五区并存。§2.5 的默认停靠是
 * Files 707 | Groups 340 | Fields 449 | Values 636 | Toolbar 515，这里按比例
 * 折算成 initialFlex。
 *
 * ── 层级 ──
 *
 * bank（文件）→ group（面板）→ field（param）→ value（该 field 的多个情景值）。
 * 值类型有单值（byte/short/int/bool/float）与多分量（float2/3/4、byte4），
 * 解码已在 Bridge 完成，这里只按类型展开显示。
 *
 * ── 选择链 ──
 *
 * Files → Groups → Fields → Values 是父子链：父级改变清空所有下游选区。
 * 换 bank 清 group/field 选择，换 group 清 field 选择。Fields 栏始终列出
 * 当前 group 的全部 param；选 field 后 Values 栏加载该 field 的值。
 *
 * ── 编辑与失败 ──
 *
 * 11C 接线 typed 写回：选中 field 的值行可编辑（每分量一个输入框），改动
 * 收集为 field-set drafts，Toolbar 栏在有 drafts 时出现「保存」入口，经
 * resource.commitGparamMutations（write-gparam）提交 —— 只有 typed 定位才有
 * 写入口，没有通用 bytes replace fallback。写入失败保留 drafts 并给出结构化
 * 诊断，不静默丢改动。读取失败的 bank 保留在列表并标记失败，Groups/Fields/Values
 * 栏给出结构化诊断 —— 不能把 read failure 显示成空 bank。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { GparamDocument, GparamValueTypeName } from '@soulforge/shared';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout, type WorkbenchColumnSpec } from './WorkbenchLayout.js';

/** Files 栏的一个条目：工作区索引里的一个 gparam 逻辑 bank。 */
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

  // ── 11C 编辑 drafts：key = `${groupId}|${paramId}|${valueIndex}` → 用户输入 ──
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  // 保存成功后强制重读（read 通道每次直读，refresh 只是重触发 effect）。
  const [refreshToken, setRefreshToken] = useState(0);

  // ── 选择链清理：父级改变清空所有下游选区 ──
  // bank → 清 group/field；group → 清 field。
  useEffect(() => {
    setSelectedGroupId(null);
    setSelectedParamId(null);
  }, [selectedBankUri]);
  useEffect(() => {
    setSelectedParamId(null);
  }, [selectedGroupId]);
  // 换 field 清 drafts：drafts 的 key 含 paramId，留着会让「N 处修改」跨选区
  // 漂移，用户会困惑改了 A 的却显示在 B 上。
  useEffect(() => {
    setDrafts(new Map());
    setSaveError(null);
    setSaveNotice(null);
  }, [selectedParamId, selectedGroupId, selectedBankUri]);

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
  }, [bridge, selectedBankUri, refreshToken]);

  // ── 本地分页（Groups / Fields 都可能有数百条）──
  const [groupPage, setGroupPage] = useState(0);
  const [fieldPage, setFieldPage] = useState(0);
  useEffect(() => { setGroupPage(0); }, [selectedBankUri]);
  useEffect(() => { setFieldPage(0); }, [selectedGroupId]);

  const groups = document?.groups ?? [];
  const groupPageCount = Math.max(1, Math.ceil(groups.length / LIST_PAGE_SIZE));
  const groupSlice = groups.slice(groupPage * LIST_PAGE_SIZE, (groupPage + 1) * LIST_PAGE_SIZE);

  const selectedGroup = useMemo(
    () => document?.groups.find((g) => g.groupId === selectedGroupId) ?? null,
    [document, selectedGroupId]
  );
  const fields = selectedGroup?.params ?? [];
  const fieldPageCount = Math.max(1, Math.ceil(fields.length / LIST_PAGE_SIZE));
  const fieldSlice = fields.slice(fieldPage * LIST_PAGE_SIZE, (fieldPage + 1) * LIST_PAGE_SIZE);

  const selectedParam = useMemo(
    () => selectedGroup?.params.find((p) => p.paramId === selectedParamId) ?? null,
    [selectedGroup, selectedParamId]
  );

  // ── Values 栏：选中 field 的值列表 ──
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

  // ── 保存：drafts → typed mutations → commitGparamMutations ──
  const draftCount = drafts.size;
  const allFinite = [...drafts.values()].every((text) => Number.isFinite(Number(text)));
  const commitDrafts = useCallback(async () => {
    if (!bridge || typeof bridge.commitGparamMutations !== 'function') return;
    if (document === null || selectedBankUri === null || selectedGroupId === null) return;
    const mutations: Array<{ groupId: number; paramId: number; valueIndex: number; value: number }> = [];
    for (const [key, text] of drafts) {
      const parts = key.split('|');
      const value = Number(text);
      if (!Number.isFinite(value)) {
        setSaveError('存在非数字输入，无法提交。');
        return;
      }
      mutations.push({
        groupId: Number(parts[0]),
        paramId: Number(parts[1]),
        valueIndex: Number(parts[2]),
        value
      });
    }
    if (mutations.length === 0) return;
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    try {
      const raw = await bridge.commitGparamMutations(selectedBankUri, document.sourceHash, mutations);
      const result = raw as { ok?: boolean; diagnostics?: Array<{ message?: string }> };
      if (result.ok) {
        setDrafts(new Map());
        setSaveNotice(`已提交 ${mutations.length} 处修改并重读验证。`);
        setRefreshToken((token) => token + 1);
      } else {
        setSaveError(result.diagnostics?.[0]?.message ?? 'GPARAM 写入被拒绝。');
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'GPARAM 写入异常。');
    } finally {
      setSaving(false);
    }
  }, [bridge, document, selectedBankUri, selectedGroupId, drafts]);

  const columns: WorkbenchColumnSpec[] = [
    {
      id: 'files',
      title: 'Files',
      // bank 数量按当前索引实测（任务开始时 34 个是快照，不是验收常量）。
      hint: `${props.banks.length} banks`,
      // §2.5 停靠：Files 707 | Groups 340 | Fields 449 | Values 636 | Toolbar 515，
      // 折算比例 ≈ 0.27 / 0.13 / 0.17 / 0.24 / 0.19。
      initialFlex: 0.27,
      minWidth: 180,
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
      initialFlex: 0.13,
      minWidth: 180,
      children: (
        <div className="wb-list">
          {selectedBankUri === null && <p className="wb-empty">先在 Files 栏选择一个 bank。</p>}
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
      title: 'Fields',
      hint: selectedGroup ? `${selectedGroup.name1} · ${fields.length} params` : 'params',
      initialFlex: 0.17,
      minWidth: 220,
      children: (
        <div className="wb-list">
          {selectedGroupId === null && <p className="wb-empty">先在中栏选择一个 group。</p>}
          {selectedGroupId !== null && fieldSlice.map((param, index) => (
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
          {selectedGroupId !== null && fieldPageCount > 1 && (
            <div className="wb-pager">
              <button type="button" disabled={fieldPage === 0} onClick={() => setFieldPage(fieldPage - 1)}>‹</button>
              <span>{fieldPage + 1}/{fieldPageCount}</span>
              <button type="button" disabled={fieldPage >= fieldPageCount - 1} onClick={() => setFieldPage(fieldPage + 1)}>›</button>
            </div>
          )}
        </div>
      )
    },
    {
      id: 'values',
      title: 'Values',
      hint: selectedParam ? `${selectedParam.type} · ${selectedParam.valueCount} 值` : '值',
      initialFlex: 0.24,
      minWidth: 260,
      children: (
        <div className="wb-list">
          {selectedParamId === null && <p className="wb-empty">先在 Fields 栏选择一个 field。</p>}
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
              {valueLines.map((line) => {
                const comps = componentCount(selectedParam.type);
                const rowEdited = line.values.some((_, c) =>
                  drafts.has(`${selectedGroupId}|${selectedParam.paramId}|${line.index * comps + c}`));
                return (
                  <div key={line.index} className={rowEdited ? 'gparam-values__row gparam-values__row--edited' : 'gparam-values__row'}>
                    <span>{line.index}</span>
                    <span className="gparam-values__editors">
                      {line.values.map((formatted, c) => {
                        const valueIndex = line.index * comps + c;
                        const raw = selectedParam.values[valueIndex];
                        const key = `${selectedGroupId}|${selectedParam.paramId}|${valueIndex}`;
                        return (
                          <input
                            key={valueIndex}
                            type="text"
                            inputMode="decimal"
                            aria-label={`值 ${valueIndex}`}
                            className="gparam-values__input"
                            value={drafts.get(key) ?? (raw === undefined ? '' : formatValue(selectedParam.type, raw))}
                            onChange={(e) => {
                              const next = new Map(drafts);
                              next.set(key, e.target.value);
                              setDrafts(next);
                              // 新一轮编辑开始，清掉上一次的提交成功提示。
                              setSaveNotice(null);
                            }}
                          />
                        );
                      })}
                    </span>
                    <span className="gparam-values__mono">{line.valueId}</span>
                    <span className="gparam-values__mono">{formatValue('float', line.unkFloat)}</span>
                  </div>
                );
              })}
              {valueLines.length === 0 && <p className="wb-empty">该 field 没有值。</p>}
            </div>
          )}
        </div>
      )
    },
    {
      id: 'toolbar',
      title: 'Toolbar',
      initialFlex: 0.19,
      minWidth: 200,
      children: (
        <div className="wb-list">
          {/* 提交成功提示在 drafts 清空后仍须可见：清空会立即切回诚实空态，
              若只挂在 draftCount>0 分支里，成功确认会被同一次渲染抹掉。 */}
          {saveNotice && <p className="wb-empty">{saveNotice}</p>}
          {draftCount > 0 && document !== null ? (
            <>
              <div className="wb-list__group-label">字段写入（typed field-set）</div>
              <p className="wb-empty">共 {draftCount} 处修改，提交后经 write-gparam 重读验证。</p>
              {saveError && <p className="wb-empty diag-error">{saveError}</p>}
              {!allFinite && <p className="wb-empty diag-error">存在非数字输入，无法提交。</p>}
              <button
                type="button"
                className="primary-action"
                disabled={saving || !allFinite}
                onClick={() => { void commitDrafts(); }}
              >
                {saving ? '提交中…' : `保存 ${draftCount} 处修改`}
              </button>
            </>
          ) : (
            <>
              <p className="wb-empty">暂无已接通的工具</p>
              <p className="wb-empty">
                选中 field 后修改值，此处出现 typed 保存入口（没有 bytes replace fallback）。
              </p>
            </>
          )}
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
