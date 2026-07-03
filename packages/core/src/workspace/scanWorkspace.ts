import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Diagnostic, IndexedFile, ResourceKind, ScanProgress, WorkspaceScanResult } from '@soulforge/shared';
import { classifyResourceKind, KNOWN_RESOURCE_DIRS } from './resourceKinds.js';
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
  const includeKinds = new Set<ResourceKind>(options.includeKinds ?? KNOWN_RESOURCE_DIRS);
  const diagnostics: Diagnostic[] = [];
  const files: IndexedFile[] = [];

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

    await walkDirectory(directoryPath, async (absolutePath) => {
      throwIfAborted(options.signal);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) return;

      const relativePath = makeWorkspaceRelativePath(workspaceRoot, absolutePath);
      const resourceKind = classifyResourceKind(relativePath);
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
        extension: extname(absolutePath).toLowerCase(),
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        parseStatus: 'unparsed',
        diagnostics: []
      });

      options.onProgress?.({ scannedFiles: files.length, currentPath: toPosixPath(relativePath) });
    });
  }

  return {
    workspaceId,
    workspaceRoot,
    files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    diagnostics,
    countsByKind: countByKind(files)
  };
}

async function walkDirectory(directoryPath: string, onFile: (absolutePath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      await walkDirectory(absolutePath, onFile);
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
  const counts: Record<ResourceKind, number> = {
    event: 0,
    map: 0,
    param: 0,
    msg: 0,
    menu: 0,
    script: 0,
    action: 0,
    ai: 0,
    sfx: 0,
    unknown: 0
  };

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
