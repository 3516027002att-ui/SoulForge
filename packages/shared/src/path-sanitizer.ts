/**
 * 路径脱敏（S13）：preload 与 main 共用同一套规则 —— 只打码路径片段，
 * 保留诊断上下文。
 *
 * 旧实现两侧各写一份且都是「检测到路径就整条字符串替换」：
 * `写入失败：D:\workspace\mod\a.fmg 被占用` 会整条变成
 * `[本机路径已隐藏]`，用户看不到「写入失败…被占用」的其余语义。
 * 这里统一为片段替换：路径部分换成占位符，上下文原样保留。
 *
 * 片段终止规则：路径从盘符 / UNC / 设备前缀 / file:/// URI 起，遇到
 * 空白、引号、括号（半角/全角）、中文标点即结束 —— 路径内的汉字
 * （D:\游戏\mods\a.fmg）不终止，中文标点（。，、；：！？）终止。
 *
 * 打码的是本机路径形态（盘符绝对路径 / UNC / 设备路径 / 盘符 file URI）；
 * 工作区相对 URI（file:///workspace/a.fmg）不含盘符，不匹配任何规则，
 * 原样保留 —— 它是逻辑地址不是本机路径。
 */

/** 本机路径占位符（各端共用同一文案，UI 里也按它做特殊显示）。 */
export const MASKED_PATH_PLACEHOLDER = '[本机路径已隐藏]';

/** 盘符绝对路径：D:\x、D:/x（盘符前不是字母数字 —— 覆盖全角冒号/CJK 前缀）。 */
const WINDOWS_DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"()（）\[\]「」『』，。、；：！？]*/g;

/** UNC / 设备路径：\\host\share\x、\\?\UNC\host\share\x、\\.\device\x。 */
const UNC_OR_DEVICE_PATH = /\\\\(?:[?.]\\)?[^\\/\s]+[\\/][^\s'"()（）\[\]「」『』，。、；：！？]*/g;

/** 盘符 file URI：file:///D:/x（无盘符的工作区 URI 不匹配）。 */
const ABSOLUTE_FILE_URI = /file:\/\/\/[A-Za-z]:\/[^\s'"()（）\[\]「」『』，。、；：！？]*/gi;

/**
 * 把字符串里的本机路径片段替换为占位符，上下文原样保留。
 * 无路径时原样返回。
 */
export function maskPathFragments(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(ABSOLUTE_FILE_URI, MASKED_PATH_PLACEHOLDER)
    .replace(WINDOWS_DRIVE_PATH, MASKED_PATH_PLACEHOLDER)
    .replace(UNC_OR_DEVICE_PATH, MASKED_PATH_PLACEHOLDER);
}
