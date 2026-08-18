/**
 * S35 — 超长 EMEVD 的按视口增量灌入（规格 event-common-load.md §3.2）。
 *
 * 打开回包（readEmevdFullDocument）只带 outline + 前 400 行 + opaque source
 * token；本模块负责把「剩余部分」按需拉进编辑器：
 *
 * - 视口滚动：用户滚到靠近已加载底部时拉下一片（复用 3.1 的
 *   `resource.readEmevdSourceSlice`），一片一次 `dispatch` 追加，没有 16ms 分片。
 * - 拉齐：查找（Ctrl+F）/ 提交 / 脏标记时调用 `fetchAllRemainingSource` 一次把
 *   未加载部分全部取回，再单次追加（与 3.1 的 dirty 一次性补全同一语义）。
 *
 * 追加永远发生在文档**末尾**，不动已加载部分，因此用户编辑、光标与滚动位置都
 * 不会被打扰；拉齐前的用户编辑只影响已加载前缀，未加载部分按 main 的原样文本
 * 追加（与 assembleEmevdSource 的 '\n' 拼接口径一致）。
 *
 * 状态推进的纪律：`nextFromLine` 只在**取回一片**时前进；取回后调用方必须把
 * sliceText 追加进该 tab 的缓冲（活动视图 dispatch，或按 tab 的 EditorState
 * 函数式 update），否则行号会与编辑器内容错位。失败（令牌失效 / 被取消）置
 * `failed`，自动续载停止，由面板给出结构化状态。
 */

import { Annotation, type EditorState } from '@codemirror/state';
import {
  SOURCE_SLICE_LINES,
  countSourceLines,
  type EmevdSourceSliceView
} from './assembleEmevdSource.js';

/**
 * 滚近已加载底部多少行内触发下一片（行数口径，与视口虚拟化一致）。
 *
 * 取 200 而不是 600：阈值必须小于前缀长度（400 行），否则打开首帧的挂载
 * measure 就会把「视口还在文档顶部」判成近底，未滚动先拉一片 —— 违背
 * event-common-load.md §3.2「首帧只有 400 行前缀，用户滚到靠近已加载底部再拉
 * 下一片」。200 行 ≈ 10 个视口高度，续载 IPC（~几十 ms）期间用户滚不完，
 * 不会撞到已加载末尾；一次续载追加 400 行后，仍需再滚动 400 行才触发下一片，
 * 不会在同一滚动位置连续空转。
 */
export const INCREMENTAL_NEAR_BOTTOM_LINES = 200;

/**
 * 增量追加事务的标记。填充/拉齐产生的 docChanged 不是用户编辑：带此注解的
 * 事务不进 undo 历史、不置 dirty、不触发「脏标记 → 拉齐」的递归。
 */
export const sourceFillAnnotation = Annotation.define<boolean>();

/** 一个 tab 的增量源推进状态（operational，放在 ref 里供回调闭包读取）。 */
export interface IncrementalSourceState {
  /** main 侧 opaque token；renderer 不得拿路径。 */
  token: string;
  /** 下一片从文件第几行开始取（0-based）；初始 = 前缀行数。 */
  nextFromLine: number;
  /** main 报告的全文总行数。 */
  totalLines: number;
  /** 已取回最后一片（eof 或前缀已覆盖全文）。 */
  eof: boolean;
  /** 拉片失败（令牌失效 / 取消 / bridge 缺失）：停止自动续载。 */
  failed: boolean;
}

/**
 * 由打开回包建增量源。没有 token（小文档走 dslTemplate / 失败关闭 / 只读投影）
 * 时返回 null —— 面板退回「首帧即全文」的既有原子挂载。
 */
export function createIncrementalSourceState(input: {
  sourcePrefix?: string | null | undefined;
  sourceToken?: string | null | undefined;
  sourceTotalLines?: number | undefined;
}): IncrementalSourceState | null {
  if (!input.sourceToken) return null;
  const prefixLines = input.sourcePrefix === undefined || input.sourcePrefix === null
    ? 0
    : countSourceLines(input.sourcePrefix);
  const totalLines = input.sourceTotalLines ?? prefixLines;
  return {
    token: input.sourceToken,
    nextFromLine: prefixLines,
    totalLines,
    eof: prefixLines >= totalLines,
    failed: false
  };
}

/** 增量源是否已无可拉（没有增量源 / 已到 eof / 已失败）。 */
export function isIncrementalSourceComplete(state: IncrementalSourceState | null | undefined): boolean {
  return !state || state.eof || state.failed;
}

/** 视口判定所需的最小形状（EditorView 的 state.doc / viewport 子集，便于单测）。 */
export interface ViewportLike {
  state: { doc: { lines: number; length: number; lineAt(pos: number): { number: number } } };
  viewport: { from: number; to: number };
}

