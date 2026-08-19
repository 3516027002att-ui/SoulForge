/**
 * EMEVD 反汇编文本的 opaque source token。
 *
 * 打开回包只带前 400 行；其余走 readEmevdSourceSlice(token, fromLine, lineCount)。
 * token 只活在 main，renderer 不得拿路径。切 tab / 关窗口 / 取消打开即作废。
 */

import { randomUUID } from 'node:crypto';

export const SOURCE_PREFIX_LINES = 400;
/** 与 renderer 的 assembleEmevdSource.SOURCE_SLICE_LINES 同口径（单片续载行数）。 */
export const SOURCE_SLICE_LINES = 1200;

export interface EmevdSourcePutResult {
  token: string;
  prefix: string;
  totalLines: number;
}

export type EmevdSourceSliceResult =
  | {
      ok: true;
      fromLine: number;
      lineCount: number;
      totalLines: number;
      eof: boolean;
      sliceText: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

interface SourceEntry {
  token: string;
  windowId: number;
  sourceUri: string;
  lines: string[];
  truncated: boolean;
}

export function splitSourceLines(text: string): string[] {
  return text.split('\n');
}

export function takeSourcePrefix(lines: readonly string[], prefixLines = SOURCE_PREFIX_LINES): string {
  return lines.slice(0, prefixLines).join('\n');
}

export class EmevdSourceTokens {
  private readonly byToken = new Map<string, SourceEntry>();
  private readonly tokenByWindow = new Map<number, string>();

  put(
    windowId: number,
    sourceUri: string,
    text: string,
    options?: { truncated?: boolean }
  ): EmevdSourcePutResult {
    this.dropWindow(windowId);
    const lines = splitSourceLines(text);
    const token = randomUUID();
    this.byToken.set(token, {
      token,
      windowId,
      sourceUri,
      lines,
      truncated: options?.truncated === true
    });
    this.tokenByWindow.set(windowId, token);
    return {
      token,
      prefix: takeSourcePrefix(lines),
      totalLines: lines.length
    };
  }

  readSlice(
    token: string,
    windowId: number,
    fromLine: number,
    lineCount: number
  ): EmevdSourceSliceResult {
    const entry = this.byToken.get(token);
    if (!entry || entry.windowId !== windowId) {
      return {
        ok: false,
        code: 'EMEVD_SOURCE_TOKEN_EXPIRED',
        message: '源码切片令牌已失效（已切走、取消或关闭窗口）。'
      };
    }
    if (!Number.isInteger(fromLine) || fromLine < 0) {
      return {
        ok: false,
        code: 'EMEVD_SOURCE_SLICE_RANGE',
        message: 'fromLine 必须是 ≥ 0 的整数。'
      };
    }
    if (!Number.isInteger(lineCount) || lineCount <= 0) {
      return {
        ok: false,
        code: 'EMEVD_SOURCE_SLICE_RANGE',
        message: 'lineCount 必须是正整数。'
      };
    }
    const totalLines = entry.lines.length;
    if (fromLine >= totalLines) {
      return {
        ok: true,
        fromLine,
        lineCount: 0,
        totalLines,
        eof: true,
        sliceText: ''
      };
    }
    const end = Math.min(totalLines, fromLine + lineCount);
    const slice = entry.lines.slice(fromLine, end);
    return {
      ok: true,
      fromLine,
      lineCount: slice.length,
      totalLines,
      eof: end >= totalLines,
      sliceText: slice.join('\n')
    };
  }

  dropWindow(windowId: number): void {
    const token = this.tokenByWindow.get(windowId);
    if (!token) return;
    this.tokenByWindow.delete(windowId);
    this.byToken.delete(token);
  }

  dropToken(token: string): void {
    const entry = this.byToken.get(token);
    if (!entry) return;
    this.byToken.delete(token);
    if (this.tokenByWindow.get(entry.windowId) === token) {
      this.tokenByWindow.delete(entry.windowId);
    }
  }

  get size(): number {
    return this.byToken.size;
  }
}
