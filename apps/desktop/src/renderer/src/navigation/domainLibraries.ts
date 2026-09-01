/**
 * 语义领域的逻辑库列表（按后缀 / 路径段，与既有 workbench / selectEditor
 * 判据同口径；S39 起 script/behavior 两个域按路径段细分）。
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

export function isEventDocumentPath(relativePath: string): boolean {
  return /\.emevd(\.dcx)?$/i.test(relativePath);
}

export function isMapDocumentPath(relativePath: string): boolean {
  return /\.msb(\.dcx)?$/i.test(relativePath);
}

/**
 * S39（2026-08-18）：脚本域按路径段判定——只有 `script/` 目录下的
 * `.luabnd(.dcx)` 容器与明文 `.lua` 才进「脚本」侧栏。`action/script/*.hks`
 * 是动作脚本，归「动作」域（见 isBehaviorLibraryPath）；`script/talk/*.talkesdbnd.dcx`
 * 走 ESD，也不进脚本域。裸 `.hks` 一律不是脚本库（即使带 .dcx）。
 */
export function isScriptLibraryPath(relativePath: string): boolean {
  if (!/(?:^|[\\/])script[\\/]/i.test(relativePath)) return false;
  return /\.(luabnd|lua)(\.dcx)?$/i.test(relativePath);
}

/**
 * 动作脚本（HKS）判定：`action/` 路径下的 `.hks(.dcx)`（如
 * `action/script/c0000_transition.hks`）。独立半判据，供动作侧栏分组用。
 */
export function isActionScriptPath(relativePath: string): boolean {
  return (/(?:^|[\\/])action[\\/]/i.test(relativePath) && /\.hks(\.dcx)?$/i.test(relativePath));
}

/**
 * 行为/动作域：T3（2026-08-15）行为 + 动画合并为「动作」，侧栏列
 * `anibnd|tae`（与隐藏域 animation 同口径）；S39（2026-08-18）追加
 * `action/` 路径下的 `.hks`，与 anibnd/tae 一起进动作侧栏，点开仍走
 * 脚本 IDE（selectEditor 'script'）。behbnd/esd/hkxbnd 不进动作侧栏，
 * 需要时走「文件」域（grok T3）。
 */
export function isBehaviorLibraryPath(relativePath: string): boolean {
  return isAnimationLibraryPath(relativePath) || isActionScriptPath(relativePath);
}

/** 动画域（T3 后顶栏隐藏，保留给隐藏域/测试）。 */
export function isAnimationLibraryPath(relativePath: string): boolean {
  return /\.(tae|anibnd)(\.dcx)?$/i.test(relativePath);
}

export function isModelLibraryPath(relativePath: string): boolean {
  return /\.flver(\.dcx)?$/i.test(relativePath);
}

export function isTextureLibraryPath(relativePath: string): boolean {
  return /\.(tpf|texbnd)(\.dcx)?$/i.test(relativePath);
}

export function isMaterialLibraryPath(relativePath: string): boolean {
  return /\.mtd(\.dcx)?$/i.test(relativePath);
}

export function isVfxLibraryPath(relativePath: string): boolean {
  return /\.(fxr|ffxbnd)(\.dcx)?$/i.test(relativePath);
}

export function isGenericContainerPath(relativePath: string): boolean {
  if (!/\.(bnd|bdt|bhd)(\.dcx)?$/i.test(relativePath)) return false;
  return !isParamContainerPath(relativePath)
    && !isTextLibraryPath(relativePath)
    && !isTextureLibraryPath(relativePath)
    && !isScriptLibraryPath(relativePath)
    && !isAnimationLibraryPath(relativePath)
    && !isBehaviorLibraryPath(relativePath)
    && !isVfxLibraryPath(relativePath);
}

const DOMAIN_MATCHERS: Partial<Record<EditorDomainId, (path: string) => boolean>> = {
  // R1 裁定：PARAM 与 GPARAM 都进左侧「参数」逻辑库（顶栏已无独立 GPARAM）。
  param: (path) => isParamContainerPath(path) || isGparamPath(path),
  gparam: isGparamPath,
  // 文本域按资源类型收集所有已索引语言包；具体语言由资源路径和 MSG 元数据展示。
  text: isTextLibraryPath,
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

/**
 * 动作域首选动画库（13-B）：优先 `chr/c0000.anibnd.dcx`，没有则列表里第一个
 * anibnd。只挑 anibnd 不挑 tae —— 点「动作」默认进 TAE 工作台（动画 + 词条 +
 * 预览），而不是点中列表第一项 HKS 进脚本 IDE。
 */
export function pickPreferredAnimation<T extends { relativePath: string }>(
  files: readonly T[]
): T | null {
  const anibnds = files.filter((file) => /\.anibnd(\.dcx)?$/i.test(file.relativePath));
  const c0000 = anibnds.find((file) => /(?:^|[\\/])c0000\.anibnd(\.dcx)?$/i.test(file.relativePath));
  return c0000 ?? anibnds[0] ?? null;
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

/**
 * 动作域的分组（13-B）：「动画」（anibnd|tae，默认展开）+「动作脚本」（action/
 * 下的 hks，默认折叠）。S39 把 HKS 与 anibnd/tae 拼进同一侧栏时 HKS 按字母排在
 * 前面，点「动作」再点第一项就落到脚本 IDE——分组把动画组放前，动画/词条回到
 * 动作页首屏；HKS 组默认折上，要改动作脚本再点开。
 */
export function behaviorLibraryGroups<T extends { relativePath: string }>(
  files: readonly T[]
): Array<DomainLibraryGroup<T>> {
  const animFiles = files.filter((file) => isAnimationLibraryPath(file.relativePath));
  const scriptFiles = files.filter((file) => isActionScriptPath(file.relativePath));
  return [
    {
      id: 'animation',
      label: '动画',
      files: animFiles
    },
    {
      id: 'action-script',
      label: '动作脚本',
      ...(scriptFiles.length > 0 ? { hint: `${scriptFiles.length} 个` } : {}),
      files: scriptFiles,
      defaultCollapsed: true
    }
  ];
}