/**
 * 视口底行距已加载末尾还差的行数是否 ≤ 阈值 —— 即「滚近已加载底部」。
 *
 * 注意单位：CodeMirror 的 `viewport.to` 是**字符偏移**，不是行号，不能直接拿
 * `doc.lines - viewport.to`（行数减字符数永远算出负数，任何滚动位置都会被判成
 * 「近底」，打开首帧就会级联把全文拉完）。正确做法是先 `lineAt(viewport.to)`
 * 换回视口底行号，再做行数口径的减法。
 */
export function isNearLoadedBottom(view: ViewportLike): boolean {
  const doc = view.state.doc;
  const bottomLine = doc.lineAt(Math.min(view.viewport.to, doc.length)).number;
  return doc.lines - bottomLine <= INCREMENTAL_NEAR_BOTTOM_LINES;
}

/**
 * 拉下一片（SOURCE_SLICE_LINES 行）。成功时 state.nextFromLine 前进到下一片
 * 起点；cancelled / 失败时 state.failed 置位并停止续载。sliceText 为 '' 表示
 * 该片没有新内容（eof 边界），调用方无需追加。
 */
export async function fetchNextSourceSlice(
  state: IncrementalSourceState,
  readSlice: (token: string, fromLine: number, lineCount: number) => Promise<EmevdSourceSliceView>
): Promise<{ state: IncrementalSourceState; sliceText: string | null; cancelled: boolean }> {
  if (isIncrementalSourceComplete(state)) {
    return { state, sliceText: null, cancelled: false };
  }
  const slice = await readSlice(state.token, state.nextFromLine, SOURCE_SLICE_LINES);
  if (slice.cancelled) {
    return { state: { ...state, failed: true }, sliceText: null, cancelled: true };
  }
  if (!slice.ok) {
    return { state: { ...state, failed: true }, sliceText: null, cancelled: false };
  }
  const sliceText = typeof slice.sliceText === 'string' ? slice.sliceText : '';
  const lineCount = slice.lineCount ?? countSourceLines(sliceText);
  // main 侧 eof 权威；lineCount ≤ 0 却未报 eof 视为终端态，避免 nextFromLine 空转。
  const reachedEnd = slice.eof === true || lineCount <= 0
    || state.nextFromLine + lineCount >= (slice.totalLines ?? state.totalLines);
  return {
    state: {
      token: state.token,
      nextFromLine: state.nextFromLine + Math.max(0, lineCount),
      totalLines: slice.totalLines ?? state.totalLines,
      eof: reachedEnd,
      failed: false
    },
    sliceText,
    cancelled: false
  };
}

/**
 * 一次拉齐：循环取回所有未加载片并拼成一段文本（不含已加载部分），供调用方
 * 单次追加。取消 / 失败时返回部分结果，restText 为已取回的文本（可能不完整，
 * 调用方以 state.failed / cancelled 判定是否算拉齐成功）。
 */
export async function fetchAllRemainingSource(
  state: IncrementalSourceState,
  readSlice: (token: string, fromLine: number, lineCount: number) => Promise<EmevdSourceSliceView>
): Promise<{ state: IncrementalSourceState; restText: string | null; cancelled: boolean }> {
  if (isIncrementalSourceComplete(state)) {
    return { state, restText: null, cancelled: false };
  }
  const parts: string[] = [];
  let current = state;
  while (!isIncrementalSourceComplete(current)) {
    const step = await fetchNextSourceSlice(current, readSlice);
    current = step.state;
    if (step.cancelled) return { state: current, restText: parts.join('\n') || null, cancelled: true };
    if (step.sliceText && step.sliceText.length > 0) parts.push(step.sliceText);
    if (current.failed) break;
  }
  return { state: current, restText: parts.length > 0 ? parts.join('\n') : null, cancelled: false };
}

/**
 * 把一段「文件后半」追加到编辑器文档末尾的 change 描述。
 *
 * 分隔符口径与 assembleEmevdSource 一致：前缀与下一片之间补一个 '\n'；若文档
 * 当前已以 '\n' 结尾（用户编辑过末尾）则不再补，避免凭空多出空行。selection
 * 显式保留调用时刻的主选择，追加不移动光标。
 */
export function appendSourceTail(
  state: EditorState,
  insert: string
): { changes: { from: number; insert: string }; selection: { anchor: number; head: number } } {
  const needsSeparator = state.doc.length > 0 && state.doc.sliceString(state.doc.length - 1) !== '\n';
  return {
    changes: { from: state.doc.length, insert: `${needsSeparator ? '\n' : ''}${insert}` },
    selection: { anchor: state.selection.main.anchor, head: state.selection.main.head }
  };
}
