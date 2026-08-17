/**
 * EVENT-30B — DarkScript3 式 Event 源码工作台（S14 可编辑）。
 *
 * 布局对照 DarkScript3（§11），不是 260/320 三栏：
 *   [文档标签栏] 逻辑文档标签（EMEVD 文档，§3.4），带 dirty 标记与关闭
 *   [工具条]     查找：Ctrl+F · 保存状态（无「编译并提交」，无只读锁）
 *   [主区]       CodeMirror 6 源码占满（T4：无四钮、无 Outline/Inspector/Problems）
 *
 * S14：`$Event` 源码可编辑。Ctrl+S 直接把当前文本交给 App → main 按
 * 「反汇编形状对齐」编译成 typed mutation → Patch Engine（备份/回滚照旧），
 * UI 不提 Bridge / 补丁引擎。编不了的指令（增删、WaitFor 折叠块内容变化、
 * 未解码指令）由编译器给结构化诊断，不锁整份文档、不假成功写盘。
 *
 * Negative DOM（EVENT-30B）：Flow / Hex / Raw Bytes 不在默认 viewport；原始
 * bytes 只能经 Developer Diagnostics 打开（本面板不提供）；查找替换 / Outline /
 * Inspector / Problems 四个开关与选中节点面板、底部 dock 均不渲染。
 *
 * 数据流：renderer 不持有文件系统路径与完整 document。App 经 `pendingTab`
 * （有界 DSL 投影 + 派生 document）按资源 URI 提供标签；提交以 `EventSourceTabData`
 * 上抛，由 App 走 Bridge → Patch 管线。dirty 与编辑文本（draft）只在工作台内部，
 * 跨 tab 隔离（per-tab EditorState 缓存 undo/redo 历史）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react';
import type { EmevdEditorDocument } from '@soulforge/shared';
// 深路径 import：core 的 index 是 export * 全量导出（会把 node:path 等浏览器
// 不可用模块拉进 renderer bundle）；parseDarkScriptCall 是纯文本解析，只拉
// darkScriptCompiler 的依赖链（链上 node:crypto 由 vite alias 打桩）。
import { parseDarkScriptCall } from '@soulforge/core/dist/emevd/darkScriptCompiler.js';
import type { EmedfCompletionItem } from '@soulforge/core';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import {
  appendSourceSlices,
  emptyEventLineScan,
  indexEventLinesIncremental,
  splitSourceForFirstFrame,
  type EventLineScanState
} from '../emevd/emevdSourceMount.js';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  GutterMarker,
  drawSelection,
  dropCursor,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  type Tooltip
} from '@codemirror/view';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';

export interface EventSourceSubmitResult {
  ok: boolean;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  nextDslTemplate?: string;
}

/* ------------------------------------------------------------------ */
/*  S31 右栏词义：选中语句 → 指令名/bank:id/每个参数名+类型+当前值   */
/* ------------------------------------------------------------------ */

/** 一个用户的实参值（源码文本里解析出的数字/布尔）。 */
export interface InspectorArgValue {
  name: string;
  type: string;
  /** 当前值展示文本。'（折叠隐藏）' 表示折叠块隐藏了 conditionGroup 簿记参数。 */
  value: string;
  vararg?: boolean;
  hidden?: boolean;
}

/** 右栏里一条可展示的指令（同名指令可能命中多个 bank:id）。 */
export interface InspectorRow {
  name: string;
  bank: number;
  id: number;
  args: InspectorArgValue[];
}

export interface EventInspectorState {
  tabId: string;
  lineNumber: number;
  /** 该行属于 WaitFor( 折叠块时非空。 */
  waitFor?: boolean;
  rows: InspectorRow[];
  /** EMEDF 目录里匹配不到指令名（诚实未解码，不编）。 */
  unknownNames: string[];
  unparseable?: string;
}

/** 一行的解析结果（纯函数，可单测）。 */
export type InspectorLineResult =
  | { kind: 'call'; call: { name: string; args: Array<number | boolean> } }
  | { kind: 'wait'; predicates: Array<{ name: string; args: Array<number | boolean> }> }
  | { kind: 'none' }
  | { kind: 'unparseable'; canonical: string };

/** 真值展示：数字按反汇编格式（负零保留）。 */
function literalText(value: number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return Object.is(value, -0) ? '-0' : String(value);
}

/** 解析一条规范化调用（`Name(a, b);`）。 */
export function parseInspectorCall(canonical: string): InspectorLineResult {
  if (canonical.startsWith('$Event(') || canonical.startsWith('//')) return { kind: 'none' };
  if (canonical.startsWith('WaitFor(')) {
    const match = /^WaitFor\(\s*(.*?)\s*\)\s*;?$/.exec(canonical);
    if (!match) return { kind: 'unparseable', canonical };
    const inner = match[1]!.trim();
    if (inner === '') return { kind: 'wait', predicates: [] };
    const predicates: Array<{ name: string; args: Array<number | boolean> }> = [];
    for (const part of inner.split('&&')) {
      const call = parseDarkScriptCall(part.trim());
      if (!call) return { kind: 'unparseable', canonical };
      predicates.push(call);
    }
    return { kind: 'wait', predicates };
  }
  const call = parseDarkScriptCall(canonical);
  return call ? { kind: 'call', call } : { kind: 'unparseable', canonical };
}

/**
 * 把解析结果渲染成词义行：用 EMEDF 目录按名字匹配 bank:id 与参数定义。
 * 同名指令（不同 bank:id）全部列出；匹配不到的名字进 `unknownNames`（诚实句）。
 * conditionGroup 簿记参数在折叠块里被渲染隐藏，这里标「（折叠隐藏）」。
 */
