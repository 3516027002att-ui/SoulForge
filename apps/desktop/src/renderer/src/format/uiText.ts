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


/** 人类可读字节数。整数 KiB/MiB 不带小数，避免「1.0 MiB」这种噪声。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

/**
 * 预览被截断时的状态文案。
 *
 * 原文案是「预览只读取文件前缀，确保大型 DCX/BND 等二进制文件也能安全打开」——
 * 它解释了**为什么**截断，却没回答**截断到什么程度**。anti-ai-design 的状态优先
 * 原则要求界面能回答「已解析多少」，而用户看不到数字就无法判断自己看到的是
 * 全部的一半还是万分之一。
 *
 * fileSize 缺失时只报已读量并明说总量未知，不猜、不省略这个事实。
 */
export function formatPreviewTruncation(bytesRead: number, fileSize?: number): string {
  const shown = `已读取前 ${formatBytes(bytesRead)}`;
  if (fileSize === undefined || !Number.isFinite(fileSize) || fileSize <= 0) {
    return `${shown}；文件总大小未知，预览只覆盖前缀。`;
  }
  const pct = fileSize > 0 ? (bytesRead / fileSize) * 100 : 0;
  const pctText = pct >= 10 ? pct.toFixed(0) : pct >= 0.1 ? pct.toFixed(1) : '<0.1';
  return `${shown} / 共 ${formatBytes(fileSize)}（${pctText}%）；预览只覆盖前缀，未读部分不参与解析与编辑判定。`;
}
