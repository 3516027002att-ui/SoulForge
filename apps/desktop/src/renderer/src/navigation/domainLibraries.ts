/**
 * 语义领域的逻辑库列表（按后缀，与既有 workbench / selectEditor 判据同口径）。
 *
 * 这不是 renderer 自行做 EditorCatalog：领域栏仍只消费 DomainSummary。
 * 这里只把已经索引到的文件投影成「该领域可打开的逻辑库」，供侧栏点选。
 * 禁止用 .file-item（那个 class 是 Files 物理浏览的 e2e 钩子）。
 */
import type { EditorDomainId } from '@soulforge/shared';

export function isParamContainerPath(relativePath: string): boolean {
  const path = relativePath.toLowerCase();
  if (/\.gparam(\.dcx)?$/i.test(path)) return false;
  return /\.parambnd(\.dcx)?$/i.test(path)
    || /\.gameparambnd(\.dcx)?$/i.test(path)
    || /\.drawparambnd(\.dcx)?$/i.test(path);
}

export function isGparamPath(relativePath: string): boolean {
  return /\.gparam(\.dcx)?$/i.test(relativePath);
}

export function isTextLibraryPath(relativePath: string): boolean {
  return /\.(msgbnd|fmg)(\.dcx)?$/i.test(relativePath);
}

/**
 * R2 裁定：文本域默认只列出简中（路径段 `zhocn`，例如
 * `msg/zhocn/item.msgbnd.dcx`）；英语/日语整包延期到 V0.6。
 * 侧栏不得出现 `msg/japanese/...`、`msg/engus/...`。
 */
export function isZhocnTextPath(relativePath: string): boolean {
  return /(?:^|[\\/])zhocn[\\/]/i.test(relativePath);
}

export function isEventDocumentPath(relativePath: string): boolean {
  return /\.emevd(\.dcx)?$/i.test(relativePath);
}

export function isMapDocumentPath(relativePath: string): boolean {
  return /\.msb(\.dcx)?$/i.test(relativePath);
}

export function isScriptLibraryPath(relativePath: string): boolean {
  return /\.(luabnd|hks|lua)(\.dcx)?$/i.test(relativePath);
}

/**
 * 行为/动作域：T3（2026-08-15）行为 + 动画合并为「动作」，侧栏列
 * `anibnd|tae`（与隐藏域 animation 同口径）。behbnd/esd/hkxbnd 不再进
 * 动作侧栏，需要时走「文件」域（grok T3）。
 */
export function isBehaviorLibraryPath(relativePath: string): boolean {
  return /\.(tae|anibnd)(\.dcx)?$/i.test(relativePath);
}

/** 动画域（T3 后顶栏隐藏，保留给隐藏域/测试）。 */
export function isAnimationLibraryPath(relativePath: string): boolean {
  return /\.(tae|anibnd)(\.dcx)?$/i.test(relativePath);
}

export function isModelLibraryPath(relativePath: string): boolean {
  return /\.flver(\.dcx)?$/i.test(relativePath);
}

export function isTextureLibraryPath(relativePath: string): boolean {
  return /\.tpf(\.dcx)?$/i.test(relativePath);
}

export function isMaterialLibraryPath(relativePath: string): boolean {
  return /\.mtd(\.dcx)?$/i.test(relativePath);
}

export function isVfxLibraryPath(relativePath: string): boolean {
  return /\.fxr(\.dcx)?$/i.test(relativePath);
}

export function isGenericContainerPath(relativePath: string): boolean {
  if (!/\.(bnd|bdt|bhd)(\.dcx)?$/i.test(relativePath)) return false;
  return !isParamContainerPath(relativePath)
    && !isTextLibraryPath(relativePath)
    && !isTextureLibraryPath(relativePath)
    && !isScriptLibraryPath(relativePath)
    && !isAnimationLibraryPath(relativePath)
    && !isBehaviorLibraryPath(relativePath);
}