export function buildInspectorRows(
  result: Extract<InspectorLineResult, { kind: 'call' | 'wait' }>,
  catalog: readonly EmedfCompletionItem[]
): { rows: InspectorRow[]; unknownNames: string[] } {
  const calls: Array<{ name: string; args: Array<number | boolean> }> = result.kind === 'call'
    ? [result.call]
    : result.predicates;
  const rows: InspectorRow[] = [];
  const unknownNames: string[] = [];
  for (const call of calls) {
    const defs = catalog.filter((item) => item.name === call.name);
    if (defs.length === 0) {
      unknownNames.push(call.name);
      continue;
    }
    for (const def of defs) {
      const args: InspectorArgValue[] = [];
      let valueIndex = 0;
      for (const argDef of def.args) {
        const hidden = /conditiongroup/i.test(argDef.name);
        if (hidden && call.args.length !== def.args.length) {
          // 折叠块隐藏了簿记参数：值不可见，标出来而不是猜。
          args.push({ name: argDef.name, type: argDef.type, value: '（折叠隐藏）', ...(argDef.vararg ? { vararg: true } : {}), hidden: true });
          continue;
        }
        const value = call.args[valueIndex];
        valueIndex += 1;
        args.push({
          name: argDef.name,
          type: argDef.type,
          value: value === undefined ? '—' : literalText(value),
          ...(argDef.vararg ? { vararg: true } : {})
        });
      }
      rows.push({ name: def.name, bank: def.bank, id: def.id, args });
    }
  }
  return { rows, unknownNames };
}

/**
 * 事件块的 gutter 判据行（按文档顺序）。
 *
 * 工作台只需要「第 N 个事件块是哪个 eventId、有几条未知指令」。以前它从
 * `document.events` 里 filter 出来，逼着 App 为此保留一份带指令体的投影 ——
 * 而那份投影只能来自另一次 `readEmevdDocument`（EVENT-30A envelope 默认只采样
 * 256 条指令，第 256 条之后的事件会被整段误判为「全未知」，1730 事件的真实
 * 文件里几乎每个 gutter 标记都是假的）。
 *
 * 现在改由 `readEmevdFullDocument` 的 outline 直接给：unknownCount 是主进程按
 * 完整 EMEDF registry 逐条判的，覆盖 4096 个事件（实测最大 common_func 2124）。
 */
export interface EventWarningRow {
  eventId: number;
  /** 该事件里 EMEDF 无定义的指令条数；0 表示不打标记。 */
  warnings: number;
}

/** 一个逻辑 EMEVD 文档标签的只读数据（App 侧维护，renderer 只展示与编辑）。 */
export interface EventSourceTabData {
  tabId: string;
  title: string;
  resourceUri: string;
  document: EmevdEditorDocument;
  /**
   * gutter 判据。live 文档由 outline 给（权威）；缺省时退回按 `document.events`
   * 现算，保持只读 demo / 读取失败 / 单测里手搓文档的既有行为。
   *
   * 显式带 `| undefined`：换文档时必须能把上一份判据清掉（`exactOptionalPropertyTypes`
   * 下「不写这个键」与「写 undefined」是两件事，而合并 tab 时只能后者）。
   */
  eventWarnings?: readonly EventWarningRow[] | undefined;
  sourceHash: string | null;
  live: boolean;
  dslTemplate: string | null;
  dslTemplateTruncated: boolean;
  dslTemplateTotalLines: number;
  /**
   * 源码形态：
   * - 'dark-script'：EMEDF 反汇编的 DarkScript3 式源码（S14 可编辑，不设只读锁）；
   * - 'patch-dsl'：旧 hash DSL（历史路径）；
   * - 'none'：EMEDF 缺失失败关闭（不提供伪解码，也不可编）。
   */
  sourceStyle?: 'dark-script' | 'patch-dsl' | 'none' | undefined;
}

export interface EventSourceWorkbenchPanelProps {
  /** App 最近一次打开/刷新的 EMEVD 文档；工作台按 tabId 去重后追加或更新标签。 */
  pendingTab: EventSourceTabData | null;
  onDslSubmit?: (
    tab: EventSourceTabData,
    sourceText: string
  ) => Promise<EventSourceSubmitResult>;
}

interface InternalTab extends EventSourceTabData {
  /** 用户已编辑未提交。 */
  dirty: boolean;
  /** 当前源码文本（含用户编辑）。 */
  draft: string;
  /** 该标签的 CodeMirror 状态（含 undo/redo 历史），切换标签时保留。 */
  editorState: EditorState;
  /** 增量灌入的目标全文。null 表示已齐或无需再灌。 */
  sourceFillTarget: string | null;
}

interface EventLineInfo {
  eventId: number;
  warnings: number;
}

/**
 * S10 扩展：EMEVD 脚本文档（源码区）是可引用节点。script 用 tabId（逻辑
 * URI，非本机绝对路径——main 的 decodeCiteHit 按非路径校验），label 用
 * 短标题（如 common）。框选源码任意区域即命中该文档。
 */
function citeScriptAttr(tabId: string, title: string): Record<string, string> {
  return {
    'data-cite': JSON.stringify({
      kind: 'event-script',
      library: 'event',
      script: tabId,
      label: title
    })
  };
}

/** 无 dslTemplate（只读 demo / 读取失败 / EMEDF 缺失失败关闭）时的结构化投影基线。 */
function renderSource(document: EmevdEditorDocument): string {
  const lines = [`resource ${JSON.stringify(document.resourceUri)}`];
  for (const event of document.events) {
    lines.push(`event @e:${event.anchor?.localNodeId ?? event.eventId} {`);
    lines.push(`  set id = ${event.eventId}`);
    lines.push(`  set rest = ${event.restBehavior}`);
    if (event.layer !== -1) {
      lines.push(`  // layer=${event.layer} is read-only in DSL Slice A+B`);
    }
    for (const instruction of event.instructions) {
      lines.push(
        `  // read-only ${instruction.anchor?.localNodeId ?? ''} bank=${instruction.bank} id=${instruction.id}`
      );
    }
    lines.push('}', '');
  }
  return lines.join('\n').trimEnd();
}

