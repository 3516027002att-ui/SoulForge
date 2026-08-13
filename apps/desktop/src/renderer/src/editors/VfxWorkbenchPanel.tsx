/**
 * VFX-54B：Smithbox-style VFX 工作台（§10.5 / §2.5）。
 *
 * 三栏：`Effect / Particle list | 真实预览 | Inspector`。
 *
 * ── 层级 ──
 *
 * FXR3 单文件 = 单 effect。数据源是 VFX-54A 的 read-fxr-document envelope
 * （FxrDocument），经 projectFxrDocumentPages 投影出 effect / nodes / fields
 * 三页，renderer 不维护第二套 native parser。
 *
 *   - effect page：文档头 + Section4 递归节点树（effect 节点）；
 *   - nodes page：全部 Section4 节点按 type 聚合；
 *   - fields page：Section6 host（FFXDrawEntityHost，粒子/draw entity）及其属性树。
 *
 * 左栏按「文件 → Effect 节点树 → Particles（Section6 host）」组织；右栏 Inspector
 * 显示选中项的结构字段。未知 node 只显示已解析的原始结构字段 + 明确的状态标记，
 * 不编造字段含义（硬约束：unknown 必须区分、partial 不能伪装成完整解析）。
 *
 * ── 真实预览列是诚实空态 ──
 *
 * §10.5 要求 `真实预览（没有就不要假 viewport）`。本卡没有粒子实时渲染器
 * （VFX-54A 只做 read，无渲染后端），因此中栏不渲染 3D viewport、粒子回放或
 * 假 graph，只给出诚实空态 + 文档状态。preview isolation：该栏内容只随文件变化，
 * 不随节点/粒子选择变化——选中任何条目都不会凭空出现预览。
 *
 * ── known / unknown node ──
 *
 * 未知类型的权威信号是 C# 解析器在 unparsedGaps 里登记的
 * `unknown-type:section4:<id>` / `unknown-type:section6:<id>` /
 * `unknown-type:section7:<id>`。本组件从 gap 字符串解析出未知类型集合
 * （parseUnknownFxrTypes），据此给行加「未知类型」标记；未知行可选中，
 * 但 Inspector 明确标 blocked 并只给已解析的原始结构字段，不给字段含义假数据。
 *
 * ── 失败 ──
 *
 * 读取失败的文件保留在文件列表并标记失败（对照 Smithbox 的「失败即移除」，
 * 本项目不照抄：硬约束要求 failed 必须返回结构化诊断），内容栏给出原因。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  isFxrDocument,
  projectFxrDocumentPages,
  type FxrDocument,
  type FxrHostWire,
  type FxrNodeWire
} from '@soulforge/shared';
import { formatListTruncation } from '../format/uiText.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';

/** File list 栏的一个条目：工作区索引里的 FXR 文件。 */
export interface VfxFileView {
  /** 稳定标识（文件浏览器与索引共用）。 */
  sourceUri: string;
  /** 物理相对路径（仅进 title/details，不做显示名）。 */
  relativePath: string;
}

export interface VfxWorkbenchPanelProps {
  /** 该域的全部 FXR 文件（files）。 */
  files: VfxFileView[];
  /** 打开时默认选中的文件（当前选中资源）。 */
  initialUri?: string;
}

/** Effect 节点树扁平化后的一行（树太大不能一次全渲，见 NODE_RENDER_LIMIT）。 */
export interface FlatFxrNode {
  /** 树路径，如 "0" / "0.2" / "1.0.3"，稳定 identity。 */
  id: string;
  /** 树深度（0 = 根），驱动缩进。 */
  depth: number;
  node: FxrNodeWire;
}

/** 属性列表渲染上限（硬约束 17：大表不能一次全渲，超限必须报未显示数）。 */
const NODE_RENDER_LIMIT = 500;
/** 粒子（host）渲染上限。 */
const HOST_RENDER_LIMIT = 200;
/** 每个 host 的属性渲染上限。 */
const PROPERTY_RENDER_LIMIT = 200;
/** 每个属性值的预览条数（值是 Section11 不透明 int 数组，只需摘要）。 */
const VALUE_PREVIEW_LIMIT = 8;

