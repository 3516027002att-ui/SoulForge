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

/**
 * 资源浏览器每页文件数。
 *
 * 为什么是分页而不是虚拟化：`scanWorkspace`（packages/core/src/workspace/scanWorkspace.ts）
 * 递归遍历工作区且**没有扩展名过滤、没有上限**，所以规模等于用户选的目录——
 * 实测 `mods/` 子目录 237 个文件，整个只狼解包树 9111 个文件。9111 个 `<button>`
 * 一次性建出属于硬约束 17 要挡的形态，但它同时也是**分页足以解决**的量级：
 * 每页 200 时最多 200 个 DOM 节点，与虚拟化的常驻节点数同一数量级，却不需要
 * 引入新依赖、不需要接管滚动容器、不会破坏浏览器原生的 Ctrl+F 与焦点顺序。
 *
 * 200 的取法：侧栏可视高度约容纳 15–20 行，一页 200 行意味着滚动约 10 屏——
 * 大于「翻页太频繁」的阈值，又远小于「DOM 过重」的阈值。
 */
export const FILE_LIST_PAGE_SIZE = 200;

/** 搜索结果面板的渲染上限。搜索是定位手段，不是浏览手段，故只截断不分页。 */
export const SEARCH_HIT_LIMIT = 60;

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

/** 列表被硬截断时的状态文案输入。 */
export interface ListTruncationInput {
  /** 过滤后的真实总数（不是原始总数——用户看到的比例要对得上当前筛选）。 */
  total: number;
  /** 本次实际渲染的条数。 */
  shown: number;
  /** 被截断项的名词，例如「条目」「纹理」「状态组」。 */
  noun: string;
  /**
   * 用户可用来缩小范围的手段。省略时不给建议——
   * 面板没有搜索框却提示「用搜索框缩小范围」属于编造可用动作。
   */
  hint?: string;
}

/**
 * 列表硬截断的状态文案。null 表示没有截断，调用方据此不渲染说明。
 *
 * 为什么要收成一个函数：截断说明散落在十余处面板里各写一遍时，实测的形态是
 * **多数面板干脆不写**——静默 `slice(0, N)` 只靠容器 `overflow` 挡住视觉，用户
 * 无从得知数据被砍。anti-ai-design §4「状态优先于概念」要求界面必须能回答
 * 「已解析多少」；只显示前 N 条却不说总数，用户会把部分当成全部。
 *
 * 文案给绝对数字而不是「还有更多」：后者仍然回答不了「多少」。
 */
export function formatListTruncation(input: ListTruncationInput): string | null {
  const { total, shown, noun } = input;
  if (!Number.isFinite(total) || !Number.isFinite(shown)) return null;
  if (total <= shown) return null;
  const hidden = total - shown;
  const suffix = input.hint ? `；${input.hint}` : '';
  return `已解析 ${total} ${noun}，显示前 ${shown} ${noun}（${hidden} ${noun}未显示）${suffix}。`;
}

/**
 * 分页导航的位置文案：回答「当前在第几页、这一页覆盖第几到第几、总共多少」。
 *
 * 只报页码（「第 3/12 页」）不够：用户无法判断自己漏看了哪一段。
 */
export function formatPageRange(input: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
}): string {
  const { page, pageSize, total, noun } = input;
  if (total <= 0) return `没有${noun}`;
  const first = page * pageSize + 1;
  const last = Math.min((page + 1) * pageSize, total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return `${noun} ${first}–${last} / 共 ${total}（第 ${page + 1}/${pageCount} 页，每页 ${pageSize}）`;
}
