import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build a Windows-safe file name for a workspace operation log.
 * Workspace ids are typically file:// URLs from makeWorkspaceId; those contain
 * ":" and "/" which cannot be used as a path segment on Windows.
 */
export function operationLogFileNameForWorkspace(workspaceId: string): string {
  const hash = createHash('sha256').update(workspaceId).digest('hex').slice(0, 16);
  const leaf = readableWorkspaceLeaf(workspaceId);
  const safeLeaf = leaf
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 64) || 'workspace';
  return `${safeLeaf}-${hash}.json`;
}

/**
 * Resolve the full store path under a logs directory (e.g. userData/operation-logs).
 * This is the shipped path builder used by desktop main and covered by persist smoke.
 */
export function resolveOperationLogStorePath(logsDirectory: string, workspaceId: string): string {
  return join(logsDirectory, operationLogFileNameForWorkspace(workspaceId));
}

function readableWorkspaceLeaf(workspaceId: string): string {
  if (workspaceId.startsWith('file:')) {
    try {
      return basename(fileURLToPath(workspaceId)) || 'workspace';
    } catch {
      // Fall through to URI-ish parsing.
    }
  }

  const normalized = workspaceId.replaceAll('\\', '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'workspace';
}