/** FXR 显示名：去 .fxr/.fxr.dcx，物理路径只在 title/details。 */
export function vfxFileDisplayName(file: VfxFileView): string {
  const base = file.relativePath.split(/[\\/]/).pop() ?? file.relativePath;
  return base.replace(/\.fxr(\.dcx)?$/i, '');
}

/** 从 unparsedGaps 解析未知类型集合（权威信号来自 C# 解析器的 gap 登记）。 */
export interface FxrUnknownTypeSets {
  section4: Set<number>;
  section6: Set<number>;
  section7: Set<number>;
}

export function parseUnknownFxrTypes(gaps: string[]): FxrUnknownTypeSets {
  const section4 = new Set<number>();
  const section6 = new Set<number>();
  const section7 = new Set<number>();
  for (const gap of gaps ?? []) {
    const m4 = /^unknown-type:section4:(\d+)$/.exec(gap);
    if (m4) {
      section4.add(Number(m4[1]));
      continue;
    }
    const m6 = /^unknown-type:section6:(\d+)$/.exec(gap);
    if (m6) {
      section6.add(Number(m6[1]));
      continue;
    }
    const m7 = /^unknown-type:section7:(\d+)$/.exec(gap);
    if (m7) {
      section7.add(Number(m7[1]));
    }
  }
  return { section4, section6, section7 };
}

/** 递归节点树扁平化：给每个节点稳定路径 id 与深度（纯函数，可单测）。 */
export function flattenFxrNodes(nodes: FxrNodeWire[]): FlatFxrNode[] {
  const out: FlatFxrNode[] = [];
  function walk(list: FxrNodeWire[], depth: number, prefix: string): void {
    list.forEach((node, index) => {
      const id = prefix === '' ? String(index) : `${prefix}.${index}`;
      out.push({ id, depth, node });
      if (node.children.length > 0) walk(node.children, depth + 1, id);
    });
  }
  walk(nodes, 0, '');
  return out;
}

type VfxSelectionKind = 'file' | 'node' | 'host';

interface VfxSelection {
  kind: VfxSelectionKind;
  /** node 时为树路径 id；host 时为 fields.hosts 数组索引。 */
  id?: string;
  /** 选中行 label（Inspector 标题）。 */
  label: string;
}

