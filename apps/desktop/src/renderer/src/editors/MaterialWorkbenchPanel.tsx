/**
 * MATERIAL-53B：Smithbox Material 工作台（§2.5）。
 *
 * 三栏：`File list | Material list | Properties / Values`。
 *
 * ── 为什么是它 ──
 *
 * MATERIAL-53A 已在 Bridge 侧给出 read-mtd-document（MTD XML 结构投影、round-trip
 * 一致性、属性/纹理引用三页投影）。本组件是 read-mtd-document 的消费方，与
 * GparamWorkbench 对 read-gparam-document、TpfWorkbenchPanel 对 read-tpf-document
 * 的关系相同。
 *
 * ── 层级 ──
 *
 * 文件（.mtd 包文件）→ 材质（单文件 = 单材质定义）→ 属性/值（右侧展示选中材质的
 * 属性行）。无 3D viewport（§2.5：MATERIAL 无 viewport，不要发明 Preview 第四栏）。
 *
 * ── unknown property 可见但不可编辑 ──
 *
 * param 元素上的未识别属性由 C# 原样保留在 MaterialPropertyWire.unknown 里，同时进
 * unparsedGaps 并降 partial。本卡是只读工作台（MATERIAL-53C 才接写回），unknown
 * 属性必须**可见**（渲染为只读值行，不能丢弃），且**不可编辑**（本卡不渲染任何
 * 写控件/输入框）。
 *
 * ── partial 不能伪装成完整解析 ──
 *
 * authority 为 partial 时（unknown 属性/复数材质容器/未识别 XML 元素），unparsedGaps
 * 必须对用户可见（gap 区段），不能把「读出来了」显示成「完整解析的空文档」。
 *
 * ── 失败 ──
 *
 * 读取失败的文件保留在列表并标记失败，Material list 栏给出结构化诊断，不能把 read
 * failure 显示成空包。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  isMtdDocument,
  projectMaterialDocumentPages,
  type MaterialPropertyWire,
  type MtdDocument
} from '@soulforge/shared';
import { formatListTruncation } from '../format/uiText.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';

/** File list 栏的一个条目：工作区索引里的 MTD 文件。 */
export interface MaterialFileView {
  /** 稳定标识（文件浏览器与索引共用）。 */
  sourceUri: string;
  /** 物理相对路径（仅进 metadata details，不做显示名）。 */
  relativePath: string;
}

export interface MaterialWorkbenchPanelProps {
  /** 该域的全部 MTD 文件（files）。 */
  files: MaterialFileView[];
  /** 打开时默认选中的文件（当前选中资源）。 */
  initialUri?: string;
}

/** 属性列表单组渲染上限（硬约束 17：大表不能一次全渲，超限必须报未显示数）。 */
const PROPERTY_RENDER_LIMIT = 200;
/** 纹理引用渲染上限（同硬约束 17）。 */
const TEXTURE_REF_RENDER_LIMIT = 200;

/** MTD 显示名：文件名去 .mtd，物理路径只在 title/details。 */
function materialFileDisplayName(file: MaterialFileView): string {
  const base = file.relativePath.split(/[\\/]/).pop() ?? file.relativePath;
  return base.replace(/\.mtd$/i, '');
}

type MaterialSelectionKind = 'material' | 'texture';

interface MaterialSelection {
  kind: MaterialSelectionKind;
  /** 材质名（或文件显示名退化）；同时作为 Inspector 标题与选中行 label。 */
  label: string;
  /** 纹理引用索引；kind === 'texture' 时有效。 */
  textureIndex?: number;
}

/** 属性 → 展示行投影：unknown 属性展开为独立只读行，不可丢弃。 */
export interface MaterialPropertyRow {
  id: string;
  name: string;
  value: string;
  /** 属性 value 的声明类型（param type 属性），可能缺失。 */
  type?: string;
  /** 未识别属性行：可见但不可编辑（本卡无 writer）。 */
  unknown?: boolean;
}

