/**
 * S18-E：CodeMirror 增量灌入的纯函数。
 *
 * 打开 common.emevd（约 7 万行 DarkScript）时禁止第一帧 `EditorState.create(全文)`：
 * CodeMirror 6 视口绘制已经是虚拟的，贵的是 Text 树一次性构建与全量高亮 ——
 * 70k 行一次建树会把 renderer 主线程卡死。这里把「首帧前缀 + 分片追加 + 增量
 * gutter 索引」拆成纯函数；EventSourceWorkbenchPanel 的 interval 循环只负责调度
 * （16 ms 一片 dispatch），不在此模块持有任何 DOM / CM 引用。
 */

import type { EventWarningRow } from '../editors/EventSourceWorkbenchPanel.js';

/** 首帧注入的行数：视口（约 40 行）加缓冲，远小于任何真实事件文档。 */
export const SOURCE_PREFIX_LINES = 400;

/** 每片追加的行数（16 ms 一片，70k 行文档约 175 片 ≈ 3 s 内补完）。 */
export const SOURCE_SLICE_LINES = 400;

/** 一行是否是事件块锚行（`$Event(` 或 `event @e:`）。与 indexEventLines 同一判据。 */
export function isEventBlockLine(line: string): boolean {
  return /^\$Event\(/.test(line) || /^event\s+@e:(\S+)/.test(line);
}

function countLinesOf(text: string): number {
  if (text === '') return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) count += 1;
  }
  return count;
}

function countEventBlocks(text: string): number {
  let count = 0;
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const line = nl < 0 ? text.slice(start) : text.slice(start, nl);
    if (isEventBlockLine(line)) count += 1;
    if (nl < 0) break;
    start = nl + 1;
  }
  return count;
}

export interface SourceInjectionSplit {
  /** 首帧 EditorState 的 doc（恰好 prefixLines 行，末尾带换行符）。 */
  prefix: string;
  /** 剩余未注入文本（'' = 不需要注入，全文都在前缀里）。 */
  rest: string;
  /** prefix 的行数。 */
  prefixLines: number;
  /** prefix 里的事件块数（增量索引的起点）。 */
  prefixBlocks: number;
}

/**
 * 把全文切成「首帧前缀 + 剩余」。行边界按换行符定位，prefix 保留末尾换行符，
 * 追加时 `dispatch({ changes: { from: doc.length } })` 不会错位；文本不足
 * `prefixLines` 行时 rest 为空（小文档直接全量建树，与现状一致）。
 */
export function splitSourceForInjection(
  text: string,
  rows: readonly EventWarningRow[],
  prefixLines: number = SOURCE_PREFIX_LINES
): SourceInjectionSplit {
  let pos = -1;
  for (let i = 0; i < prefixLines; i += 1) {
    const nl = text.indexOf('\n', pos + 1);
    if (nl < 0) {
      // 全文不足前缀行数：prefix = 全文，rest 为空。
      return {
        prefix: text,
        rest: '',
        prefixLines: countLinesOf(text),
        prefixBlocks: countEventBlocks(text)
      };
    }
    pos = nl;
  }
  const prefix = text.slice(0, pos + 1);
  return {
    prefix,
    rest: text.slice(pos + 1),
    prefixLines,
    prefixBlocks: countEventBlocks(prefix)
  };
}

/**
 * 从剩余文本取下一片（至多 sliceLines 行，行边界带换行符；不足一片时全给）。
 */
export function takeSourceSlice(
  remaining: string,
  sliceLines: number = SOURCE_SLICE_LINES
): { chunk: string; rest: string } {
  let pos = -1;
  for (let i = 0; i < sliceLines; i += 1) {
    const nl = remaining.indexOf('\n', pos + 1);
    if (nl < 0) {
      // 剩余不足一片：全部注入，收尾。
      return { chunk: remaining, rest: '' };
    }
    pos = nl;
  }
  return { chunk: remaining.slice(0, pos + 1), rest: remaining.slice(pos + 1) };
}

/**
 * 增量更新事件块行映射：只扫 `chunk` 的新增行，不动已索引的部分。
 *
 * 与 indexEventLines 同一判据与同一顺序映射规则（锚能解析成已知 eventId 按锚取，
 * 否则按块出现顺序取），所以全量重扫与分片增量拼接出的结果一致。
 *
 * @param existing 已索引的映射（原地追加）。
 * @param chunk 本片追加的文本（含内部换行，行边界以 \n 计）。
 * @param startLine chunk 第一行在文档中的 1-based 行号（= 注入前 doc.lines + 1）。
 * @param startBlockIndex 本片起始的事件块序号（= 此前已消费块数）。
 * @param rows gutter 判据行。
 * @returns 本片消费的事件块数（调用方累加进 blockIndex）。
 */
export function appendEventLineInfo(
  existing: Map<number, { eventId: number; warnings: number }>,
  chunk: string,
  startLine: number,
  startBlockIndex: number,
  rows: readonly EventWarningRow[]
): number {
  const byEventId = new Map<string, EventWarningRow>();
  for (const row of rows) byEventId.set(String(row.eventId), row);
  let blockIndex = startBlockIndex;
  let line = startLine;
  let start = 0;
  while (start <= chunk.length) {
    const nl = chunk.indexOf('\n', start);
    const lineText = nl < 0 ? chunk.slice(start) : chunk.slice(start, nl);
    if (isEventBlockLine(lineText)) {
      const anchorMatch = /^event\s+@e:(\S+)/.exec(lineText);
      const row = (anchorMatch ? byEventId.get(anchorMatch[1]!) : undefined) ?? rows[blockIndex];
      blockIndex += 1;
      if (row && row.warnings > 0) {
        existing.set(line, { eventId: row.eventId, warnings: row.warnings });
      }
    }
    if (nl < 0) break;
    line += 1;
    start = nl + 1;
  }
  return blockIndex - startBlockIndex;
}
