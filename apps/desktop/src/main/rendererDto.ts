import type {
  BridgeResult,
  Diagnostic,
  EditorCatalogSummary,
  EditorDocumentResult,
  IndexedFile,
  PatchHistoryEntry,
  ResourcePreview,
  SaveTextResourceResult
} from '@soulforge/shared';

export type RendererIndexedFile = Omit<
  IndexedFile,
  'id' | 'workspaceId' | 'sourcePath' | 'absolutePath'
>;

export type RendererBridgeResult<T = unknown> = Omit<BridgeResult<T>, 'sourcePath'>;

export type RendererResourcePreview = Omit<
  ResourcePreview,
  'file' | 'nativeInspection' | 'diagnostics'
> & {
  file: RendererIndexedFile;
  nativeInspection?: RendererBridgeResult<unknown>;
  diagnostics: Diagnostic[];
};

export type RendererSaveResult = Omit<
  SaveTextResourceResult,
  'backupRoot' | 'changedFiles' | 'diagnostics'
> & {
  changedFiles: string[];
  diagnostics: Diagnostic[];
};

export type RendererPatchHistoryEntry = Omit<
  PatchHistoryEntry,
  'workspaceId' | 'changedPaths'
> & {
  changedPaths: string[];
};

const SOURCE_TEXT_KEYS = new Set([
  'dslTemplate',
  'draft',
  'nextDslTemplate'
]);

const SENSITIVE_PATH_KEYS = new Set([
  'absolutePath',
  'sourcePath',
  'targetPath',
  'backupPath',
  'workspaceRoot',
  'overlayRoot',
  'baseRoot',
  'stagingRoot',
  'backupRoot',
  'recoveryPath',
  'metadataPath',
  'storePath',
  // Model-service secrets must never reach renderer DTOs.
  'apiKey',
  'secret',
  'secretRef',
  'password',
  'token'
]);

export function toRendererIndexedFile(file: IndexedFile): RendererIndexedFile {
  return {
    sourceUri: file.sourceUri,
    game: file.game,
    resourceKind: file.resourceKind,
    parseStatus: file.parseStatus,
    diagnostics: sanitizeDiagnostics(file.diagnostics),
    relativePath: file.relativePath,
    extension: file.extension,
    compoundExtension: file.compoundExtension,
    formatKind: file.formatKind,
    formatLabel: file.formatLabel,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ...(file.sha256 ? { sha256: file.sha256 } : {})
  };
}

export function toRendererResourcePreview(preview: ResourcePreview): RendererResourcePreview {
  return {
    file: toRendererIndexedFile(preview.file),
    previewKind: preview.previewKind,
    ...(preview.text !== undefined ? { text: preview.text } : {}),
    ...(preview.hex !== undefined ? { hex: preview.hex } : {}),
    ...(preview.nativeInspection
      ? { nativeInspection: sanitizeRendererValue(preview.nativeInspection) as RendererBridgeResult<unknown> }
      : {}),
    ...(preview.structuredPreview !== undefined ? { structuredPreview: preview.structuredPreview } : {}),
    truncated: preview.truncated,
    bytesRead: preview.bytesRead,
    diagnostics: sanitizeDiagnostics(preview.diagnostics)
  };
}

export function toRendererSaveResult(
  result: SaveTextResourceResult,
  files: readonly IndexedFile[]
): RendererSaveResult {
  return {
    ok: result.ok,
    ...(result.opId ? { opId: result.opId } : {}),
    changedFiles: result.changedFiles.map((path) => pathToResourceLabel(path, files)),
    diagnostics: sanitizeDiagnostics(result.diagnostics),
    ...(result.graph
      ? { graph: sanitizeRendererValue(result.graph) as NonNullable<RendererSaveResult['graph']> }
      : {}),
    ...(result.risk
      ? { risk: sanitizeRendererValue(result.risk) as NonNullable<RendererSaveResult['risk']> }
      : {}),
    ...(result.requiresConfirmation !== undefined
      ? { requiresConfirmation: result.requiresConfirmation }
      : {})
  };
}

/**
 * CAT-05: EditorCatalog summary 的 renderer 投影。
 *
 * summary 本身已脱敏（resourceId 是工作区相对 file URI，不含盘符路径）；
 * 这里在通用 sanitizeRendererValue 之外显式过一遍类型化投影，作为 IPC 边界
 * 声明的出口。脱敏语义：renderer 拿到的永远是语义目录，不是物理路径。
 */
export function toRendererCatalogSummary(summary: EditorCatalogSummary): EditorCatalogSummary {
  return sanitizeRendererValue(summary) as EditorCatalogSummary;
}

