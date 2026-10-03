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
 * 打码 Windows、POSIX 与物理 file URI；保留相对资源 URI 和显式支持的
 * file:///workspace 逻辑命名空间，但不能通过编码或 .. 逃逸该命名空间。
 */

/** 本机路径占位符（各端共用同一文案，UI 里也按它做特殊显示）。 */
export const MASKED_PATH_PLACEHOLDER = '[本机路径已隐藏]';

/** 盘符绝对路径：D:\x、D:/x（盘符前不是字母数字 —— 覆盖全角冒号/CJK 前缀）。 */
const WINDOWS_DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"()（）\[\]「」『』，。、；：！？]*/g;

/** UNC / 设备路径：\\host\share\x、\\?\UNC\host\share\x、\\.\device\x。 */
const UNC_OR_DEVICE_PATH = /\\\\(?:[?.]\\)?[^\\/\s]+[\\/][^\s'"()（）\[\]「」『』，。、；：！？]*/g;

/** Match a whole URI before looking for slash paths within it. */
const URI = /[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\s'"()（）\[\]「」『』，。、；！？]|\[[A-Za-z0-9_.:%-]+\])*/;
const POSIX_PATH = /(?<![A-Za-z0-9_./:%\\-])\/[^\s'"()（）\[\]「」『』，。、；：！？]+/;
const URI_OR_PATH = new RegExp(
  [URI.source, WINDOWS_DRIVE_PATH.source, UNC_OR_DEVICE_PATH.source, POSIX_PATH.source].join('|'), 'g'
);

// These directory authorities are the shared/types.ts KNOWN_RESOURCE_DIRS
// consumed by scanWorkspace + makeFileResourceUri. Keep this module standalone
// for the main/preload source-bound loaders; tests cover every declared directory.
const LOGICAL_RESOURCE_AUTHORITIES = new Set([
  'event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai',
  'sfx', 'chr', 'obj', 'other'
]);

// Root-file labels also come from makeFileResourceUri (for example regulation.bin,
// standalone HKS, or pack.bnd#bnd/child). Suffixes follow resourceFileTypes and the
// editor catalog; they identify logical labels, not native parsing authority.
const LOGICAL_ROOT_FILE = /\.(?:bin|bnd|dcx|flver|msb|param|fmg|lua|hks|emevd|esd|tae|tpf|dds|gfx|gparam|mtd|matbin|fxr|txt|md|json|xml|yml|yaml|js|ts|csv|ini|cfg|toml|log|bak|prev)$/i;

function decodeUriComponent(value: string): string | undefined {
  let decoded = value;
  try {
    for (let depth = 0; depth < 4; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch { return undefined; }
  return /%[0-9a-f]{2}/i.test(decoded) ? undefined : decoded;
}

function isLogicalFileUri(value: string): boolean {
  const decoded = decodeUriComponent(value);
  if (!decoded || decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)
    || decoded.split(/[/?#]/).some(segment => segment === '.' || segment === '..')) return false;

  const match = /^file:\/\/([^/?#]*)(.*)$/i.exec(value);
  if (!match) return false;
  const authority = match[1]!;
  const suffix = match[2]!;
  if (authority === '') return /^file:\/\/\/workspace(?:\/|$)/i.test(value);
  if (LOGICAL_RESOURCE_AUTHORITIES.has(authority.toLowerCase())) return true;
  // Actual no-source labels from Bridge ParserTypes and the EMEVD outline.
  if (/^(?:unknown|resource)$/i.test(authority) && suffix === '') return true;

  const containerChild = authority.endsWith('!') && suffix.startsWith('/');
  // A file-looking network host with an ordinary /share/path is still physical.
  if (suffix.startsWith('/') && !containerChild) return false;
  // Decode the raw authority on its own, so an encoded separator cannot move
  // a server/share path into the root-file or fragment forms above.
  const decodedAuthority = decodeUriComponent(authority);
  if (!decodedAuthority || /[\\/:?#@]/.test(decodedAuthority)) return false;
  const filename = containerChild ? decodedAuthority.slice(0, -1) : decodedAuthority;
  return LOGICAL_ROOT_FILE.test(filename);
}

/**
 * 把字符串里的本机路径片段替换为占位符，上下文原样保留。
 * 无路径时原样返回。
 */
export function maskPathFragments(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!text.includes(':') && !text.includes('\\') && !text.includes('/')) return text;
  return text.replace(URI_OR_PATH, value => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
      return !/^file:/i.test(value) || isLogicalFileUri(value) ? value : MASKED_PATH_PLACEHOLDER;
    }
    return MASKED_PATH_PLACEHOLDER;
  });
}
