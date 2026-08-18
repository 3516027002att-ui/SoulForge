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
 * ── 写回（VFX-54C）──
 *
 * 已封存的 vfx-field-set 写能力只对 known-layout 开放：C# 侧（FxrNativeWriter）
 * 对 unknown node type / layout warning / Section9 非空 / Section12-14 非空
 * fail-closed。本组件用 fxrWriteBlockReasons 镜像同一门禁，在这些条件下预先
 * 禁用编辑控件并给原因，而不是等 commit 失败。unknown node/host 保持
 * blocked/只读，不给字段含义假数据。Section11 值是混合 int/float 位模式的
 * int32（无 schema），编辑按不透明 int32 处理，不据值做类型推断。
 *
 * ── 失败 ──
 *
 * 读取失败的文件保留在文件列表并标记失败（对照 Smithbox 的「失败即移除」，
 * 本项目不照抄：硬约束要求 failed 必须返回结构化诊断），内容栏给出原因。
 * 写回失败不触发 document 清空：保留已读节点树，显示 diagnostics + 回滚提示。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  isFxrDocument,
  projectFxrDocumentPages,
  type Diagnostic,
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
  /**
   * 测试 seam：renderer-unit 是 SSR（effect 不跑），读取结果直接注入初值
   * （生产不传）。只做 document 初值，不构成第二套数据源。
   */
  initialDocument?: FxrDocument | null;
  /** 测试 seam：SSR 下选中态直接注入初值（生产不传）。 */
  initialSelection?: VfxSelection | null;
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
/** 每个值数组可编辑条目的渲染上限（大数组不能一次全渲，超限报未显示数）。 */
const EDIT_VALUE_RENDER_LIMIT = 32;

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

