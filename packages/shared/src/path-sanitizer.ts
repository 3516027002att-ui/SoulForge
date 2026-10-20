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

// Binary authority comes from the registered IPC response contract, never a
// field name or a schema/channel supplied inside the returned object. Both
// "/tmp/private" and real geometry can be syntactically valid base64.
type BinaryPath = readonly (string | number)[];
type BinaryRule = { path: readonly string[]; encoding: 'base64' | 'png' };
const binaryRules = (root: readonly string[], fields: readonly string[], encoding: BinaryRule['encoding'] = 'base64'): BinaryRule[] =>
  fields.map(field => ({ path: [...root, field], encoding }));
const GEOMETRY_FIELDS = ['positionsBase64', 'indicesBase64', 'uvsBase64', 'normalsBase64'];
function meshBinaryRules(root: readonly string[]): BinaryRule[] {
  return [
    ...binaryRules(root, [...GEOMETRY_FIELDS, 'boneIndicesBase64', 'boneWeightsBase64', 'vertexAlphaBase64']),
    ...binaryRules([...root, 'uvSetsBase64'], ['*']),
    ...binaryRules([...root, 'positionDiagnostics', '*'], ['xyzBase64', 'normalWBase64']),
    ...binaryRules([...root, 'normalDiagnostics', '*'], ['xyzBase64', 'normalWBase64']),
    ...binaryRules([...root, 'tangentDiagnostics', '*'], ['xyzwBase64']),
    ...binaryRules([...root, 'bitangentDiagnostics', '*'], ['xyzwBase64']),
    ...binaryRules([...root, 'vertexColorDiagnostics', '*'], ['rgbaBase64'])
  ];
}
const RENDERER_BINARY_PROFILES = new Map<string, readonly BinaryRule[]>([
  ['resource.readMapStaticGeometry', [
    ...binaryRules(['data', 'chunks', '*'], GEOMETRY_FIELDS),
    ...binaryRules(['data', 'chunks', '*'], ['texturePreviewToken'], 'png'),
    ...binaryRules(['data'], ['texturePreviewToken'], 'png')
  ]],
  ['resource.readFlverMesh', [
    ...meshBinaryRules(['data']),
    ...binaryRules(['data'], ['texturePreviewToken', 'mask1TexturePreviewToken', 'albedo2TexturePreviewToken', 'normal2TexturePreviewToken'], 'png')
  ]],
  ['resource.readMapPartMesh', meshBinaryRules(['data'])],
  ['resource.readTaeChrbndPreview', [
    ...meshBinaryRules(['data', 'models', '*', 'meshes', '*']),
    ...binaryRules(['data', 'models', '*', 'meshes', '*'], ['sourceBoneIndicesBase64']),
    ...binaryRules(['data', 'models', '*', 'meshes', '*'], ['projectionTexturePreviewToken'], 'png'),
    ...binaryRules(['data', 'models', '*'], ['texturePreviewToken'], 'png'),
    ...binaryRules(['data', 'models', '*', 'texturePreviews', '*'],
      ['texturePreviewToken', 'normalTexturePreviewToken', 'metalnessTexturePreviewToken', 'mask1TexturePreviewToken'], 'png'),
    ...binaryRules(['data', 'models', '*', 'texturePreviews', '*', 'albedo2'], ['texturePreviewToken'], 'png'),
    ...binaryRules(['data', 'models', '*', 'texturePreviews', '*', 'normal2'], ['texturePreviewToken'], 'png')
  ]],
  ['resource.readTaeAnimationClip', binaryRules(['data'], ['splineRawPayloadBase64'])],
  ['resource.readTpfTexturePreview', binaryRules(['data'], ['previewToken'], 'png')],
  ['document.readContent', binaryRules(['value'], ['previewToken'], 'png')],
  ['resource.readParamDocument', binaryRules(['data', 'rows', '*'], ['dataBase64'])],
  ['resource.readParamPage', binaryRules(['rows', '*'], ['dataBase64'])],
  ['resource.readContainerParamPage', binaryRules(['rows', '*'], ['dataBase64'])],
  ['resource.readParamRows', binaryRules(['rows', '*'], ['dataBase64'])],
  ['resource.readEmevdDocument', binaryRules(['data', 'instructionsSample', '*'], ['argsBase64'])],
  ['resource.readRawRange', binaryRules([], ['base64'])]
]);

