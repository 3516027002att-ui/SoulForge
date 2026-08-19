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
 * 资源浏览器文件列表与搜索结果都全量渲染（问题 5：显示不设限），不再有分页
 * 或条数上限常量。列表自身 overflow-y: auto 滚动；筛选作用于完整集合。
 */

export function shortenPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join('/')}`;
}

/**
 * Files 领域物理浏览的数量文案（§3.3：数量带语义单位，顶部领域栏不显示）。
 *
 * 领域栏禁止无单位文件数（PARAM 36 / 容器 221 那类）；Files 领域内部的
 * 物理浏览是数量唯一合法出现的场合，且必须带单位。
 */
export function formatFilesCount(count: number): string {
  return `文件 ${count} 个`;
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