/**
 * R3/P4 裁定：没 EMEDF 必须失败关闭，不能再用 hash 伪源码冒充已解码。
 * 事件工作台在拿不到用户本机 EMEDF 时只显示这一句可行动说明，不渲染任何
 * `instruction @i:hash` / `event @e:` 伪源码。
 */
const EMEDF_MISSING_SOURCE = [
  '// 事件源码反汇编已失败关闭：未找到用户本机 EMEDF。',
  '// 需要 DarkScript3 安装里的 sekiro-common.emedf.json：',
  '//   1) 设置环境变量 SOULFORGE_EMEDF_PATH 指向该文件；或',
  '//   2) 把文件放到游戏根旁 tools/<工具目录>/Resources/sekiro-common.emedf.json。',
  '// 反汇编只消费 EMEDF 公开语法，数据留在本机，不会打进仓库。'
].join('\n');

/**
 * S15 失败面：读取失败（非 live 且无模板）时，源码区给 code + 人话 + 下一步，
 * 禁止再画 `resource "file://event/…"` 假源码。message 来自已过 sanitizer 的
 * IPC 诊断；KRAK 缺 Oodle 时 Bridge 的 message 本身就是可行动句，不再追加。
 */
export function readFailureSource(document: EmevdEditorDocument): string | null {
  const failure = document.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning'
  );
  if (!failure) return null;
  const lines = [
    `// 事件脚本读不出来（${failure.code}）`,
    `// ${failure.message}`
  ];
  if (!failure.message.includes('开始')) {
    lines.push(
      '// 下一步：在「开始」页确认已挂载含 sekiro.exe 的原版目录后重新打开；',
      '// 仍未解决则检查该文件是否完整（KRAK 压缩需要 Oodle 运行库）。'
    );
  }
  return lines.join('\n');
}

/**
 * S14：`$Event` 源码可编辑，不再因反汇编形态锁只读。仍不可编的只剩打开失败类
 * （非 live）与 EMEDF 缺失（无 dslTemplate）。sourceStyle 不再是只读判据。
 */
export function isSourceReadOnly(
  tab: Pick<EventSourceTabData, 'live' | 'dslTemplate' | 'sourceStyle'>
): boolean {
  return !tab.live || tab.dslTemplate === null;
}

export function baselineText(tab: EventSourceTabData): string {
  // live 但 dslTemplate 缺失 = EMEDF 缺失（主进程失败关闭，不给伪源码）。
  if (tab.live && tab.dslTemplate === null) return EMEDF_MISSING_SOURCE;
  // S15：读取失败（非 live 且无模板）→ 可行动失败句，禁止假 resource 源码。
  if (!tab.live && tab.dslTemplate === null) {
    return readFailureSource(tab.document) ?? renderSource(tab.document);
  }
  return tab.dslTemplate ?? renderSource(tab.document);
}

/**
 * 取一个标签的 gutter 判据行：优先用 App 下发的 outline 派生行（live 文档），
 * 否则按 `document.events` 现算（只读 demo / 读取失败 / 单测手搓文档）。
 */
export function eventWarningRowsOf(tab: EventSourceTabData): readonly EventWarningRow[] {
  if (tab.eventWarnings) return tab.eventWarnings;
  return tab.document.events.map((event) => ({
    eventId: event.eventId,
    warnings: event.instructions.reduce((n, instruction) => n + (instruction.unknown ? 1 : 0), 0)
  }));
}

/**
 * 定位 doc 里每个事件块的首行（1-based 行号），供 gutter 标记与 Go to Event。
 *
 * 三种锚形态都要认，且都按「块出现顺序 = rows 顺序」对齐：
 * - `$Event(`：R3/P4 DarkScript3 式模板，本身不带锚，只能按顺序。
 * - `event @e:<eventId>`：`renderSource` 在文档没挂锚时的形态，锚就是十进制 eventId。
 * - `event @e:<localNodeId>`：挂过 stableIdentity 的形态，锚是 24 位 hex，跟 eventId
 *   无关，从 rows 里查不到。
 *
 * 所以锚能解析成已知 eventId 就按锚取（模板重排也不会错位），否则退回按顺序取。
 * 原实现在锚查不到时直接 `continue`，等于「文档没挂锚 → 整列标记静默消失」；
 * 而生产路径正好就是没挂锚的那种，标记全靠 `$Event(` 分支才没露出来。
 * 行号随 draft 编辑变化，故在 draft 变化时重建。
 */
export function indexEventLines(
  text: string,
  rows: readonly EventWarningRow[]
): Map<number, EventLineInfo> {
  const byEventId = new Map<string, EventWarningRow>();
  for (const row of rows) byEventId.set(String(row.eventId), row);
  const map = new Map<number, EventLineInfo>();
  const lines = text.split('\n');
  let blockIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const anchorMatch = /^event\s+@e:(\S+)/.exec(lines[i]!);
    if (!anchorMatch && !/^\$Event\(/.test(lines[i]!)) continue;
    const row = (anchorMatch ? byEventId.get(anchorMatch[1]!) : undefined) ?? rows[blockIndex];
    blockIndex += 1;
    if (!row) continue;
    if (row.warnings > 0) map.set(i + 1, { eventId: row.eventId, warnings: row.warnings });
  }
  return map;
}

