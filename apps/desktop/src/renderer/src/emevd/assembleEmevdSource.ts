/**
 * 把 3.1 的前缀 + slice IPC 拼成完整 DarkScript 文本。
 *
 * 常量放在 App 侧模块，禁止进 EventSourceWorkbenchPanel：面板只接收完整
 * dslTemplate，一次 EditorState.create。
 */

export const SOURCE_PREFIX_LINES = 400;
export const SOURCE_SLICE_LINES = 400;

export interface EmevdSourceSliceView {
  ok?: boolean;
  cancelled?: boolean;
  sliceText?: string;
  fromLine?: number;
  lineCount?: number;
  totalLines?: number;
  eof?: boolean;
}

export function countSourceLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export async function assembleEmevdSource(input: {
  dslTemplate?: string | null | undefined;
  sourcePrefix?: string | null | undefined;
  sourceToken?: string | null | undefined;
  sourceTotalLines?: number | undefined;
  readSlice: (token: string, fromLine: number, lineCount: number) => Promise<EmevdSourceSliceView>;
  isCancelled?: (() => boolean) | undefined;
}): Promise<{ text: string | null; cancelled: boolean }> {
  const cancelled = (): boolean => input.isCancelled?.() === true;
  if (cancelled()) return { text: null, cancelled: true };

  if (input.sourceToken && input.sourcePrefix !== undefined && input.sourcePrefix !== null) {
    const totalLines = input.sourceTotalLines ?? countSourceLines(input.sourcePrefix);
    const prefixLines = countSourceLines(input.sourcePrefix);
    if (prefixLines >= totalLines) {
      return { text: input.sourcePrefix, cancelled: false };
    }
    const parts = [input.sourcePrefix];
    let fromLine = prefixLines;
    while (fromLine < totalLines) {
      if (cancelled()) return { text: null, cancelled: true };
      const slice = await input.readSlice(input.sourceToken, fromLine, SOURCE_SLICE_LINES);
      if (slice.cancelled) return { text: null, cancelled: true };
      if (!slice.ok) return { text: null, cancelled: false };
      if (typeof slice.sliceText === 'string' && slice.sliceText.length > 0) {
        parts.push(slice.sliceText);
      }
      const advanced = slice.lineCount ?? countSourceLines(slice.sliceText ?? '');
      if (advanced <= 0) break;
      fromLine += advanced;
      if (slice.eof) break;
    }
    return { text: parts.join('\n'), cancelled: false };
  }

  if (typeof input.dslTemplate === 'string') {
    return { text: input.dslTemplate, cancelled: false };
  }
  return { text: null, cancelled: false };
}
