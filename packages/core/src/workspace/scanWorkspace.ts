import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic, IndexedFile, ResourceKind, ScanProgress, WorkspaceScanResult } from '@soulforge/shared';
import { detectResourceFileType } from './resourceFileTypes.js';
import { ALL_RESOURCE_KINDS, classifyResourceKind, KNOWN_RESOURCE_DIRS } from './resourceKinds.js';
import {
  makeFileResourceUri,
  makeStableFileId,
  makeWorkspaceId,
  makeWorkspaceRelativePath,
  toPosixPath
} from './resourceUri.js';

export interface ScanWorkspaceOptions {
  workspaceRoot: string;
  includeKinds?: readonly ResourceKind[];
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
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

  files.push({
    id: makeStableFileId(workspaceId, relativePath),
    workspaceId,
    sourceUri,
    sourcePath: absolutePath,
    absolutePath,
    relativePath,
    game: 'unknown',
    resourceKind,
    extension: fileType.extension,
    compoundExtension: fileType.compoundExtension,
    formatKind: fileType.formatKind,
    formatLabel: fileType.formatLabel,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    parseStatus: 'unparsed',
    diagnostics: []
  });

  options.onProgress?.({ scannedFiles: files.length, currentPath: toPosixPath(relativePath) });
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
