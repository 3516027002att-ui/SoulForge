import { relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResourceKind } from '@soulforge/shared';

export function toPosixPath(pathValue: string): string {
  return pathValue.split(sep).join('/').replaceAll('\\\\', '/');
}

export function makeWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  return toPosixPath(relative(workspaceRoot, absolutePath));
}

export function makeFileResourceUri(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\\\', '/').replace(/^\/+/, '');
  return `file://${encodeURI(normalized)}`;
}

export function makeStableFileId(workspaceId: string, relativePath: string): string {
  return `${workspaceId}:${relativePath.replaceAll('\\\\', '/')}`;
}

export function makeWorkspaceId(workspaceRoot: string): string {
  // Keep this deterministic without hashing at startup. The absolute URL is safe for internal cache keys.
  return pathToFileURL(workspaceRoot).toString();
}

export function makeSymbolUri(kind: ResourceKind, scope: string, id: string | number): string {
  return `${kind}://${encodeURIComponent(scope)}/${encodeURIComponent(String(id))}`;
}
