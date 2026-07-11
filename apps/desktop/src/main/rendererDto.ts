import type {
  BridgeResult,
  Diagnostic,
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
    output[key] = sanitizeRendererValue(child);
  }
  return output;
}

function sanitizeRendererString(value: string): string {
  const containsWindowsDrivePath = /(^|[\s('"=])(?:[A-Za-z]:[\\/])/.test(value);
  const containsUncOrDevicePath = /(^|[\s('"=])\\\\(?:[?.]\\)?[^\\/\s]+[\\/]/.test(value);
  const containsAbsoluteFileUri = /file:\/\/\/[A-Za-z]:\//i.test(value);
  return containsWindowsDrivePath || containsUncOrDevicePath || containsAbsoluteFileUri
    ? '[本机路径已隐藏]'
    : value;
}

function pathToResourceLabel(path: string, files: readonly IndexedFile[]): string {
  const match = files.find((file) => file.absolutePath === path || file.sourcePath === path);
  return match?.sourceUri ?? '[本机路径已隐藏]';
}
