import { KNOWN_RESOURCE_DIRS, type ResourceKind } from '@soulforge/shared';

/**
 * SHELL-09：物理资源 taxonomy 只服务 Files 领域的物理浏览。
 *
 * §16 迁移表：本文件从领域栏 production 依赖中移除——语义领域（PARAM/Text/
 * Event/...）不再按物理目录过滤；只有 Files 领域复用这套物理 taxonomy 做
 * 高级过滤。domainNavigation 不得引用本模块（domainNavigation.test.ts 对账）。
 */
export type ResourceMode = 'all' | ResourceKind;

export interface ResourceFamily {
  id: ResourceMode;
  /** 标签保持目录原名与小写，不追加中文说明。 */
  label: string;
}

/**
 * 固定显示顺序：Files 领域物理过滤条与命令面板共用的唯一配置源。
 * 'all' 之后必须与 core KNOWN_RESOURCE_DIRS 一一对应，
 * renderer 不复制路径分类算法。
 */
const RESOURCE_FAMILY_ORDER: readonly ResourceMode[] = [
  'all', 'event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai', 'chr', 'obj', 'sfx', 'other'
];

const KNOWN_DIR_SET: ReadonlySet<string> = new Set(KNOWN_RESOURCE_DIRS);

function auditFamilyOrder(): void {
  const missing = KNOWN_RESOURCE_DIRS.filter((dir) => !RESOURCE_FAMILY_ORDER.includes(dir));
  const extra = RESOURCE_FAMILY_ORDER.filter((id) => id !== 'all' && !KNOWN_DIR_SET.has(id));
  if (missing.length > 0 || extra.length > 0) {
    // 配置漂移不崩溃渲染进程，但必须在控制台留下可追溯诊断。
    console.error('resourceFamilies: 显示顺序与 KNOWN_RESOURCE_DIRS 不一致', { missing, extra });
  }
}

auditFamilyOrder();

export const RESOURCE_FAMILIES: readonly ResourceFamily[] = RESOURCE_FAMILY_ORDER.map((id) => ({
  id,
  label: id
}));

export function resourceModeLabel(mode: ResourceMode): string {
  return mode;
}

export function isResourceMode(value: string): value is ResourceMode {
  return (RESOURCE_FAMILY_ORDER as readonly string[]).includes(value);
}
