/**
 * 把 3.1 的前缀 + slice IPC 拼成完整 DarkScript 文本 —— S35 起只作「拉齐」
 * 用（提交后的重读回灌），不再是打开路径：打开首帧只有前缀 + opaque token，
 * 按视口增量灌入与「查找/提交/脏标记时拉齐」走 incrementalSourceInjection。
 *
 * 常量仍在这里定义，incrementalSourceInjection 复用同一口径，避免两套
 * SOURCE_PREFIX_LINES / SOURCE_SLICE_LINES 漂移。
 */

export const SOURCE_PREFIX_LINES = 400;
/**
 * 单片续载行数。400 行时实测快速滚动追不上：一次续载 IPC（几十 ms）只补
 * 400 行，滚得快时视口撞到已加载末尾等下一片，出现空白。提到 1200 行后，
 * 单次 IPC 补 3 倍内容，同样滚动速度下留出的余量足以覆盖 IPC 往返。
 * main 侧 readSlice 按请求的 lineCount 切片，不受 400 限制。
 */
export const SOURCE_SLICE_LINES = 1200;

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