export interface VfxSelection {
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

// ── VFX-54C：vfx-field-set 写回 —— 结构性地址 / 已知布局门 / 提交结果 ──
// container 取值以 C# FxrNativeWriter 为准：'host' | 'property' | 'section8'
// （Section11 值数组所在的三类容器），与 vfxBridgeCommit.VfxFieldContainer 一致。

/** vfx-field-set 的目标容器（C# 侧同一字符串，见 FxrNativeWriter）。 */
export type VfxFieldContainer = 'host' | 'property' | 'section8';

/** 一条 vfx-field-set 的结构性路径：与 read 信封的下标一一对应。 */
export interface VfxEditTarget {
  container: VfxFieldContainer;
  /** host 在 fields.hosts[] 收集序中的下标。 */
  hostIndex: number;
  /** property 在 host.properties[] 连续序中的下标（container=host 时省略）。 */
  propertyIndex?: number;
  /** property 的 section8 下标（container=section8 时需要）。 */
  section8Index?: number;
  /** 容器 Section11 值数组下标。 */
  valueIndex: number;
}

/** 稳定键：一条可编辑值在 UI 里的唯一身份（draft state 与 testid 共用）。 */
export function vfxEditTargetKey(target: VfxEditTarget): string {
  return [
    target.container,
    target.hostIndex,
    target.propertyIndex ?? '-',
    target.section8Index ?? '-',
    target.valueIndex
  ].join(':');
}

/** 把一次 UI 编辑意图编译成 preload 接受的 vfx-field-set mutation。 */
export function buildVfxFieldSetMutation(
  target: VfxEditTarget,
  value: number
): {
  mutation: 'vfx-field-set';
  address: {
    container: VfxFieldContainer;
    hostIndex: number;
    propertyIndex?: number;
    section8Index?: number;
    valueIndex: number;
  };
  value: number;
} {
  return {
    mutation: 'vfx-field-set',
    address: {
      container: target.container,
      hostIndex: target.hostIndex,
      ...(target.propertyIndex !== undefined ? { propertyIndex: target.propertyIndex } : {}),
      ...(target.section8Index !== undefined ? { section8Index: target.section8Index } : {}),
      valueIndex: target.valueIndex
    },
    value
  };
}

/**
 * Section11 值是无 schema 的 32 位位模式。C# 侧接受 int32 十进制与 uint32 十进制
 * （0x80000000..0xFFFFFFFF 按 int64 读后截断成位模式），合法输入区间是
 * [-2^31, 2^32-1]；不据值做类型推断（混合 int/float 位模式，不知道是哪种）。
 */
export function isVfxFieldSetValue(value: number): boolean {
  return Number.isInteger(value) && value >= -2_147_483_648 && value <= 4_294_967_295;
}

/** fail-closed 门（C# FxrNativeWriter.EnsureKnownLayout 的镜像）：任一理由都禁写。 */
export interface FxrWriteBlockReason {
  code: string;
  message: string;
}

export function fxrWriteBlockReasons(document: FxrDocument): FxrWriteBlockReason[] {
  const reasons: FxrWriteBlockReason[] = [];
  const gaps = document.unparsedGaps ?? [];
  const warnings = document.layoutWarnings ?? [];
  if (warnings.length > 0) {
    reasons.push({
      code: 'layout-warnings-present',
      message: `文件存在 ${warnings.length} 条布局警告（数据可疑，布局可能与已登记形态不同）。`
    });
  }
  const unknownTypes = gaps.filter(
    (gap) => gap.startsWith('unknown-type:') || gap.startsWith('unexpected-type:')
  );
  if (unknownTypes.length > 0) {
    reasons.push({
      code: 'unknown-node-types',
      message: `存在 ${unknownTypes.length} 个未识别的 node type（unknown/unexpected-type gap）。`
    });
  }
  if (gaps.some((gap) => gap.startsWith('section9-not-verified'))) {
    reasons.push({
      code: 'section9-not-verified',
      message: 'Section9 布局从未在真实样本验证，拒绝写回。'
    });
  }
  if (gaps.some((gap) => gap.startsWith('section12-14:opaque-int-array'))) {
    reasons.push({
      code: 'section12-14-nonempty',
      message: 'Section12-14 非空布局未验证，拒绝写回。'
    });
  }
  return reasons;
}

/** 一次 vfx-field-set 提交的结果（RendererSaveResult 的 UI 子集）。 */
export interface VfxCommitOutcome {
  ok: boolean;
  changedFiles?: string[];
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

/** 提交结果 → 提示内容（纯函数，可单测）。 */
export function fxrCommitNotice(
  outcome: VfxCommitOutcome
): { kind: 'success' | 'failure'; title: string; lines: string[] } {
  if (outcome.ok) {
    return { kind: 'success', title: '写回成功，已重新读取。', lines: [] };
  }
  return {
    kind: 'failure',
    title: 'FXR 写回失败（vfx-field-set 未生效）。',
    lines: [
      ...outcome.diagnostics.map((d) => `${d.code}：${d.message}`),
      '如已部分落盘将由 Patch Engine 回滚；已读节点树保留，未清空。'
    ]
  };
}

/** 写回结果提示条（success / failure + 回滚提示）。 */
export function VfxCommitNotice({ outcome }: { outcome: VfxCommitOutcome }): ReactElement {
  const notice = fxrCommitNotice(outcome);
  return (
    <div className="wb-notice" data-testid="vfx-commit-notice">
      <span className={notice.kind === 'success' ? 'muted' : 'diag-error'}>{notice.title}</span>
      {notice.lines.map((line, index) => (
        <span key={index} className="muted">{line}</span>
      ))}
    </div>
  );
}

/** 单条可编辑值的一行：int32 输入框 + 写回按钮（known-layout 才可提交）。 */
interface FxrValueEditorRowProps {
  target: VfxEditTarget;
  label: string;
  value: number;
  /** fail-closed：文档不满足已知布局门时禁用。 */
  disabled: boolean;
  /** 提交进行中：禁用重复提交。 */
  committing: boolean;
  draft: string;
  onDraft: (key: string, raw: string) => void;
  onCommit: (target: VfxEditTarget, raw: string) => void;
}

function FxrValueEditorRow(props: FxrValueEditorRowProps): ReactElement {
  const key = vfxEditTargetKey(props.target);
  const raw = props.draft !== '' ? props.draft : String(props.value);
  const invalid = !isVfxFieldSetValue(Number(raw));
  return (
    <div className="wb-prop" data-testid={`vfx-field-${key}`}>
      <span className="wb-prop__name">{props.label}</span>
      <span className="wb-prop__value">
        <input
          type="number"
          step={1}
          inputMode="numeric"
          data-testid={`vfx-value-input-${key}`}
          aria-label={props.label}
          value={raw}
          disabled={props.disabled || props.committing}
          onChange={(e) => props.onDraft(key, e.target.value)}
        />
        <button
          type="button"
          className="vfx-commit"
          data-testid={`vfx-value-submit-${key}`}
          disabled={props.disabled || props.committing || invalid}
          onClick={() => props.onCommit(props.target, raw)}
        >
          {props.committing ? '写回中' : '写回'}
        </button>
        {props.disabled && <span className="muted">（禁用）</span>}
      </span>
    </div>
  );
}

export function VfxWorkbenchPanel(props: VfxWorkbenchPanelProps): ReactElement {
  const bridge = getRendererBridge();

  const [selectedUri, setSelectedUri] = useState<string | null>(props.initialUri ?? null);
  /** 选中文件的读取结果；null 表示未选或失败。 */
  const [document, setDocument] = useState<FxrDocument | null>(props.initialDocument ?? null);
  /** 文件 → 读取失败诊断；失败文件保留在列表并标记。 */
  const [readFailure, setReadFailure] = useState<{ code: string; message: string } | null>(null);
  /** S24：选中文件是 ffxbnd 效果库时的 .fxr 子项清单（逻辑名）。null = 未加载/非容器。 */
  const [fxrEntries, setFxrEntries] = useState<string[] | null>(null);
  /** S24：当前打开的子项（ffxbnd 时）。null = 打开容器第一个子项/裸 .fxr。 */
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<VfxSelection | null>(props.initialSelection ?? null);
  /** VFX-54C：值编辑草稿（key = vfxEditTargetKey；未提交前保留用户输入）。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** 提交进行中：期间禁用重复提交。 */
  const [committing, setCommitting] = useState(false);
  /** 最近一次 vfx-field-set 提交结果；null = 还没有提交过。 */
  const [commitOutcome, setCommitOutcome] = useState<VfxCommitOutcome | null>(null);
  /** 写回成功后自增，驱动 read effect 重新读取（ok=true → 重读）。 */
  const [reloadKey, setReloadKey] = useState(0);

  // ── 读取选中文件（ffxbnd 容器时按子项精确读取）──
  useEffect(() => {
    if (!bridge || typeof bridge.readFxrDocument !== 'function') return;
    if (selectedUri === null) {
      setDocument(null);
      setReadFailure(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    bridge.readFxrDocument(selectedUri, selectedEntry ?? undefined)
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
  }, [bridge, selectedUri, selectedEntry, reloadKey]);

  // 新文件 → 选中态回到文件级统计，清空写回态。
  useEffect(() => {
    setSelection(null);
    setDrafts({});
    setCommitOutcome(null);
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
  const selectedHostUnknown = selectedHost !== null
    && unknownTypes.section6.has(selectedHost.typeId);

  const fileLabel = selectedUri
    ? vfxFileDisplayName({ sourceUri: selectedUri, relativePath: selectedUri })
    : null;

  function selectFile(uri: string): void {
    setSelectedUri(uri);
    setSelectedEntry(null);
    // S24：ffxbnd 效果库 → 先列 .fxr 子项（一条失败不再整包判死）。
    const isBundle = /\.ffxbnd(\.dcx)?$/i.test(uri);
    setFxrEntries(null);
    if (isBundle && bridge && typeof bridge.listFxrEntries === 'function') {
      void bridge.listFxrEntries(uri).then((raw) => {
        const result = raw as { ok?: boolean; data?: { entries?: string[] } };
        if (result.ok && Array.isArray(result.data?.entries)) {
          setFxrEntries(result.data!.entries!);
          if (result.data!.entries!.length > 0) {
            // 默认打开第一个子项：打开效果库就能看到内容。
            setSelectedEntry(result.data!.entries![0]!);
          }
        }
      }).catch(() => {
        // 列表失败：不阻断——fallback 到旧行为（容器第一条）。
      });
    }
  }

  function selectFxrEntry(entry: string): void {
    setSelectedEntry(entry);
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

  // ── VFX-54C：known-layout 写回门禁（C# FxrNativeWriter.EnsureKnownLayout 的镜像）──
  const writeBlockReasons = useMemo(
    () => (document ? fxrWriteBlockReasons(document) : []),
    [document]
  );
  const writeBlocked = writeBlockReasons.length > 0;

  const selectedHostIndex = selection?.kind === 'host' && selection.id !== undefined
    ? Number(selection.id)
    : -1;

  function setDraft(key: string, raw: string): void {
    setDrafts((prev) => ({ ...prev, [key]: raw }));
  }

  function commitFieldValue(target: VfxEditTarget, raw: string): void {
    if (!document || !selectedUri) return;
    const value = Number(raw);
    if (!isVfxFieldSetValue(value)) return;
    if (!bridge || typeof bridge.commitFxrFieldSet !== 'function') {
      setCommitOutcome({
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'FXR_WRITE_BRIDGE_UNAVAILABLE',
          message: 'FXR 写回桥接能力缺失，无法提交 vfx-field-set。'
        }]
      });
      return;
    }
    setCommitting(true);
    setCommitOutcome(null);
    bridge.commitFxrFieldSet(selectedUri, document.sourceHash, [buildVfxFieldSetMutation(target, value)])
      .then((result) => {
        if (result.ok) {
          // ok=true → 重读：自增 reloadKey 让 read effect 重新拉取文档。
          setReloadKey((k) => k + 1);
          setDrafts((prev) => {
            const next = { ...prev };
            delete next[vfxEditTargetKey(target)];
            return next;
          });
        }
        setCommitOutcome({
          ok: result.ok,
          changedFiles: result.changedFiles ?? [],
          diagnostics: result.diagnostics ?? []
        });
      })
      .catch((error: unknown) => {
        // ok=false → 显示 diagnostics + 回滚提示，不清空已读节点树（不触碰 document）。
        setCommitOutcome({
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FXR_COMMIT_EXCEPTION',
            message: error instanceof Error ? error.message : 'FXR 写回异常。'
          }]
        });
      })
      .finally(() => setCommitting(false));
  }

  /** 一个值数组的可编辑行（known host 下按 container 编译结构性地址）。 */
  function renderValueRows(options: {
    container: VfxFieldContainer;
    hostIndex: number;
    propertyIndex?: number;
    section8Index?: number;
    values: number[];
    valuesTruncated: boolean;
    labelPrefix: string;
  }): ReactElement {
    const shownValues = options.values.slice(0, EDIT_VALUE_RENDER_LIMIT);
    return (
      <>
        {shownValues.map((value, valueIndex) => {
          const target: VfxEditTarget = {
            container: options.container,
            hostIndex: options.hostIndex,
            ...(options.propertyIndex !== undefined ? { propertyIndex: options.propertyIndex } : {}),
            ...(options.section8Index !== undefined ? { section8Index: options.section8Index } : {}),
            valueIndex
          };
          const key = vfxEditTargetKey(target);
          return (
            <FxrValueEditorRow
              key={key}
              target={target}
              label={`${options.labelPrefix}${valueIndex}]`}
              value={value}
              disabled={writeBlocked}
              committing={committing}
              draft={drafts[key] ?? ''}
              onDraft={setDraft}
              onCommit={commitFieldValue}
            />
          );
        })}
        {options.values.length > EDIT_VALUE_RENDER_LIMIT && (
          <p className="muted" style={{ fontSize: 10, padding: '0 10px' }}>
            前 {EDIT_VALUE_RENDER_LIMIT} 个可编辑；其余 {options.values.length - EDIT_VALUE_RENDER_LIMIT} 个未显示。
          </p>
        )}
        {options.valuesTruncated && (
          <p className="muted" style={{ fontSize: 10, padding: '0 10px' }}>
            该值数组上游已截断（valuesTruncated），只显示前 {shownValues.length} 个。
          </p>
        )}
      </>
    );
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
                <div key={file.sourceUri}>
                  <div
                    className="wb-row"
                    {...selectableRowAttributes({
                      selected: selectedUri === file.sourceUri && selectedEntry === null,
                      isTabEntry: isRowTabEntry(index, selectedUri !== null),
                      onSelect: () => selectFile(file.sourceUri)
                    })}
                  >
                    <span className="wb-row__name" title={file.relativePath}>
                      {vfxFileDisplayName(file)}
                    </span>
                  </div>
                  {/* S24：ffxbnd 效果库展开 .fxr 子项列表，一条失败只红那一条。 */}
                  {selectedUri === file.sourceUri && fxrEntries !== null && (
                    <div className="vfx-entries" data-testid="vfx-ffxbnd-entries">
                      {fxrEntries.length === 0 && (
                        <p className="wb-empty">效果库里没有 .fxr 子项。</p>
                      )}
                      {fxrEntries.map((entry) => (
                        <div
                          key={entry}
                          className="wb-row wb-row--child"
                          {...selectableRowAttributes({
                            selected: selectedEntry === entry,
                            isTabEntry: false,
                            onSelect: () => selectFxrEntry(entry)
                          })}
                        >
                          <span className="wb-row__name" title={entry}>
                            {entry.replace(/\.fxr$/i, '')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
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
                  {selectedHost && (
                    <>
                      {selectedHostUnknown && (
                        <div className="wb-notice" data-testid="vfx-unknown-host-block">
                          <span className="diag-warn">
                            该 host 类型未识别（unknown-type:section6:{selectedHost.typeId}）
                          </span>
                          <span className="muted">
                            不提供该类型的字段含义数据；下方为已解析的原始结构字段。
                          </span>
                        </div>
                      )}
                      {writeBlocked && (
                        <div className="wb-notice" data-testid="vfx-write-blocked">
                          <span className="diag-warn">该文件不满足已知布局门，写回已预先禁用。</span>
                          {writeBlockReasons.map((reason) => (
                            <span
                              key={reason.code}
                              className="muted"
                              data-testid={`vfx-write-block-${reason.code}`}
                            >
                              {reason.code}：{reason.message}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="wb-list__group-label">属性（Section7 · {selectedHost.properties.length}）</div>
                      {visibleProperties.length === 0 && (
                        <p className="wb-empty">这个 host 没有可显示的属性样本。</p>
                      )}
                      {visibleProperties.map((prop, propIndex) => {
                        const propUnknown = unknownTypes.section7.has(prop.typeId);
                        const editable = !selectedHostUnknown && !propUnknown;
                        return (
                          <div key={`${prop.typeId}-${propIndex}`}>
                            <div
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
                            {editable && (
                              <>
                                {renderValueRows({
                                  container: 'property',
                                  hostIndex: selectedHostIndex,
                                  propertyIndex: propIndex,
                                  values: prop.values,
                                  valuesTruncated: prop.valuesTruncated,
                                  labelPrefix: `property ${prop.typeId}[`
                                })}
                                {prop.section8.map((section8, section8Index) => (
                                  <div key={`${prop.typeId}-s8-${section8Index}`}>
                                    <div className="wb-prop">
                                      <span className="wb-prop__name">
                                        section8 {section8.typeId} · s11×{section8.section11Count}
                                        <span className="wb-prop__enum"> · {section8.section9.length} s9</span>
                                      </span>
                                    </div>
                                    {renderValueRows({
                                      container: 'section8',
                                      hostIndex: selectedHostIndex,
                                      propertyIndex: propIndex,
                                      section8Index,
                                      values: section8.values,
                                      valuesTruncated: section8.valuesTruncated,
                                      labelPrefix: `section8[${section8Index}]`
                                    })}
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        );
                      })}
                      {!selectedHostUnknown && (
                        <>
                          <div className="wb-list__group-label">host Section11 值（container=host）</div>
                          {renderValueRows({
                            container: 'host',
                            hostIndex: selectedHostIndex,
                            values: selectedHost.values,
                            valuesTruncated: selectedHost.valuesTruncated,
                            labelPrefix: 'host['
                          })}
                        </>
                      )}
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
                  <div className="wb-list__group-label">写回（vfx-field-set）</div>
                  {commitOutcome && <VfxCommitNotice outcome={commitOutcome} />}
                  {selectedHost && !selectedHostUnknown && !writeBlocked && (
                    <p className="muted" style={{ fontSize: 10, padding: '0 10px' }}>
                      Section11 值是混合 int/float 位模式的 int32（无 schema），按不透明
                      int32 编辑，可输入 -2147483648…4294967295。
                    </p>
                  )}
                  {!selectedHost && (
                    <p className="wb-empty">选中一个粒子（host）后即可编辑其数值字段。</p>
                  )}
                  {writeBlocked && (
                    <p className="muted" style={{ fontSize: 10, padding: '0 10px' }}>
                      已知布局门未满足时编辑控件为禁用态，不做假写回。
                    </p>
                  )}
                </>
              )}
            </div>
          )
        }
      ]}
    />
  );
}