/** DarkScript 风格高亮：注释灰、指令名强调、数字亮色、字符串绿、只读注释加深。 */
const darkScriptStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: tags.lineComment, color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--ember-text)', fontWeight: '600' },
  { tag: tags.atom, color: 'var(--ember-text)' },
  { tag: tags.number, color: 'var(--ok)' },
  { tag: tags.string, color: 'var(--ok)' },
  { tag: tags.propertyName, color: 'var(--ink-0)' },
  { tag: tags.function(tags.variableName), color: 'var(--ink-0)', fontWeight: '600' },
  { tag: tags.variableName, color: 'var(--ink-1)' },
  { tag: tags.punctuation, color: 'var(--ink-3)' },
  { tag: tags.operator, color: 'var(--ember-text)' },
  { tag: tags.invalid, color: 'var(--danger-text)', fontWeight: '600' }
]);

/**
 * EMEVD Patch-DSL 流式词法（renderEmevdPatchDsl 的输出语法）：
 *   resource "uri"
 *   base revision N schema "..."
 *   event @e:<local> { set id = N; set rest = N; ... }
 *   instruction @i:<local> { set arg <name> = <literal>; }
 *   // 注释 / // read-only ...（未知指令）
 */
const emevdDslStreamLanguage = StreamLanguage.define({
  name: 'emevd-dsl',
  token(stream) {
    if (stream.match(/^\/\/.*/)) return 'lineComment';
    if (stream.match(/^\s+/)) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i)) return 'number';
    if (stream.match(/^[{}()[\],;=]/)) return 'punctuation';
    if (stream.match(/^\b(?:resource|base|revision|schema|event|instruction|set|arg)\b/)) {
      return 'keyword';
    }
    if (stream.match(/^\b(?:id|rest|layer|bank|name)\b/)) return 'propertyName';
    if (stream.match(/^@[ei]:\S+/)) return 'atom';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName';
    stream.next();
    return null;
  }
});

/** gutter 的未知指令 warning 记号。toDOM 只在浏览器渲染 CM 时调用（SSR 不跑 effect）。 */
class EventDiagMarker extends GutterMarker {
  constructor(
    private readonly eventId: number,
    private readonly warnings: number
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'cm-event-diag__warn';
    element.textContent = '⚑';
    element.title = `Event ${this.eventId}：${this.warnings} 条未知指令`;
    return element;
  }
}

/** gutter 读事件行映射：每 tab 的 event 块首行若含未知指令则标 warning 记号。 */
const eventDiagGutter = gutter({
  class: 'cm-event-diag',
  lineMarker(view, line) {
    const info = (view as unknown as { _eventLineInfo?: Map<number, EventLineInfo> })
      ._eventLineInfo;
    const lineNumber = view.state.doc.lineAt(line.from).number;
    const marker = info?.get(lineNumber);
    if (!marker || marker.warnings <= 0) return null;
    return new EventDiagMarker(marker.eventId, marker.warnings);
  }
});

/* ------------------------------------------------------------------ */
/*  T4-3：EMEDF 指令名 autocomplete + 悬停参数名                      */
/*  只读 EMEDF 公开字段（name/bank/id/args），数据留在本机不进仓库。   */
/* ------------------------------------------------------------------ */

/** 参数列表展示文本：`resultConditionGroup:s8, targetConditionGroup:s8`。 */
function renderArgSummary(item: EmedfCompletionItem): string {
  if (item.args.length === 0) return '（无参数）';
  return item.args
    .map((arg) => `${arg.name}:${arg.type}${arg.vararg ? '…' : ''}`)
    .join('，');
}

/** 取 pos 处标识符（含精确边界），无则 null。 */
function wordAtPos(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(pos);
  const relative = pos - line.from;
  if (relative < 0 || relative > line.length) return null;
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line.text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (from <= relative && relative <= to) {
      return { from: line.from + from, to: line.from + to, text: match[0] };
    }
  }
  return null;
}

/**
 * 指令名补全：只在大写开头的 PascalCase 词上触发（避免干扰参数名/数字/关键字）。
 * Ctrl+Space 显式触发时忽略前缀过滤。同名指令（不同 bank:id）全部列出。
 */
function createCompletionSource(
  getCatalog: () => EmedfCompletionItem[]
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const word = context.matchBefore(/^[A-Za-z_][A-Za-z0-9_]*$/);
    if (!word) return null;
    if (!context.explicit && !/^[A-Z]/.test(word.text)) return null;
    const items = getCatalog();
    if (items.length === 0) return null;
    const prefix = word.text.toLowerCase();
    const matches = items.filter((item) => item.name.toLowerCase().startsWith(prefix));
    if (matches.length === 0 && !context.explicit) return null;
    return {
      from: word.from,
      options: matches.map((item) => ({
        label: item.name,
        detail: `bank ${item.bank}:${item.id}`,
        info: `参数：${renderArgSummary(item)}`,
        type: 'function',
        boost: item.name === word.text ? 10 : 0,
        apply: item.name
      }))
    };
  };
}

/** 悬停在指令名上显示参数名列表。只读展示也有效。 */
function createHoverTooltipSource(
  getCatalog: () => EmedfCompletionItem[]
): (view: EditorView, pos: number, side: -1 | 1) => Tooltip | null {
  return (view, pos) => {
    const word = wordAtPos(view.state, pos);
    if (!word || word.text.length < 2) return null;
    const matches = getCatalog().filter((item) => item.name === word.text);
    if (matches.length === 0) return null;
    const element = document.createElement('div');
    element.className = 'cm-emedf-hover';
    const title = document.createElement('strong');
    title.textContent = word.text;
    element.appendChild(title);
    for (const item of matches) {
      const row = document.createElement('div');
      row.className = 'cm-emedf-hover__row';
      row.textContent = `bank ${item.bank}:${item.id} — ${renderArgSummary(item)}`;
      element.appendChild(row);
    }
    return {
      pos: word.from,
      end: word.to,
      create: () => ({ dom: element })
    };
  };
}

