import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic, IndexedFile, ResourceKind, ScanProgress, WorkspaceScanResult } from '@soulforge/shared';
import { detectResourceFileType } from './resourceFileTypes.js';
import { ALL_RESOURCE_KINDS, classifyResourceKind, detectArtifactMarkers, KNOWN_RESOURCE_DIRS } from './resourceKinds.js';
import {
  makeFileResourceUri,
  makeStableFileId,
  makeWorkspaceId,
  makeWorkspaceRelativePath,
  toPosixPath
} from './resourceUri.js';

/**
 * Initial workspace discovery is a catalog operation, not a content-verification
 * operation. Large FromSoftware containers can be hundreds of MiB, so reading
 * every byte only to populate an optional catalog hash makes application startup
 * proportional to the total workspace size.
 *
 * Small files are still hashed eagerly by default because that is cheap and keeps
 * existing fixtures / text-resource behavior unchanged. Large binary assets defer
 * their authoritative hash to the actual open/read/write path, where the native
 * document already computes a source hash from the bytes it consumes.
 */
const DEFAULT_EAGER_HASH_LIMIT_BYTES = 1024 * 1024;

export interface ScanWorkspaceOptions {
  workspaceRoot: string;
  game?: string;
  includeKinds?: readonly ResourceKind[];
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  /**
   * Maximum file size that is SHA-256 hashed during catalog discovery.
   * Set to Infinity for the historical full-workspace hashing behavior, or 0
   * for metadata-only discovery. `IndexedFile.sha256` is optional by contract.
   */
  eagerHashLimitBytes?: number;
}

export async function scanWorkspace(options: ScanWorkspaceOptions): Promise<WorkspaceScanResult> {
  const workspaceRoot = options.workspaceRoot;
  const workspaceId = makeWorkspaceId(workspaceRoot);
  const diagnostics: Diagnostic[] = [];
  const files: IndexedFile[] = [];

  if (options.includeKinds && options.includeKinds.length > 0) {
    await scanKnownResourceDirectories(options, workspaceRoot, workspaceId, files, diagnostics);
  } else {
    await scanWholeWorkspace(options, workspaceRoot, workspaceId, files, diagnostics);
  }

  return {
    workspaceId,
    workspaceRoot,
    files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    diagnostics,
    countsByKind: countByKind(files)
  };
}

async function scanKnownResourceDirectories(
  options: ScanWorkspaceOptions,
  workspaceRoot: string,
  workspaceId: string,
  files: IndexedFile[],
  diagnostics: Diagnostic[]
): Promise<void> {
  const includeKinds = new Set<ResourceKind>(options.includeKinds ?? KNOWN_RESOURCE_DIRS);

  for (const kind of includeKinds) {
    throwIfAborted(options.signal);
    const directoryPath = join(workspaceRoot, kind);

    if (!(await pathIsDirectory(directoryPath))) {
      diagnostics.push({
        severity: 'info',
        code: 'RESOURCE_DIR_MISSING',
        message: `Resource directory '${kind}' does not exist in this workspace.`,
        details: { kind, directoryPath }
      });
      continue;
    }

    await walkDirectory(directoryPath, diagnostics, async (absolutePath) => {
      await addIndexedFile(options, workspaceRoot, workspaceId, absolutePath, files, diagnostics);
    }, options.signal);
  }
}

async function scanWholeWorkspace(
  options: ScanWorkspaceOptions,
  workspaceRoot: string,
  workspaceId: string,
  files: IndexedFile[],
  diagnostics: Diagnostic[]
): Promise<void> {
  if (!(await pathIsDirectory(workspaceRoot))) {
    diagnostics.push({
      severity: 'error',
      code: 'WORKSPACE_ROOT_NOT_DIRECTORY',
      message: 'Workspace root is not a readable directory.',
      details: { workspaceRoot }
    });
    return;
  }

  await walkDirectory(workspaceRoot, diagnostics, async (absolutePath) => {
    await addIndexedFile(options, workspaceRoot, workspaceId, absolutePath, files, diagnostics);
  }, options.signal);
}

async function addIndexedFile(
  options: ScanWorkspaceOptions,
  workspaceRoot: string,
  workspaceId: string,
  absolutePath: string,
  files: IndexedFile[],
  diagnostics: Diagnostic[]
): Promise<void> {
  throwIfAborted(options.signal);

  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'FILE_STAT_FAILED',
      message: error instanceof Error ? error.message : 'Failed to stat file during workspace scan.',
      details: { absolutePath }
    });
    return;
  }

  if (!fileStat.isFile()) return;

  const relativePath = makeWorkspaceRelativePath(workspaceRoot, absolutePath);
  const resourceKind = classifyResourceKind(relativePath);
  const fileType = detectResourceFileType(relativePath);
  const sourceUri = makeFileResourceUri(relativePath);

  // CAT-05：只附加 artifact/source variant 基础标记，不改变物理 ResourceKind。
  // scanWorkspace 只扫 overlay 层（base 由调用方挂载后另行提供），因此
  // sourceLayer 恒为 'overlay'。
  const artifactMarkers = detectArtifactMarkers({ relativePath, sourceLayer: 'overlay' });

  const eagerHashLimit = normalizeEagerHashLimit(options.eagerHashLimitBytes);
  let sha256: string | undefined;
  if (fileStat.size <= eagerHashLimit) {
    try {
      sha256 = await sha256File(absolutePath);
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'FILE_HASH_FAILED',
        message: error instanceof Error ? error.message : 'Failed to hash file during workspace scan.',
        details: { absolutePath }
      });
      return;
    }
  }

  files.push({
    id: makeStableFileId(workspaceId, relativePath),
    workspaceId,
    sourceUri,
    sourcePath: absolutePath,
    absolutePath,
    relativePath,
    game: options.game ?? 'unknown',
    resourceKind,
    extension: fileType.extension,
    compoundExtension: fileType.compoundExtension,
    formatKind: fileType.formatKind,
    formatLabel: fileType.formatLabel,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ...(sha256 ? { sha256 } : {}),
    parseStatus: 'unparsed',
    diagnostics: [],
    ...(artifactMarkers ? { artifactMarkers } : {})
  });

  options.onProgress?.({ scannedFiles: files.length, currentPath: toPosixPath(relativePath) });
}

function normalizeEagerHashLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EAGER_HASH_LIMIT_BYTES;
  if (value === Infinity) return Infinity;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function walkDirectory(
  directoryPath: string,
  diagnostics: Diagnostic[],
  onFile: (absolutePath: string) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'DIRECTORY_READ_FAILED',
      message: error instanceof Error ? error.message : 'Failed to read directory during workspace scan.',
      details: { directoryPath }
    });
    return;
  }

  for (const entry of entries) {
    throwIfAborted(signal);
    const absolutePath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.toLowerCase() === '$recycle.bin') {
        continue;
      }
      await walkDirectory(absolutePath, diagnostics, onFile, signal);
      continue;
    }

    if (entry.isFile()) {
      await onFile(absolutePath);
    }
  }
}

async function pathIsDirectory(pathValue: string): Promise<boolean> {
  try {
    return (await stat(pathValue)).isDirectory();
  } catch {
    return false;
  }
}

function countByKind(files: IndexedFile[]): Record<ResourceKind, number> {
  const counts = Object.fromEntries(ALL_RESOURCE_KINDS.map((kind) => [kind, 0])) as Record<ResourceKind, number>;

  for (const file of files) {
    counts[file.resourceKind] += 1;
  }

  return counts;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Workspace scan aborted.');
  }
}