const DOMAIN_MATCHERS: Partial<Record<EditorDomainId, (path: string) => boolean>> = {
  // R1 裁定：PARAM 与 GPARAM 都进左侧「参数」逻辑库（顶栏已无独立 GPARAM）。
  param: (path) => isParamContainerPath(path) || isGparamPath(path),
  gparam: isGparamPath,
  // R2 裁定：文本域只列简中（zhocn）；japanese/engus 整包延期 V0.6。
  text: (path) => isTextLibraryPath(path) && isZhocnTextPath(path),
  event: isEventDocumentPath,
  map: isMapDocumentPath,
  script: isScriptLibraryPath,
  behavior: isBehaviorLibraryPath,
  animation: isAnimationLibraryPath,
  model: isModelLibraryPath,
  texture: isTextureLibraryPath,
  material: isMaterialLibraryPath,
  vfx: isVfxLibraryPath,
  container: isGenericContainerPath
};

/** 该领域侧栏应列出的逻辑库。project / files 不走这条列表。 */
export function filesForDomain<T extends { relativePath: string }>(
  domain: EditorDomainId,
  files: readonly T[]
): T[] {
  if (domain === 'project' || domain === 'files') return [];
  const match = DOMAIN_MATCHERS[domain];
  if (!match) return [];
  return files.filter((file) => match(file.relativePath));
}

/** PARAM 默认打开 GameParam 库；没有则取第一个 parambnd。 */
export function pickPreferredParamContainer<T extends { relativePath: string }>(
  files: readonly T[]
): T | null {
  const containers = files.filter((file) => isParamContainerPath(file.relativePath));
  const gameparam = containers.find((file) => /gameparam\.parambnd(\.dcx)?$/i.test(file.relativePath));
  return gameparam ?? containers[0] ?? null;
}

/** 侧栏显示名：去掉复合扩展，物理路径只进 title。 */
export function libraryDisplayName(relativePath: string): string {
  const base = relativePath.split(/[\\/]/).pop() ?? relativePath;
  return base
    .replace(/\.dcx$/i, '')
    .replace(/\.(parambnd|gameparambnd|drawparambnd|msgbnd|gparam|emevd|msb|flver|tpf|mtd|fxr|luabnd|anibnd|hkxbnd|behbnd|tae|esd|fmg|hks|lua)$/i, '');
}

/**
 * 侧栏逻辑库分组（R1 裁定后的参数域两级形态）。
 *
 * 用户裁定：参数域左侧**只有 PARAM 与 GPARAM 两个项**，GPARAM 点开后才出现
 * 各 bank 子选项——不能把 34 个 gparam 平铺在列表里把 gameparam 挤到下面。
 * 组标题常驻（保证「两个项」的形态稳定），组内文件在组展开后显示。
 */
export interface DomainLibraryGroup<T> {
  /** 稳定标识（展开状态按它记忆）。 */
  id: string;
  /** 组标题。 */
  label: string;
  /** 标题右侧次要说明（如 bank 数量）。 */
  hint?: string;
  /** 组内逻辑库。 */
  files: T[];
  /** 默认是否折叠；缺省 false（展开）。 */
  defaultCollapsed?: boolean;
}

/** 参数域的分组：PARAM（parambnd 容器，默认展开）+ GPARAM（bank，默认折叠）。 */
export function paramLibraryGroups<T extends { relativePath: string }>(
  files: readonly T[]
): Array<DomainLibraryGroup<T>> {
  const gparamFiles = files.filter((file) => isGparamPath(file.relativePath));
  return [
    {
      id: 'param',
      label: 'PARAM',
      files: files.filter((file) => isParamContainerPath(file.relativePath))
    },
    {
      id: 'gparam',
      label: 'GPARAM',
      ...(gparamFiles.length > 0 ? { hint: `${gparamFiles.length} banks` } : {}),
      files: gparamFiles,
      defaultCollapsed: true
    }
  ];
}