/**
 * §14.4 DocumentStore 响应的 renderer 投影（DOCSTORE-04）。
 *
 * 请求侧由 shared decoder 校验后再进 store；响应侧在通用 sanitizeRendererValue
 * 之外再显式过一遍类型化投影——§14.4 DTO 本身已脱敏（documentHandle 是
 * opaque uuid，revision 是字符串，items 不含路径），这里作为 IPC 边界声明的
 * 类型化出口，避免 handler 返回 Promise<unknown> 旁路。
 */
export function toRendererEditorDocumentResult<T>(
  result: EditorDocumentResult<T>
): EditorDocumentResult<T> {
  return sanitizeRendererValue(result) as EditorDocumentResult<T>;
}

export function toRendererHistoryEntry(
  entry: PatchHistoryEntry,
  files: readonly IndexedFile[]
): RendererPatchHistoryEntry {
  return {
    opId: entry.opId,
    title: entry.title,
    author: entry.author,
    mode: entry.mode,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.committedAt ? { committedAt: entry.committedAt } : {}),
    ...(entry.rolledBackAt ? { rolledBackAt: entry.rolledBackAt } : {}),
    fileCount: entry.fileCount,
    changedPaths: entry.changedPaths.map((path) => pathToResourceLabel(path, files)),
    ...(entry.inverseOfOpId ? { inverseOfOpId: entry.inverseOfOpId } : {}),
    ...(entry.rollbackScope ? { rollbackScope: entry.rollbackScope } : {}),
    ...(entry.graphSummary ? { graphSummary: entry.graphSummary } : {})
  };
}

export function sanitizeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map((item) => ({
    severity: item.severity,
    code: item.code,
    message: sanitizeRendererString(item.message),
    ...(item.sourceUri ? { sourceUri: sanitizeRendererString(item.sourceUri) } : {}),
    ...(item.details !== undefined ? { details: sanitizeRendererValue(item.details) } : {})
  }));
}

/** Remove filesystem authority-bearing fields from generic Bridge/container DTOs. */
export function sanitizeRendererValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeRendererString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(sanitizeRendererValue);

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PATH_KEYS.has(key)) continue;
    // Internal workspace ids are currently file URLs and therefore reveal the root.
    if (key === 'workspaceId') continue;
    // 源码是内容，不是本机路径泄漏。70k 行 DarkScript 不得整串跑盘符/UNC 正则。
    if (SOURCE_TEXT_KEYS.has(key) && typeof child === 'string') {
      output[key] = child;
      continue;
    }
    output[key] = sanitizeRendererValue(child);
  }
  return output;
}

/**
 * 把含本机路径的字符串整条替换掉。
 *
 * 前置分隔符要求曾经是 `(^|[\s('"=])`——只认行首与 ASCII 空白/引号/括号/等号。
 * 问题是本仓库的诊断文案全是中文：`写入失败：D:\workspace\mod\a.fmg 被占用` 里
 * 驱动器盘符前面是全角冒号，不在那个字符类里，于是整条绝对路径原样进入渲染
 * 进程。UNC 同理（`占用（\\?\UNC\host\share\b.fmg）`）。这不会让任何断言变红，
 * 表现是安全边界静默漏一类最常见的载荷。
 *
 * 改为「盘符前不是 ASCII 字母或数字」这一条否定断言：
 *  - 任何标点、CJK 字符、行首都会被覆盖（真实泄漏形态）；
 *  - `pathD:\x` 这种把盘符当标识符后缀的情况仍不误报；
 *  - `file:///workspace/a.fmg` 这类工作区相对 URI 仍不误报（无盘符）。
 * 判据由 verify-desktop-security-runtime.mjs 用真实载荷运行期断言，不再靠
 * 「源码里提到过这个函数名」。
 */
function sanitizeRendererString(value: string): string {
  const containsWindowsDrivePath = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/.test(value);
  const containsUncOrDevicePath = /\\\\(?:[?.]\\)?[^\\/\s]+[\\/]/.test(value);
  const containsAbsoluteFileUri = /file:\/\/\/[A-Za-z]:\//i.test(value);
  return containsWindowsDrivePath || containsUncOrDevicePath || containsAbsoluteFileUri
    ? '[本机路径已隐藏]'
    : value;
}

function pathToResourceLabel(path: string, files: readonly IndexedFile[]): string {
  const match = files.find((file) => file.absolutePath === path || file.sourcePath === path);
  return match?.sourceUri ?? '[本机路径已隐藏]';
}
