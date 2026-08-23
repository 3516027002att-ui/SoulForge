/**
 * 记住上次打开的目录（Mod 工作区 / 原版游戏目录各记一份）。
 *
 * ── 守的问题 ──
 *
 * 用户报「能像别的只狼工具一样记住自己上一次打开的文件夹」。此前两个目录选择
 * 对话框都不传 `defaultPath`，于是每次打开都从系统默认位置开始 —— 而 Mod 工作区
 * 通常埋在 `…\Sekiro\mods\<某个 mod>` 这样的深路径里，每次重新点进去。
 * 真实工具（Smithbox 的 recent projects、Yabber 的上次目录）都记住这个。
 *
 * ── 为什么两个路径分开记 ──
 *
 * Mod 工作区与原版游戏目录是**不同**的位置，且原版目录几乎不变、工作区经常换。
 * 合并成一个「上次目录」会让选原版目录时跳到某个 mod 文件夹，反而更远。
 *
 * ── 为什么不进 app.db ──
 *
 * 与 PARAM 信任策略同一个理由：这是单值用户偏好，不需要事务；而 app.db 走
 * OperationLogUtilityClient 子进程，把它当宿主会让「能不能打开目录选择框」
 * 耦合到那个子进程的可用性上。而且这份数据必须在**打开任何工作区之前**就可读 ——
 * 那时工作区数据库根本还没开。
 *
 * ── 安全边界 ──
 *
 * 只存路径字符串，且仅用作对话框的起始位置（`defaultPath`）。它不授予任何访问
 * 权限：真正的读写边界仍由会话的 allowedRoots / writableRoots 决定。路径失效
 * （目录被删、盘符变化）时静默回落到系统默认，不报错 —— 记住上次位置是便利
 * 功能，不该因为一个过期路径就打不开对话框。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/** 记住的目录类别。 */
export type RecentPathKind = 'overlay' | 'base';

interface RecentPathsFile {
  /** Mod 工作区（overlay）上次选择的目录。 */
  overlay?: string;
  /** 原版游戏目录上次选择的目录。 */
  base?: string;
}

const DEFAULT_CANDIDATE_PATHS: Record<RecentPathKind, readonly string[]> = {
  overlay: [
    'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro\\mods',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Sekiro\\mods'
  ],
  base: [
    'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Sekiro'
  ]
};

/**
 * 读出某类目录上次的位置（只读用户真正选过并持久化的记录）。
 *
 * 返回 undefined 的情形一律当「没有记录」：文件不存在、JSON 坏了、值不是
 * 绝对路径、目录已不存在。坏掉的偏好文件不该让对话框打不开，所以不抛异常。
 */
export function readRecentPath(filePath: string, kind: RecentPathKind): string | undefined {
  let parsed: RecentPathsFile = {};
  let fileRead = false;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as RecentPathsFile;
    fileRead = true;
  } catch {
    fileRead = false;
  }
  if (fileRead && typeof parsed === 'object' && parsed !== null) {
    const value = parsed[kind];
    if (typeof value === 'string' && value.trim() !== '') {
      if (isAbsolute(value) && existsSync(value)) {
        return value;
      }
    }
  }

  return undefined;
}

/**
 * 对话框初次打开时的默认起始目录（defaultPath）。
 * 若用户此前选过则优先返回用户上次选过的目录的上一级父目录（若存在），
 * 避免 Windows 原生文件夹选择器直接钻入目录内部导致无法一键点击选择；
 * 若无记录，探测标准已知 Sekiro 路径的上一级作为对话框起始位置（但不写回偏好文件）。
 */
export function getDialogDefaultPath(filePath: string, kind: RecentPathKind): string | undefined {
  const remembered = readRecentPath(filePath, kind);
  if (remembered) {
    const parent = dirname(remembered);
    if (parent && parent !== remembered && existsSync(parent)) {
      return parent;
    }
    return remembered;
  }

  const candidate = DEFAULT_CANDIDATE_PATHS[kind]?.find((pathCandidate) => existsSync(pathCandidate));
  if (candidate) {
    const parent = dirname(candidate);
    if (parent && parent !== candidate && existsSync(parent)) {
      return parent;
    }
    return candidate;
  }

  return undefined;
}

/**
 * 忘掉某类目录。清除原版挂载时必须调用，否则下次启动会把旧 base 再挂回来。
 */
export function clearRecentPath(filePath: string, kind: RecentPathKind): void {
  let existing: RecentPathsFile = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as RecentPathsFile;
    if (typeof parsed === 'object' && parsed !== null) existing = parsed;
  } catch {
    return;
  }
  delete existing[kind];
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
  } catch {
    // 与 writeRecentPath 相同：偏好写失败不打断主流程。
  }
}

/**
 * 记下某类目录的最新位置。
 *
 * 写失败静默忽略：记不住上次位置只是少了个便利，不该让「打开工作区」这个
 * 主流程失败。真正需要报错的写入（Mod 资源）走 Patch Engine，不经这里。
 */
export function writeRecentPath(filePath: string, kind: RecentPathKind, directory: string): void {
  if (typeof directory !== 'string' || !isAbsolute(directory)) return;
  let existing: RecentPathsFile = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as RecentPathsFile;
    if (typeof parsed === 'object' && parsed !== null) existing = parsed;
  } catch {
    existing = {};
  }
  existing[kind] = directory;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
  } catch {
    // 见函数注释：不因偏好写入失败中断主流程。
  }
}