/** Generic diagnostics are text, even when nested below a declared binary DTO. */
export function isRendererDiagnosticContext(key: string): boolean {
  return /^(?:diagnostics?|details?|errors?)$/i.test(key);
}
function isEncodedBytes(value: unknown): value is string {
  // No generic "endsWith(Base64)" bypass and no exemption for malformed text.
  // This flat expression has no repeated groups (large geometry must not blow
  // the regexp stack). Native DTOs use standard padded base64.
  return typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
export function isRendererBinaryPayload(channel: string, path: BinaryPath, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (path.some(part => typeof part === 'string' && isRendererDiagnosticContext(part))) return false;
  const rule = RENDERER_BINARY_PROFILES.get(channel)?.find(candidate =>
    candidate.path.length === path.length && candidate.path.every((part, index) =>
      part === '*' ? typeof path[index] === 'number' : part === path[index]));
  if (!rule) return false;
  if (rule.encoding === 'base64') return isEncodedBytes(value);
  const prefix = 'data:image/png;base64,';
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
    && isEncodedBytes(value.slice(prefix.length));
}

/** 盘符绝对路径：D:\x、D:/x（盘符前不是字母数字 —— 覆盖全角冒号/CJK 前缀）。 */
const WINDOWS_DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"()（）\[\]「」『』，。、；：！？]*/g;

/** UNC / 设备路径：\\host\share\x、\\?\UNC\host\share\x、\\.\device\x。 */
const UNC_OR_DEVICE_PATH = /\\\\(?:[?.]\\)?[^\\/\s]+[\\/][^\s'"()（）\[\]「」『』，。、；：！？]*/g;

/** Match a whole URI before looking for slash paths within it. */
const URI = /[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\s'"()（）\[\]「」『』，。、；！？]|\[[A-Za-z0-9_.:%-]+\])*/;
// A colon may introduce a diagnostic path (failed:/tmp/x). URI_OR_PATH matches complete
// URIs first, and PHYSICAL_URI_SELECTOR reuses this pattern so label:/abs selectors stay physical.
const POSIX_PATH = /(?<![A-Za-z0-9_./%\\-])\/[^\s'"()（）\[\]「」『』，。、；：！？]+/;
/** URI metadata and container children must remain relative selectors. */
const PHYSICAL_URI_SELECTOR = new RegExp(
  [WINDOWS_DRIVE_PATH.source, POSIX_PATH.source, '//', '(?:^|[=&])/'].join('|')
);
const ABSOLUTE_URI_SUFFIX = new RegExp([WINDOWS_DRIVE_PATH.source, '^/', '//'].join('|'));
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

  // A logical authority does not grant query/fragment data filesystem authority.
  // Inspect fully decoded selectors separately from the logical URI's own /path.
  const selectors = [...decoded.split(/[?#]/).slice(1), ...decoded.split('!/').slice(1)];
  if (selectors.some(selector => PHYSICAL_URI_SELECTOR.test(selector))) return false;

  const match = /^file:\/\/([^/?#]*)(.*)$/i.exec(value);
  if (!match) return false;
  const authority = match[1]!;
  const suffix = match[2]!;
  const decodedSuffix = decodeUriComponent(suffix);
  if (decodedSuffix === undefined) return false;
  // One slash separates the logical namespace from its relative resource path.
  // Decoding must not reveal an extra root slash or an embedded absolute drive.
  const relativeSuffix = decodedSuffix.startsWith('/') ? decodedSuffix.slice(1) : decodedSuffix;
  if (ABSOLUTE_URI_SUFFIX.test(relativeSuffix)) return false;
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
