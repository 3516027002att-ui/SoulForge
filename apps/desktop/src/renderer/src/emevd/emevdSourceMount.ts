/**
 * 大份 DarkScript 源码的 CodeMirror 挂载：禁止首帧 EditorState.create(全文)。
 *
 * CodeMirror 6 视口绘制已经是虚拟的；贵的是 Text 树一次性构建。第一帧只灌
 * 已到达的前缀，其余按时间预算追加。indexEventLines 随追加增量更新。
 */

import { EditorState, type Extension } from '@codemirror/state';

export const FIRST_FRAME_CHARS = 8 * 1024;
export const DEFAULT_SLICE_BUDGET_MS = 8;

export interface SourceFillScheduler {
  now(): number;
  yieldSlice(): Promise<void>;
}

export const defaultSourceFillScheduler: SourceFillScheduler = {
  now: () => performance.now(),
  yieldSlice: () => new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  })
};

export function splitSourceForFirstFrame(
  text: string,
  maxChars: number = FIRST_FRAME_CHARS
): { head: string; rest: string } {
  if (text.length <= maxChars) return { head: text, rest: '' };
  const sliceAt = text.lastIndexOf('\n', maxChars);
  const cut = sliceAt >= Math.floor(maxChars / 2) ? sliceAt + 1 : maxChars;
  return { head: text.slice(0, cut), rest: text.slice(cut) };
}

export function createInitialSourceState(head: string, extensions: Extension): EditorState {
  return EditorState.create({
    doc: head,
    extensions
  });
}

export interface AppendSourceSlicesInput {
  state: EditorState;
  rest: string;
  signal?: AbortSignal;
  sliceBudgetMs?: number;
  scheduler?: SourceFillScheduler;
  onSlice?: (state: EditorState, appended: string, sliceIndex: number) => void;
}

export async function appendSourceSlices(
  input: AppendSourceSlicesInput
): Promise<{ state: EditorState; cancelled: boolean; slices: number }> {
  const scheduler = input.scheduler ?? defaultSourceFillScheduler;
  const budget = Math.max(1, input.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS);
  let state = input.state;
  let offset = 0;
  let slices = 0;
  if (input.signal?.aborted) return { state, cancelled: true, slices };
  if (input.rest.length === 0) return { state, cancelled: false, slices };

  while (offset < input.rest.length) {
    if (input.signal?.aborted) return { state, cancelled: true, slices };
    const started = scheduler.now();
    let chunkEnd = offset;
    while (chunkEnd < input.rest.length && scheduler.now() - started < budget) {
      const nextNl = input.rest.indexOf('\n', chunkEnd);
      chunkEnd = nextNl < 0 ? input.rest.length : nextNl + 1;
      if (chunkEnd - offset >= 16 * 1024) break;
    }
    if (chunkEnd === offset) chunkEnd = Math.min(input.rest.length, offset + 1024);
    const chunk = input.rest.slice(offset, chunkEnd);
    state = state.update({
      changes: { from: state.doc.length, insert: chunk }
    }).state;
    input.onSlice?.(state, chunk, slices);
    offset = chunkEnd;
    slices += 1;
    if (offset < input.rest.length) {
      if (input.signal?.aborted) return { state, cancelled: true, slices };
      await scheduler.yieldSlice();
    }
  }
  return { state, cancelled: Boolean(input.signal?.aborted), slices };
}

export interface EventLineScanState {
  map: Map<number, { eventId: number; warnings: number }>;
  blockIndex: number;
  scannedLines: number;
  pendingPrefix: string;
}

export function emptyEventLineScan(): EventLineScanState {
  return { map: new Map(), blockIndex: 0, scannedLines: 0, pendingPrefix: '' };
}

/**
 * 只扫新增 chunk。保留半行，禁止对累计全文 split。
 */
export function indexEventLinesIncremental(
  previous: EventLineScanState,
  chunk: string,
  rows: ReadonlyArray<{ eventId: number; warnings: number }>
): EventLineScanState {
  const byEventId = new Map<string, { eventId: number; warnings: number }>();
  for (const row of rows) byEventId.set(String(row.eventId), row);
  const combined = previous.pendingPrefix + chunk;
  const parts = combined.split('\n');
  let pendingPrefix = '';
  if (combined.endsWith('\n')) {
    parts.pop();
  } else {
    pendingPrefix = parts.pop() ?? '';
  }
  const complete = parts;
  const map = new Map(previous.map);
  let blockIndex = previous.blockIndex;
  let lineNo = previous.scannedLines;
  for (const line of complete) {
    lineNo += 1;
    const anchorMatch = /^event\s+@e:(\S+)/.exec(line);
    if (!anchorMatch && !/^\$Event\(/.test(line)) continue;
    const row = (anchorMatch ? byEventId.get(anchorMatch[1]!) : undefined) ?? rows[blockIndex];
    blockIndex += 1;
    if (!row) continue;
    if (row.warnings > 0) map.set(lineNo, { eventId: row.eventId, warnings: row.warnings });
  }
  return { map, blockIndex, scannedLines: lineNo, pendingPrefix };
}
