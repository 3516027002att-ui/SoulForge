/**
 * 界面文案与列表过滤的纯函数。
 *
 * 从 App.tsx 搬出（纯搬移，无逻辑改动）。
 */
import type { ResourceKind } from '@soulforge/shared';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import type { ResourceMode } from '../navigation/resourceFamilies.js';

export function operationStatusLabel(status: string): string {
  return ({
    planned: '已计划',
    pending: '待处理',
    staged: '已暂存',
    validated: '已验证',
    committed: '已提交',
    rolled_back: '已回滚',
    failed: '失败',
    recovery_required: '需要恢复'
  } as Record<string, string>)[status] ?? status;
}

/**
 * 'all' 显示全部文件（含 unknown，不合并、不隐藏）；
 * 其余模式按顶层目录 resourceKind 精确过滤。
 */
export function filterFilesForMode(
  files: RendererIndexedFile[],
  mode: ResourceMode,
  query: string
): RendererIndexedFile[] {
  const normalized = query.trim().toLowerCase();
  return files.filter((file) => {
    if (mode !== 'all' && file.resourceKind !== mode) return false;
    if (!normalized) return true;
    return file.relativePath.toLowerCase().includes(normalized)
      || file.resourceKind.toLowerCase().includes(normalized)
      || file.formatLabel.toLowerCase().includes(normalized);
  });
}

export function shortenPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join('/')}`;
}

