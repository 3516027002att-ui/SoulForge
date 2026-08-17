/** 渲染器可见文案里的本机路径占位符。 */
export const HIDDEN_PATH_PLACEHOLDER = '[本机路径已隐藏]';

const PATH_SPAN =
  /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/][^\s'"<>|]+|\\\\(?:[?.]\\)?[^\\/\s]+[\\/][^\s'"<>|]+|file:\/\/\/[A-Za-z]:\/[^\s'"<>|]+)/g;

/**
 * 只打码路径跨度，前后中文留下。整串就是盘符/UNC/打包机路径时整串换成占位符。
 * `file:///workspace/a.fmg` 这类相对 URI 原样保留。
 */
export function maskAbsolutePathSpans(value: string): string {
  const trimmed = value.trim();
  if (/^(?:[A-Za-z]:[\\/]|\\\\|N:\\)/.test(trimmed) && !/\s/.test(trimmed)) {
    return HIDDEN_PATH_PLACEHOLDER;
  }
  return value.replace(PATH_SPAN, HIDDEN_PATH_PLACEHOLDER);
}