function buildEditorExtensions(
  onDocChange: (text: string, state: EditorState) => void,
  readOnly: boolean,
  getCatalog: () => EmedfCompletionItem[],
  onSave: () => void,
  onSelection: (state: EditorState) => void
): Extension[] {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    foldGutter(),
    bracketMatching(),
    indentOnInput(),
    drawSelection(),
    dropCursor(),
    history(),
    closeBrackets(),
    search({ top: true }),
    syntaxHighlighting(darkScriptStyle),
    emevdDslStreamLanguage,
    eventDiagGutter,
    EditorState.readOnly.of(readOnly),
    // T4-3：EMEDF 指令名补全（Ctrl+Space + 输入时）与悬停参数名列表。
    hoverTooltip(createHoverTooltipSource(getCatalog)),
    autocompletion({ override: [createCompletionSource(getCatalog)] }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChange(update.state.doc.toString(), update.state);
      // S31：光标移动也刷新右侧词义栏（选中语句 → 参数说明）。
      if (update.selectionSet || update.docChanged) onSelection(update.state);
    }),
    keymap.of([
      // S14：Ctrl+S 直接保存当前源码（App → main → Patch Engine，UI 不提 Bridge）。
      { key: 'Mod-s', run: () => { onSave(); return true; } },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab
    ]),
    EditorView.theme({
      '&': { height: '100%', fontSize: '12px', backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
      '.cm-content': { caretColor: 'var(--ember-text)', padding: '8px 0' },
      '.cm-gutters': { backgroundColor: 'var(--forge-1)', color: 'var(--ink-3)', border: 'none' },
      '.cm-activeLine': { backgroundColor: 'var(--forge-2)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--forge-2)', color: 'var(--ink-2)' },
      '.cm-event-diag__warn': { color: 'var(--warn)' },
      '.cm-emedf-hover': { font: '11px var(--font-mono)', padding: '4px 8px', color: 'var(--ink-1)' },
      '.cm-emedf-hover strong': { display: 'block', color: 'var(--ink-0)', marginBottom: '2px' },
      '.cm-emedf-hover__row': { whiteSpace: 'nowrap' }
    })
  ];
  return extensions;
}