/** 属性值摘要：只显示前 N 个 int，超限给省略号。 */
export function fxrValuePreview(values: number[], limit: number): string {
  if (values.length === 0) return '—';
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown}, …` : shown;
}

export function VfxWorkbenchPanel(props: VfxWorkbenchPanelProps): ReactElement {
  const bridge = getRendererBridge();

  const [selectedUri, setSelectedUri] = useState<string | null>(props.initialUri ?? null);
  /** 选中文件的读取结果；null 表示未选或失败。 */
  const [document, setDocument] = useState<FxrDocument | null>(null);
  /** 文件 → 读取失败诊断；失败文件保留在列表并标记。 */
  const [readFailure, setReadFailure] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<VfxSelection | null>(null);

  // ── 读取选中文件 ──
  useEffect(() => {
    if (!bridge || typeof bridge.readFxrDocument !== 'function') return;
    if (selectedUri === null) {
      setDocument(null);
      setReadFailure(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    bridge.readFxrDocument(selectedUri)
      .then((raw) => {
        if (cancelled) return;
        const result = raw as {
          ok: boolean;
          data?: unknown;
          diagnostics?: Array<{ code?: string; message?: string }>;
        };
        if (result.ok && result.data && isFxrDocument(result.data)) {
          setDocument(result.data);
          setReadFailure(null);
        } else {
          setDocument(null);
          const first = result.diagnostics?.[0];
          setReadFailure({
            code: first?.code ?? 'FXR_READ_FAILED',
            message: first?.message ?? 'FXR 读取失败。'
          });
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDocument(null);
        setReadFailure({
          code: 'FXR_READ_EXCEPTION',
          message: error instanceof Error ? error.message : 'FXR 读取异常。'
        });
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [bridge, selectedUri]);

  // 新文件 → 选中态回到文件级统计。
  useEffect(() => {
    setSelection(null);
  }, [selectedUri]);

  const pages = useMemo(
    () => (document ? projectFxrDocumentPages(document) : null),
    [document]
  );

  // 文档加载完成后把选中态落到文件级统计（文件在左栏是唯一默认行）。
  useEffect(() => {
    if (document && selection === null) {
      setSelection({ kind: 'file', label: '文件统计' });
    }
  }, [document, selection]);

  const unknownTypes = useMemo(
    () => parseUnknownFxrTypes(document?.unparsedGaps ?? []),
    [document]
  );

  const rootNodes = pages?.effect.nodes ?? [];
  const flatNodes = useMemo(() => flattenFxrNodes(rootNodes), [rootNodes]);
  const visibleFlatNodes = flatNodes.slice(0, NODE_RENDER_LIMIT);
  const nodeTruncation = formatListTruncation({
    total: flatNodes.length,
    shown: visibleFlatNodes.length,
    noun: '个节点'
  });

  const hosts: FxrHostWire[] = pages?.fields.hosts ?? [];
  const visibleHosts = hosts.slice(0, HOST_RENDER_LIMIT);
  const hostTruncation = formatListTruncation({
    total: hosts.length,
    shown: visibleHosts.length,
    noun: '个粒子（Section6 host）'
  });

  const isPartial = document?.authority === 'partial';
  const unparsedGaps = document?.unparsedGaps ?? [];
  const layoutWarnings = document?.layoutWarnings ?? [];
  const visibleGaps = unparsedGaps.slice(0, 8);
  const visibleWarnings = layoutWarnings.slice(0, 8);

  const selectedNode = selection?.kind === 'node' && selection.id !== undefined
    ? (flatNodes.find((item) => item.id === selection.id) ?? null)
    : null;
  const selectedHost = selection?.kind === 'host' && selection.id !== undefined
    ? (hosts[Number(selection.id)] ?? null)
    : null;
  const selectedNodeUnknown = selectedNode !== null
    && unknownTypes.section4.has(selectedNode.node.typeId);

  const fileLabel = selectedUri
    ? vfxFileDisplayName({ sourceUri: selectedUri, relativePath: selectedUri })
    : null;

  function selectFile(uri: string): void {
    setSelectedUri(uri);
  }

  function selectNode(nodeId: string): void {
    const found = flatNodes.find((item) => item.id === nodeId);
    if (!found) return;
    const known = !unknownTypes.section4.has(found.node.typeId);
    setSelection({
      kind: 'node',
      id: nodeId,
      label: `type ${found.node.typeId}${known ? '' : '（未知类型）'}`
    });
  }

  function selectHost(index: number): void {
    const host = hosts[index];
    if (!host) return;
    const known = !unknownTypes.section6.has(host.typeId);
    setSelection({
      kind: 'host',
      id: String(index),
      label: `host ${host.typeId}${known ? '' : '（未知类型）'}`
    });
  }

  function selectFileStats(): void {
    setSelection({ kind: 'file', label: '文件统计' });
  }

  /** Inspector 内容（按选中项）。 */
  function inspectorRows(): Array<readonly [string, string]> {
    if (selection?.kind === 'node' && selectedNode) {
      const node = selectedNode.node;
      const known = !unknownTypes.section4.has(node.typeId);
      return [
        ['typeId', String(node.typeId)],
        ['状态', known ? '已知类型' : '未知类型（未识别，不给字段含义假数据）'],
        ['childCount', String(node.childCount)],
        ['drawEntityCount', String(node.drawEntityCount)],
        ['drawEntityRefCount', String(node.drawEntityRefCount)],
        ['childrenTruncated', node.childrenTruncated ? '是（上游已截断）' : '否']
      ];
    }
    if (selection?.kind === 'host' && selectedHost) {
      const host = selectedHost;
      const known = !unknownTypes.section6.has(host.typeId);
      return [
        ['typeId', String(host.typeId)],
        ['状态', known ? '已知类型' : '未知类型（未识别，不给字段含义假数据）'],
        ['unk02', `0x${host.unk02.toString(16)}`],
        ['unk03', `0x${host.unk03.toString(16)}`],
        ['unk04', String(host.unk04)],
        ['section11Count', String(host.section11Count)],
        ['section10Count', String(host.section10Count)],
        ['section7Count', String(host.section7Count)],
        ['properties', `${host.properties.length} 项`],
        ['values', `${host.values.length} 个（Section11 不透明 int 数组）`]
      ];
    }
    // file / 未选中：文件级统计。
    return [
      ['format', document?.format ?? 'FXR3'],
      ['version', String(document?.version ?? '—')],
      ['resourceId', document?.resourceId !== undefined
        ? `0x${document.resourceId.toString(16)}`
        : '—'],
      ['rootNodeCount', String(document?.rootNodeCount ?? 0)],
      ['totalNodeCount', String(document?.totalNodeCount ?? 0)],
      ['hostCount', String(document?.hostCount ?? 0)],
      ['propertyCount', String(document?.propertyCount ?? 0)],
      ['section11ValueCount', String(document?.section11ValueCount ?? 0)],
      ['roundTrip', document?.roundTrip?.consistent ? '一致 ✓' : '—'],
      ['authority', document?.authority ?? '—']
    ];
  }

  const visibleProperties = selectedHost
    ? selectedHost.properties.slice(0, PROPERTY_RENDER_LIMIT)
    : [];

  return (
    <WorkbenchLayout
      label="VFX 工作台"
      columns={[
        {
          id: 'effect-particles',
          title: 'Effect / Particle list',
          ...(document
            ? {
                hint: `${document.totalNodeCount} nodes · ${document.hostCount} particles`
              }
            : { hint: `${props.files.length} files` }),
          initialFlex: 0.3,
          minWidth: 220,
          children: (
            <div className="wb-list">
              <div className="wb-list__group-label">文件（FXR）</div>
              {props.files.length === 0 && (
                <p className="wb-empty">工作区中没有 FXR 文件。</p>
              )}
              {props.files.map((file, index) => (
                <div
                  key={file.sourceUri}
                  className="wb-row"
                  {...selectableRowAttributes({
                    selected: selectedUri === file.sourceUri,
                    isTabEntry: isRowTabEntry(index, selectedUri !== null),
                    onSelect: () => selectFile(file.sourceUri)
                  })}
                >
                  <span className="wb-row__name" title={file.relativePath}>
                    {vfxFileDisplayName(file)}
                  </span>
                </div>
              ))}
              {selectedUri === null && <p className="wb-empty">先在最左栏选择一个 FXR 文件。</p>}
              {selectedUri !== null && loading && <p className="wb-empty">加载中…</p>}
              {selectedUri !== null && !loading && readFailure && (
                <>
                  <div className="wb-list__group-label">Effect 节点</div>
                  <p className="wb-empty diag-error" data-testid="vfx-read-failure">
                    {readFailure.message}
                  </p>
                  <p className="muted" style={{ fontSize: 10, padding: '0 10px' }}>
                    {readFailure.code}；其他 FXR 文件不受影响。
                  </p>
                </>
              )}
              {selectedUri !== null && !loading && !readFailure && document === null && (
                <p className="wb-empty">这个文件读不出来。</p>
              )}
              {selectedUri !== null && !loading && !readFailure && document !== null && (
                <>
                  <div className="wb-list__group-label">
                    Effect 节点（{document.effect.rootNodeCount} 根 · {flatNodes.length} 扁平）
                  </div>
                  {visibleFlatNodes.length === 0 && (
                    <p className="wb-empty">这个 effect 没有节点。</p>
                  )}
                  {visibleFlatNodes.map((item) => {
                    const unknown = unknownTypes.section4.has(item.node.typeId);
                    return (
                      <div
                        key={item.id}
                        className={unknown ? 'wb-row wb-row--unknown' : 'wb-row'}
                        {...selectableRowAttributes({
                          selected: selection?.kind === 'node' && selection.id === item.id,
                          isTabEntry: false,
                          onSelect: () => selectNode(item.id)
                        })}
                        data-testid={unknown ? 'vfx-unknown-node' : 'vfx-known-node'}
                        style={{ paddingLeft: `${10 + item.depth * 14}px` }}
                      >
                        <span className="wb-row__name">
                          {item.depth === 0 ? 'effect ' : 'node '}type {item.node.typeId}
                        </span>
                        <span className="wb-row__meta">
                          {item.node.childCount} 子 · {item.node.drawEntityCount} draw
                        </span>
                        {unknown && <span className="wb-row__meta diag-warn">未知类型</span>}
                      </div>
                    );
                  })}
                  {nodeTruncation && (
                    <p className="muted" data-testid="vfx-node-truncation">{nodeTruncation}</p>
                  )}
                  <div className="wb-list__group-label">Particles（Section6 host · {hosts.length}）</div>
                  {visibleHosts.length === 0 && (
                    <p className="wb-empty">这个 effect 没有可显示的粒子 host 样本。</p>
                  )}
                  {visibleHosts.map((host, hostIndex) => {
                    const unknown = unknownTypes.section6.has(host.typeId);
                    return (
                      <div
                        key={`${host.typeId}-${hostIndex}`}
                        className={unknown ? 'wb-row wb-row--unknown' : 'wb-row'}
                        {...selectableRowAttributes({
                          selected: selection?.kind === 'host' && selection.id === String(hostIndex),
                          isTabEntry: false,
                          onSelect: () => selectHost(hostIndex)
                        })}
                        data-testid={unknown ? 'vfx-unknown-host' : 'vfx-known-host'}
                      >
                        <span className="wb-row__name">host {host.typeId}</span>
                        <span className="wb-row__meta">{host.section7Count} 属性</span>
                        {unknown && <span className="wb-row__meta diag-warn">未知类型</span>}
                      </div>
                    );
                  })}
                  {hostTruncation && (
                    <p className="muted" data-testid="vfx-host-truncation">{hostTruncation}</p>
                  )}
                </>
              )}
            </div>
          )
        },
        {
          id: 'preview',
          title: '真实预览',
          ...(document ? { hint: document.authority } : {}),
          initialFlex: 0.3,
          minWidth: 200,
          children: (
            <div className="wb-list">
              {/* 诚实空态：没有真实粒子渲染器，不渲染假 viewport / 假 graph。
                  preview isolation：本栏内容只随文件变化，不随节点/粒子选择变化。 */}
              <p className="wb-empty" data-testid="vfx-preview-empty">
                FXR 粒子当前没有可用的实时预览渲染器。
              </p>
              <p className="muted" style={{ fontSize: 11, padding: '0 10px' }}>
                本工作台不渲染伪造的 3D viewport、粒子回放或假 graph。选中节点/粒子的
                结构详情见右侧 Inspector。
              </p>
              {document && (
                <>
                  <div className="wb-list__group-label">文档状态</div>
                  <div className="wb-props">
                    <div className="wb-prop">
                      <span className="wb-prop__name">authority</span>
                      <span className="wb-prop__value wb-prop__value--readonly">
                        {document.authority}
                      </span>
                    </div>
                    <div className="wb-prop">
                      <span className="wb-prop__name">roundTrip</span>
                      <span className="wb-prop__value wb-prop__value--readonly">
                        {document.roundTrip?.consistent ? '一致 ✓' : '不一致'}
                      </span>
                    </div>
                    <div className="wb-prop">
                      <span className="wb-prop__name">Section11 值</span>
                      <span className="wb-prop__value wb-prop__value--readonly">
                        {document.section11ValueCount} 个（不透明 int 数组，无 schema）
                      </span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )
        },
        {
          id: 'inspector',
          title: 'Inspector',
          ...(selection ? { hint: selection.label } : {}),
          initialFlex: 0.4,
          minWidth: 280,
          children: (
            <div className="wb-list">
              {selectedUri === null && <p className="wb-empty">先在最左栏选择一个 FXR 文件。</p>}
              {selectedUri !== null && loading && <p className="wb-empty">加载中…</p>}
              {selectedUri !== null && !loading && readFailure && (
                <p className="wb-empty diag-error">{readFailure.message}</p>
              )}
              {selectedUri !== null && !loading && !readFailure && document === null && (
                <p className="wb-empty">这个文件读不出来。</p>
              )}
              {selectedUri !== null && !loading && !readFailure && document !== null && (
                <>
                  <div className="wb-list__group-label">
                    {selection ? selection.label : '文件统计'}
                  </div>
                  {/* 未知 node：明确标 blocked，不给假字段含义。原始结构字段仍可看
                      （它们是解析出来的真实值，但代表什么含义未知）。 */}
                  {selectedNodeUnknown && (
                    <div className="wb-notice" data-testid="vfx-unknown-node-block">
                      <span className="diag-warn">
                        该节点类型未识别（unknown-type:section4:{selectedNode?.node.typeId}）
                      </span>
                      <span className="muted">
                        不提供该类型的字段含义数据；下方为已解析的原始结构字段。
                      </span>
                    </div>
                  )}
                  <div className="wb-props">
                    {inspectorRows().map(([name, value]) => (
                      <div key={name} className="wb-prop">
                        <span className="wb-prop__name">{name}</span>
                        <span className="wb-prop__value wb-prop__value--readonly">{value}</span>
                      </div>
                    ))}
                  </div>
                  {selectedHost && visibleProperties.length > 0 && (
                    <>
                      <div className="wb-list__group-label">属性（Section7 · {selectedHost.properties.length}）</div>
                      {visibleProperties.map((prop, propIndex) => {
                        const propUnknown = unknownTypes.section7.has(prop.typeId);
                        return (
                          <div
                            key={`${prop.typeId}-${propIndex}`}
                            className="wb-prop"
                            data-testid={propUnknown ? 'vfx-unknown-property' : 'vfx-known-property'}
                          >
                            <span className="wb-prop__name">
                              property {prop.typeId}
                              {propUnknown ? <span className="wb-prop__enum"> 未知类型</span> : null}
                              <span className="wb-prop__enum"> · s11×{prop.section11Count} · s8×{prop.section8Count}</span>
                            </span>
                            <span className="wb-prop__value wb-prop__value--readonly">
                              {fxrValuePreview(prop.values, VALUE_PREVIEW_LIMIT)}
                            </span>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {isPartial && (unparsedGaps.length > 0 || layoutWarnings.length > 0) && (
                    <details className="mtd-partial" data-testid="vfx-partial-gaps">
                      <summary>
                        authority={document.authority} · 未解析区间 {unparsedGaps.length} 项
                        {layoutWarnings.length > 0 ? ` · 布局警告 ${layoutWarnings.length} 条` : ''}
                      </summary>
                      <ul>
                        {visibleGaps.map((gap, gapIndex) => (
                          <li key={`gap-${gapIndex}`} className="muted">{gap}</li>
                        ))}
                        {visibleWarnings.map((warning, warningIndex) => (
                          <li key={`warn-${warningIndex}`} className="muted">{warning}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="wb-list__group-label">写回</div>
                  <p className="wb-empty">
                    FXR 写回链尚未接通（VFX-54C），当前为只读工作台；节点/粒子/属性不可编辑。
                  </p>
                </>
              )}
            </div>
          )
        }
      ]}
      toolbar={
        <>
          <span className="crumb">
            VFX · {document
              ? `${document.totalNodeCount} nodes · ${document.hostCount} particles`
              : (selectedUri ? fileLabel : `${props.files.length} files`)}
          </span>
          {document && (
            <span className="muted" style={{ fontSize: 11 }}>
              {fileLabel} · {document.authority}
              {document.roundTrip?.consistent ? ' · round-trip ✓' : ''}
            </span>
          )}
        </>
      }
    />
  );
}