export function materialPropertyRows(properties: MaterialPropertyWire[]): MaterialPropertyRow[] {
  const rows: MaterialPropertyRow[] = [];
  for (const prop of properties) {
    const label = prop.name || prop.id || '未命名属性';
    rows.push({
      id: prop.id ?? label,
      name: label,
      value: prop.value ?? '',
      ...(prop.type ? { type: prop.type } : {})
    });
    if (prop.unknown && Object.keys(prop.unknown).length > 0) {
      for (const [key, value] of Object.entries(prop.unknown)) {
        rows.push({
          id: `${prop.id ?? label}.${key}`,
          name: `${key}（未识别）`,
          value,
          unknown: true
        });
      }
    }
  }
  return rows;
}

export function MaterialWorkbenchPanel(props: MaterialWorkbenchPanelProps): ReactElement {
  const bridge = getRendererBridge();

  const [selectedUri, setSelectedUri] = useState<string | null>(props.initialUri ?? null);
  /** 选中文件的读取结果；null 表示未选或失败。 */
  const [document, setDocument] = useState<MtdDocument | null>(null);
  /** 文件 → 读取失败诊断；失败文件保留在列表并标记。 */
  const [readFailure, setReadFailure] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<MaterialSelection | null>(null);

  // ── 读取选中文件 ──
  useEffect(() => {
    if (!bridge || typeof bridge.readMtdDocument !== 'function') return;
    if (selectedUri === null) {
      setDocument(null);
      setReadFailure(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    bridge.readMtdDocument(selectedUri)
      .then((raw) => {
        if (cancelled) return;
        const result = raw as {
          ok: boolean;
          data?: unknown;
          diagnostics?: Array<{ code?: string; message?: string }>;
        };
        if (result.ok && result.data && isMtdDocument(result.data)) {
          setDocument(result.data);
          setReadFailure(null);
        } else {
          setDocument(null);
          const first = result.diagnostics?.[0];
          setReadFailure({
            code: first?.code ?? 'MTD_READ_FAILED',
            message: first?.message ?? 'MTD 读取失败。'
          });
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDocument(null);
        setReadFailure({
          code: 'MTD_READ_EXCEPTION',
          message: error instanceof Error ? error.message : 'MTD 读取异常。'
        });
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [bridge, selectedUri]);

  // 新文件 → 选中态回到材质本身。
  useEffect(() => {
    setSelection(null);
  }, [selectedUri]);

  const pages = useMemo(
    () => (document ? projectMaterialDocumentPages(document) : null),
    [document]
  );

  const materialLabel = useMemo(() => {
    const material = pages?.material;
    return material?.name || material?.rootElement || (selectedUri
      ? materialFileDisplayName({ sourceUri: selectedUri, relativePath: selectedUri })
      : 'material');
  }, [pages, selectedUri]);

  // 文档加载完成后把选中态落到材质（材质在左侧 Material list 是唯一默认行）。
  useEffect(() => {
    if (document && selection === null) {
      setSelection({ kind: 'material', label: materialLabel });
    }
  }, [document, selection, materialLabel]);

  const properties = pages?.properties.properties ?? [];
  const textureRefs = pages?.textureReferences.textureRefs ?? [];
  const propertyRows = useMemo(() => materialPropertyRows(properties), [properties]);

  const visiblePropertyRows = propertyRows.slice(0, PROPERTY_RENDER_LIMIT);
  const propertyTruncation = formatListTruncation({
    total: propertyRows.length,
    shown: visiblePropertyRows.length,
    noun: '个属性'
  });
  const visibleTextureRefs = textureRefs.slice(0, TEXTURE_REF_RENDER_LIMIT);
  const textureRefTruncation = formatListTruncation({
    total: textureRefs.length,
    shown: visibleTextureRefs.length,
    noun: '个纹理引用'
  });

  const authority = document?.authority;
  // MTD 的正常 authority 上限就是 candidate（schema 禁止推断）；只有 partial 才
  // 表示存在未识别结构，此时缺口必须对用户可见，不能伪装成完整解析。
  const isPartial = authority === 'partial';
  const unparsedGaps = document?.unparsedGaps ?? [];
  const layoutWarnings = document?.layoutWarnings ?? [];
  const visibleGaps = unparsedGaps.slice(0, 8);

  function selectMaterial(): void {
    setSelection({ kind: 'material', label: materialLabel });
  }

  function selectTextureRef(index: number, label: string): void {
    setSelection({ kind: 'texture', label, textureIndex: index });
  }

  /** Inspector 栏内容：材质 → 属性行；纹理引用 → 该引用元数据。 */
  function inspectorRows(): Array<readonly [string, string]> {
    if (selection?.kind === 'texture') {
      const ref = selection.textureIndex === undefined ? undefined : textureRefs[selection.textureIndex];
      if (!ref) return [['未识别引用', '—']];
      return [
        ['路径', ref.path ?? ''],
        ['类型', ref.type ?? ''],
        ['名称', ref.name ?? '']
      ];
    }
    const material = pages?.material;
    return [
      ['name', material?.name ?? ''],
      ['rootElement', material?.rootElement ?? ''],
      ['version', material?.version ?? ''],
      ['header', material?.header ?? ''],
      ['shaderPath', material?.shaderPath ?? ''],
      ['materialCount', String(material?.materialCount ?? 0)],
      ['formatId', material?.formatId ?? ''],
      ['authority', material?.authority ?? ''],
      ['roundTrip', document?.roundTrip?.consistent ? '一致 ✓' : '—']
    ];
  }

  return (
    <WorkbenchLayout
      label="Material 工作台"
      columns={[
        {
          id: 'files',
          title: 'File list',
          hint: `${props.files.length} files`,
          initialFlex: 0.2,
          minWidth: 150,
          children: (
            <div className="wb-list">
              {props.files.length === 0 && <p className="wb-empty">工作区中没有 MTD 文件。</p>}
              {props.files.map((file, index) => (
                <div
                  key={file.sourceUri}
                  className="wb-row"
                  {...selectableRowAttributes({
                    selected: selectedUri === file.sourceUri,
                    isTabEntry: isRowTabEntry(index, selectedUri !== null),
                    onSelect: () => setSelectedUri(file.sourceUri)
                  })}
                >
                  <span className="wb-row__name" title={file.relativePath}>
                    {materialFileDisplayName(file)}
                  </span>
                </div>
              ))}
            </div>
          )
        },
        {
          id: 'materials',
          title: 'Material list',
          ...(document ? { hint: `${document.materialCount} material` } : {}),
          initialFlex: 0.3,
          minWidth: 200,
          children: (
            <div className="wb-list">
              {selectedUri === null && <p className="wb-empty">先在最左栏选择一个 MTD 文件。</p>}
              {selectedUri !== null && loading && <p className="wb-empty">加载中…</p>}
              {selectedUri !== null && !loading && readFailure && (
                <p className="wb-empty diag-error">{readFailure.message}</p>
              )}
              {selectedUri !== null && !loading && !readFailure && document === null && (
                <p className="wb-empty">这个文件读不出来。</p>
              )}
              {selectedUri !== null && !loading && !readFailure && document !== null && (
                <>
                  <div className="wb-list__group-label">材质</div>
                  <div
                    className="wb-row"
                    {...selectableRowAttributes({
                      selected: selection?.kind === 'material',
                      isTabEntry: isRowTabEntry(0, selection !== null),
                      onSelect: selectMaterial
                    })}
                  >
                    <span className="wb-row__name" title={materialLabel}>{materialLabel}</span>
                    <span className="wb-row__meta">
                      {pages?.material.rootElement ?? 'material'} · v{pages?.material.version ?? '—'}
                    </span>
                  </div>
                  <div className="wb-list__group-label">纹理引用（{textureRefs.length}）</div>
                  {visibleTextureRefs.map((ref, refIndex) => (
                    <div
                      key={`${ref.path ?? ''}-${refIndex}`}
                      className="wb-row"
                      {...selectableRowAttributes({
                        selected: selection?.kind === 'texture' && selection.textureIndex === refIndex,
                        isTabEntry: false,
                        onSelect: () => selectTextureRef(refIndex, ref.path || `纹理引用 ${refIndex}`)
                      })}
                    >
                      <span className="wb-row__name" title={ref.path ?? ''}>{ref.path || `纹理引用 ${refIndex}`}</span>
                      <span className="wb-row__meta">{ref.type ?? '—'}</span>
                    </div>
                  ))}
                  {textureRefTruncation && (
                    <p className="muted" data-testid="mtd-texture-truncation">{textureRefTruncation}</p>
                  )}
                  {visibleTextureRefs.length === 0 && (
                    <p className="wb-empty">这个材质没有纹理引用。</p>
                  )}
                </>
              )}
            </div>
          )
        },
        {
          id: 'properties',
          title: 'Properties / Values',
          ...(selection ? { hint: selection.label } : {}),
          initialFlex: 0.5,
          minWidth: 240,
          children: (
            <div className="wb-list">
              {selection === null && <p className="wb-empty">在中间选择一个材质查看属性。</p>}
              {selection !== null && (
                <>
                  <div className="wb-list__group-label">
                    {selection.kind === 'texture' ? `纹理引用 · ${selection.label}` : `${selection.label} 属性`}
                  </div>
                  <div className="wb-props">
                    {selection.kind === 'texture'
                      ? inspectorRows().map(([name, value]) => (
                          <div key={name} className="wb-prop">
                            <span className="wb-prop__name">{name}</span>
                            <span className="wb-prop__value wb-prop__value--readonly">{value}</span>
                          </div>
                        ))
                      : visiblePropertyRows.map((row) => {
                        const nameCell = (
                          <span className="wb-prop__name">
                            {row.name}
                            {row.type ? <span className="wb-prop__enum"> · {row.type}</span> : null}
                          </span>
                        );
                        const valueCell = (
                          <span className={row.unknown
                            ? 'wb-prop__value wb-prop__value--readonly mtd-unknown-value'
                            : 'wb-prop__value wb-prop__value--readonly'}
                          >
                            {row.value}
                          </span>
                        );
                        return row.unknown ? (
                          <div key={row.id} className="wb-prop" data-testid="mtd-unknown-prop">
                            {nameCell}
                            {valueCell}
                          </div>
                        ) : (
                          <div key={row.id} className="wb-prop">
                            {nameCell}
                            {valueCell}
                          </div>
                        );
                      })}
                  </div>
                  {propertyTruncation && (
                    <p className="muted" data-testid="mtd-truncation">{propertyTruncation}</p>
                  )}
                  {isPartial && (unparsedGaps.length > 0 || layoutWarnings.length > 0) && (
                    <details className="mtd-partial" data-testid="mtd-partial-gaps">
                      <summary>
                        authority={authority} · 未识别结构 {unparsedGaps.length} 项
                        {layoutWarnings.length > 0 ? ` · 布局警告 ${layoutWarnings.length} 条` : ''}
                      </summary>
                      <ul>
                        {visibleGaps.map((gap, gapIndex) => (
                          <li key={gapIndex} className="muted">{gap}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="wb-list__group-label">写回</div>
                  <p className="wb-empty">
                    MTD 写回链尚未接通（MATERIAL-53C），当前没有属性编辑入口；未识别属性保留且只读。
                  </p>
                </>
              )}
            </div>
          )
        }
      ]}
      toolbar={
        <>
          <span className="crumb">Material · {props.files.length} files</span>
          {document && (
            <span className="muted" style={{ fontSize: 11 }}>
              {pages?.material.name ?? ''} · {document.authority}
              {document.roundTrip?.consistent ? ' · round-trip ✓' : ''}
            </span>
          )}
        </>
      }
    />
  );
}