export function EventSourceWorkbenchPanel(props: EventSourceWorkbenchPanelProps): ReactElement {
  const [tabs, setTabs] = useState<InternalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState('就绪');
  const [completionItems, setCompletionItems] = useState<EmedfCompletionItem[]>([]);

  /** S31 多列：每个 tab 列一个 host + 一个 EditorView（独立滚动/光标）。 */
  const hostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const viewsRef = useRef<Map<string, EditorView>>(new Map());
  /** S31：并排源码列数（1 = 单列，2/3 = 多列对照）。 */
  const [columnCount, setColumnCount] = useState(1);
  const [inspector, setInspector] = useState<EventInspectorState | null>(null);
  /** T4-3：EMEDF 指令名目录，经 ref 供 CM extensions 闭包读最新值（异步到达）。 */
  const completionItemsRef = useRef<EmedfCompletionItem[]>([]);
  completionItemsRef.current = completionItems;
  /** 每 tab 的 event 块行映射，gutter 经该 ref 读取（CM 闭包拿不到 React state）。 */
  const eventLineInfoRef = useRef<Map<number, EventLineInfo>>(new Map());
  const eventLineScanRef = useRef<EventLineScanState>(emptyEventLineScan());
  const sourceFillGenerationRef = useRef(0);
  /** 始终指向最新 commitDraft，供各 tab 的 CM extensions 闭包安全调用。 */
  const commitDraftRef = useRef<(tabId: string, text: string, state: EditorState) => void>(() => {});
  /** S14：Ctrl+S keymap 经该 ref 调最新 save（闭包拿不到 React state）。 */
  const saveSourceRef = useRef<() => void>(() => {});

  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;

  /**
   * S31 多列对照：单列 = 激活 tab；多列 = 激活 tab 排前，其余按打开顺序补足。
   * 每列自己的 EditorView（独立滚动/光标），列间不共享选中/光标。
   */
  const visibleTabs = useMemo(() => {
    if (!activeTab) return [];
    if (columnCount <= 1) return [activeTab];
    const others = tabs.filter((tab) => tab.tabId !== activeTabId);
    return [activeTab, ...others].slice(0, columnCount);
  }, [tabs, activeTabId, columnCount, activeTab]);
  /** 供挂载 effect 用：列集合变化才重建 view，编辑/灌入不触发。 */
  const visibleTabsKey = visibleTabs.map((tab) => tab.tabId).join(',');

  /** T4-3：从主进程拉取本机 EMEDF 指令名目录（只读公开字段，一次性）。 */
  useEffect(() => {
    const bridge = getRendererBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge
      .readEmedfCompletionCatalog()
      .then((result) => {
        if (!cancelled && result.ok) setCompletionItems(result.items);
      })
      .catch(() => {
        // 目录拉取失败只影响补全/悬停，不阻断源码展示。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const commitDraft = useCallback((tabId: string, text: string, state: EditorState) => {
    setTabs((previous) =>
      previous.map((tab) =>
        // 同步最新 CM state：切换 tab 时 view.setState(activeTab.editorState)
        // 换入的是缓存 state，若编辑后不更新它，切回来会回退到未编辑的模板。
        tab.tabId === tabId ? { ...tab, dirty: true, draft: text, editorState: state } : tab
      )
    );
  }, []);
  commitDraftRef.current = commitDraft;

  /** 每个 tab 的 extensions 绑定自己的 tabId；运行时经 ref 调最新 commitDraft 与 save。 */
  const createExtensionsFor = useCallback((tabId: string, readOnly: boolean): Extension[] => {
    return buildEditorExtensions(
      (text, state) => commitDraftRef.current(tabId, text, state),
      readOnly,
      () => completionItemsRef.current,
      () => saveSourceRef.current(),
      (state) => selectionAtRef.current(tabId, state)
    );
  }, []);

  /**
   * S31：光标所在行的词义刷新。把选中行所在的「逻辑行」整块取出（WaitFor
   * 折叠块跨多行时合并），解析后在右栏显示指令名、bank:id 与每个参数的值。
   */
  const selectionAtRef = useRef<(tabId: string, state: EditorState) => void>(() => {});
  const handleSelectionAt = useCallback((tabId: string, state: EditorState) => {
    if (tabId !== activeTabId) {
      return;
    }
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    const lineNumber = line.number;
    const lines = state.doc.toString().split('\n');
    const trimmed = line.text.trim();
    if (trimmed === '' || trimmed.startsWith('//')) {
      setInspector(null);
      return;
    }
    // 定位选中行所属的源码块：单行调用即自身；WaitFor( 折叠块向上/向下补齐。
    const zeroBased = lineNumber - 1;
    let start = zeroBased;
    let end = zeroBased;
    if (/^WaitFor\(/.test(trimmed) && !/\);?\s*$/.test(trimmed)) {
      let cursor = zeroBased + 1;
      while (cursor < lines.length && !/\);?\s*$/.test(lines[cursor]!)) cursor += 1;
      end = Math.min(lines.length - 1, cursor);
    } else if (/^&&/.test(trimmed)) {
      let cursor = zeroBased - 1;
      while (cursor >= 0 && !/^WaitFor\(/.test(lines[cursor]!)) cursor -= 1;
      start = Math.max(0, cursor);
      let forward = zeroBased + 1;
      while (forward < lines.length && !/\);?\s*$/.test(lines[forward]!)) forward += 1;
      end = Math.min(lines.length - 1, forward);
    }
    const block = lines.slice(start, end + 1).join(' ').replace(/\s+/g, '');
    const parsed = parseInspectorCall(block);
    let next: EventInspectorState;
    if (parsed.kind === 'none') {
      next = { tabId, lineNumber, rows: [], unknownNames: [] };
    } else if (parsed.kind === 'call' || parsed.kind === 'wait') {
      const { rows, unknownNames } = buildInspectorRows(parsed, completionItemsRef.current);
      next = {
        tabId,
        lineNumber,
        ...(parsed.kind === 'wait' ? { waitFor: true as const } : {}),
        rows,
        unknownNames
      };
    } else {
      next = { tabId, lineNumber, rows: [], unknownNames: [], unparseable: parsed.canonical };
    }
    setInspector(current =>
      current
      && current.tabId === tabId
      && current.lineNumber === lineNumber
      && current.unparseable === next.unparseable
      && JSON.stringify(current.rows) === JSON.stringify(next.rows)
      && (current.waitFor ?? false) === (next.waitFor ?? false)
        ? current
        : next
    );
  }, [activeTabId]);
  selectionAtRef.current = handleSelectionAt;

  /** 把 App 给的 pending tab 并入 tabs（去重 + 保留 dirty/draft）并激活。 */
  useEffect(() => {
    const pending = props.pendingTab;
    if (!pending) return;
    const base = baselineText(pending);
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.tabId === pending.tabId);
      if (index >= 0) {
        const existing = previous[index]!;
        const merged: InternalTab = {
          ...existing,
          document: pending.document,
          // 必须显式跟着 document 走：`...existing` 会留住上一次的 gutter 判据，
          // 重开/提交后拿旧行给新文本打标记。pending 没有时也要清掉（undefined
          // = 回退到按 document.events 现算）。
          eventWarnings: pending.eventWarnings,
          sourceHash: pending.sourceHash,
          live: pending.live,
          dslTemplate: pending.dslTemplate,
          dslTemplateTruncated: pending.dslTemplateTruncated,
          dslTemplateTotalLines: pending.dslTemplateTotalLines,
          sourceStyle: pending.sourceStyle,
          sourceFillTarget: existing.sourceFillTarget
        };
        return previous.map((tab, i) => (i === index ? merged : tab));
      }
      const { head, rest } = splitSourceForFirstFrame(base);
      const created: InternalTab = {
        ...pending,
        dirty: false,
        draft: head,
        sourceFillTarget: rest.length > 0 ? base : null,
        editorState: EditorState.create({
          doc: head,
          extensions: createExtensionsFor(pending.tabId, isSourceReadOnly(pending))
        })
      };
      return [...previous, created];
    });
    setActiveTabId(pending.tabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTab, createExtensionsFor]);

  const applyEventLineScan = useCallback((scan: EventLineScanState) => {
    eventLineScanRef.current = scan;
    eventLineInfoRef.current = scan.map;
    // S31 多列：所有在挂的 view 都刷新 gutter 判据。
    for (const view of viewsRef.current.values()) {
      (view as unknown as { _eventLineInfo: Map<number, EventLineInfo> })._eventLineInfo =
        eventLineInfoRef.current;
      view.requestMeasure();
    }
  }, []);

  const syncGutterInfo = useCallback((text: string, rows: readonly EventWarningRow[]) => {
    applyEventLineScan(indexEventLinesIncremental(emptyEventLineScan(), text, rows));
  }, [applyEventLineScan]);

  useEffect(() => {
    if (!activeTab) return;
    // 灌入进行中由 onSlice 增量扫新 chunk。这里若用 draft（仍是首帧前缀）
    // 从空状态重扫，会把已扫到的 gutter 整表清掉，并随 setTabs 退化成 O(N²)。
    if (activeTab.sourceFillTarget !== null) return;
    syncGutterInfo(activeTab.draft, eventWarningRowsOf(activeTab));
  }, [activeTabId, activeTab?.draft, activeTab?.sourceFillTarget, activeTab?.eventWarnings, syncGutterInfo]);

  /** S31 多列：确保当前渲染的每个 tab 列都有 EditorView，并同步其 state。 */
  useEffect(() => {
    for (const tab of visibleTabs) {
      const host = hostsRef.current.get(tab.tabId);
      if (!host) continue;
      let view = viewsRef.current.get(tab.tabId);
      if (!view) {
        view = new EditorView({ parent: host, state: tab.editorState });
        (view as unknown as { _eventLineInfo: Map<number, EventLineInfo> })._eventLineInfo =
          eventLineInfoRef.current;
        viewsRef.current.set(tab.tabId, view);
      } else if (view.state !== tab.editorState) {
        view.setState(tab.editorState);
      }
    }
    // 卸载的列（tab 已关闭或移出分栏）destroy 对应 view。
    for (const [tabId, view] of viewsRef.current) {
      if (!hostsRef.current.has(tabId)) {
        view.destroy();
        viewsRef.current.delete(tabId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabsKey, visibleTabs]);

  /** 提交/加载完整模板/mutation 后 App 回灌 pendingTab → 更新激活 tab 的基线（保留 dirty）。 */
  useEffect(() => {
    const pending = props.pendingTab;
    if (!pending || !activeTabId || pending.tabId !== activeTabId) return;
    const view = viewsRef.current.get(activeTabId);
    if (!view) return;
    const current = tabs.find((tab) => tab.tabId === activeTabId);
    if (!current || current.dirty) return;
    const next = baselineText(pending);
    if (current.sourceFillTarget === next) return;
    if (next === current.draft && current.sourceFillTarget === null) return;
    const { head, rest } = splitSourceForFirstFrame(next);
    const nextState = EditorState.create({
      doc: head,
      extensions: createExtensionsFor(activeTabId, isSourceReadOnly(pending))
    });
    setTabs((previous) =>
      previous.map((tab) =>
        tab.tabId === activeTabId
          ? {
              ...tab,
              document: pending.document,
              eventWarnings: pending.eventWarnings,
              sourceHash: pending.sourceHash,
              dslTemplate: pending.dslTemplate,
              draft: head,
              dirty: false,
              sourceFillTarget: rest.length > 0 ? next : null,
              editorState: nextState
            }
          : tab
      )
    );
    view.setState(nextState);
    syncGutterInfo(head, eventWarningRowsOf(pending));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTab, activeTabId]);

  /** 后台把剩余源码灌进当前 tab。取消/切走会中止这一代填充。 */
  useEffect(() => {
    const tab = tabs.find((item) => item.tabId === activeTabId);
    if (!tab || tab.dirty || tab.sourceFillTarget === null) return;
    const remaining = tab.sourceFillTarget.slice(tab.editorState.doc.length);
    if (remaining.length === 0) return;
    const generation = sourceFillGenerationRef.current + 1;
    sourceFillGenerationRef.current = generation;
    const controller = new AbortController();
    const rows = eventWarningRowsOf(tab);
    void appendSourceSlices({
      state: tab.editorState,
      rest: remaining,
      signal: controller.signal,
      onSlice: (state, chunk) => {
        if (sourceFillGenerationRef.current !== generation) return;
        applyEventLineScan(indexEventLinesIncremental(eventLineScanRef.current, chunk, rows));
        const view = viewsRef.current.get(tab.tabId);
        if (view && view.state !== state) view.setState(state);
      }
    }).then((result) => {
      if (sourceFillGenerationRef.current !== generation || result.cancelled) return;
      setTabs((previous) =>
        previous.map((item) =>
          item.tabId === tab.tabId
            ? {
                ...item,
                draft: result.state.doc.toString(),
                editorState: result.state,
                sourceFillTarget: null
              }
            : item
        )
      );
      const view = viewsRef.current.get(tab.tabId);
      if (view) view.setState(result.state);
    });
    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeTab?.sourceFillTarget, activeTab?.dirty]);

  function activateTab(tabId: string): void {
    setActiveTabId(tabId);
  }

  /** S31：切 tab 后右栏词义清空（避免上一文档的语句说明残留）。 */
  useEffect(() => {
    setInspector(null);
  }, [activeTabId]);

  function closeTab(tabId: string): void {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.tabId === tabId);
      const next = previous.filter((tab) => tab.tabId !== tabId);
      if (activeTabId === tabId) {
        const neighbor = next[Math.max(0, index - 1)] ?? next[0] ?? null;
        setActiveTabId(neighbor?.tabId ?? null);
      }
      return next;
    });
  }

  async function submitSource(): Promise<void> {
    if (!activeTab || !props.onDslSubmit || submitting) return;
    setSubmitting(true);
    setStatus('保存中…');
    try {
      const result = await props.onDslSubmit(activeTab, activeTab.draft);
      if (result.ok) {
        const nextText = result.nextDslTemplate ?? activeTab.draft;
        const { head, rest } = splitSourceForFirstFrame(nextText);
        const nextState = EditorState.create({
          doc: head,
          extensions: createExtensionsFor(activeTab.tabId, isSourceReadOnly(activeTab))
        });
        setTabs((previous) =>
          previous.map((tab) =>
            tab.tabId === activeTab.tabId
              ? {
                  ...tab,
                  dirty: false,
                  draft: head,
                  dslTemplate: nextText,
                  dslTemplateTruncated: false,
                  dslTemplateTotalLines: nextText.split('\n').length,
                  sourceFillTarget: rest.length > 0 ? nextText : null,
                  editorState: nextState
                }
              : tab
          )
        );
        viewsRef.current.get(activeTab.tabId)?.setState(nextState);
        // 保存刚成功、App 还没回灌 pendingTab：先按保存前的判据行给新文本打标记，
        // 下一轮 pendingTab 到达时会用权威 outline 覆盖。
        syncGutterInfo(head, eventWarningRowsOf(activeTab));
        setStatus('已保存（可回滚）');
      } else {
        setStatus(result.diagnostics[0]?.message ?? '保存被拒绝。');
      }
    } catch (error) {
      setStatus(`保存异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSubmitting(false);
    }
  }
  // S14：Ctrl+S keymap 经 ref 取最新 save（闭包不持有本次渲染的 activeTab）。
  saveSourceRef.current = () => { void submitSource(); };

  const readOnly = activeTab
    ? (!activeTab.live || activeTab.dslTemplate === null)
    : true;

  /** S31 右栏词义：选中语句 → 指令名/bank:id/参数值。 */
  const renderInspector = (state: EventInspectorState | null): ReactElement => {
    if (!state) {
      return <div className="esw-inspector__empty">选中一条语句查看参数说明。</div>;
    }
    if (state.unparseable) {
      return (
        <div className="esw-inspector__empty">
          这一行无法单独解析成调用（可能是 WaitFor 折叠块中间行或残缺行），选中整条语句再试。
        </div>
      );
    }
    if (state.rows.length === 0 && state.unknownNames.length === 0) {
      return <div className="esw-inspector__empty">事件头或注释行没有参数说明。</div>;
    }
    return (
      <div className="esw-inspector__body">
        {state.waitFor === true && (
          <div className="esw-inspector__fold">WaitFor( 折叠块：等待 MAIN 条件组满足后继续。</div>
        )}
        {state.rows.map((row, index) => (
          <div className="esw-inspector__row" key={`${row.name}-${row.bank}-${row.id}-${index}`}>
            <div className="esw-inspector__row-head">
              <strong>{row.name}</strong>
              <span className="muted">bank {row.bank}:{row.id}</span>
            </div>
            <ul className="esw-inspector__args">
              {row.args.map((arg) => (
                <li key={arg.name}>
                  <span className="esw-inspector__arg">{arg.name}</span>
                  <span className="muted">
                    {arg.type}{arg.vararg ? '…' : ''}{arg.hidden ? ' · 折叠隐藏' : ''}
                  </span>
                  <span className="esw-inspector__value">{arg.value}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {state.unknownNames.map((name) => (
          <div className="esw-inspector__unknown" key={name}>
            未解码：EMEDF 目录里没有 {name} 的定义，无法解释它的参数。
          </div>
        ))}
      </div>
    );
  };

  return (
    <section className="event-source-workbench" aria-label="Event 源码工作台">
      <div className="esw-tabs" role="tablist" aria-label="事件文档标签">
        {tabs.map((tab) => (
          <button
            key={tab.tabId}
            type="button"
            role="tab"
            aria-selected={tab.tabId === activeTabId}
            className={tab.tabId === activeTabId ? 'esw-tab is-active' : 'esw-tab'}
            onClick={() => activateTab(tab.tabId)}
          >
            <span className="esw-tab__title">
              {tab.dirty && <span className="esw-tab__dirty" aria-label="未保存" />}
              {tab.title}
            </span>
            <span
              className="esw-tab__close"
              role="button"
              tabIndex={-1}
              aria-label={`关闭 ${tab.title}`}
              onClick={(event) => { event.stopPropagation(); closeTab(tab.tabId); }}
            >
              ×
            </span>
          </button>
        ))}
        {tabs.length === 0 && <span className="muted esw-tabs__empty">暂无打开的事件文档。</span>}
      </div>

      <div className="esw-toolbar">
        <div className="esw-toolbar__group">
          <span className="muted" style={{ fontSize: 11 }} title="Ctrl+F 走 CodeMirror search keymap">
            查找：Ctrl+F
          </span>
          <span className="muted" style={{ fontSize: 11 }} title="Ctrl+S 保存当前源码">
            保存：Ctrl+S
          </span>
          <button
            type="button"
            className="esw-toolbar__split"
            title="并排多份事件源码对照，每列独立滚动与光标"
            onClick={() => setColumnCount((count) => (count >= 3 ? 1 : count + 1))}
          >
            分栏 {columnCount}
          </button>
          {status !== '就绪' && (
            <span className="muted" style={{ fontSize: 11 }} role="status">
              {status}
            </span>
          )}
        </div>
      </div>

      <div className="esw-body">
        {visibleTabs.length === 0 ? (
          <section className="esw-source" aria-label="事件源码">
            <div className="esw-source__host" data-editor-engine="codemirror" />
          </section>
        ) : (
          visibleTabs.map((tab) => (
          <section
            className="esw-source"
            key={tab.tabId}
            aria-label="事件源码"
            {...citeScriptAttr(tab.tabId, tab.title)}
          >
            <div
              ref={(element) => {
                if (element) hostsRef.current.set(tab.tabId, element);
                else hostsRef.current.delete(tab.tabId);
              }}
              className="esw-source__host"
              data-editor-engine="codemirror"
              data-tab-id={tab.tabId}
            />
            {tab.live && tab.dslTemplate === null && (
              <div className="event-source__notice event-source__notice--blocked" role="alert">
                事件源码反汇编已失败关闭：未找到用户本机 EMEDF（DarkScript3 的
                sekiro-common.emedf.json）。配置后重新打开即可看到 DarkScript3 式源码。
              </div>
            )}
          </section>
          ))
        )}
        <section className="esw-inspector" aria-label="事件源码说明">
          {renderInspector(inspector)}
        </section>
      </div>
    </section>
  );
}
