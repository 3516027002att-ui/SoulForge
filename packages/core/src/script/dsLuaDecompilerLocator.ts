/**
 * 本机 DSLuaDecompiler 只读定位（S16 脚本 IDE）。
 *
 * ── 这是什么 ──
 *
 * 社区标准流程：拖 `.hks`（Havok 字节码）→ `.dec.lua` → 当 Lua 改。本机权威
 * 反编译器是 ElaDiDu（DSLuaDecompiler v1.1.5，2026-08-15 从 GitHub release 放下），
 * 已对 `c0000_transition.hks` 跑通。本模块只做**路径定位**（纯 fs，无 spawn）：
 *
 * - 候选顺序：SOULFORGE_DSLUADECOMPILER_PATH 显式环境变量 → 固定候选
 *   （tools\DSLuaDecompiler\DSLuaDecompiler.exe，v1.1.5）→ 已挂载会话兄弟
 *   tools/<一层子目录>/DSLuaDecompiler/ → 旧拷贝 tools\<hks解码> 备份。
 * - 找不到返回 null，由调用方给结构化失败（「反编译不可用」，不是假 hex 主视图）。
 *
 * ── 刻意不做什么 ──
 *
 * 不把 DSLuaDecompiler / LuaDecompilerCore 源码或 dll 提交进仓库；不在 TypeScript
 * 里写第二套 Havok Lua 反编译器；不执行脚本、不当游戏 VM。反编译由 main 进程
 * spawn（DOTNET_ROLL_FORWARD=LatestMajor，发行目标 net7，本机只有 6/8），
 * renderer 只收文本。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** S16 固定候选：本机 DSLuaDecompiler v1.1.5 真实落地（grok 已放好并跑通）。 */
export const DS_LUA_DECOMPILER_FIXED_CANDIDATES = [
  'D:\\mystream\\Sekiro Shadows Die Twice\\tools\\DSLuaDecompiler\\DSLuaDecompiler.exe'
];

/** 工具目录下相对候选（DSAS/Yapped 同款扫描：tools/<一层子目录>/…）。 */
export const DS_LUA_DECOMPILER_RELATIVE_CANDIDATES = [
  'DSLuaDecompiler\\DSLuaDecompiler.exe',
  'hks解码\\DSLuaDecompiler.exe',
  'hks解码\\DSLuaDecompiler\\DSLuaDecompiler.exe'
];

export interface DsLuaDecompilerProbe {
  /** 反编译器 exe 绝对路径；null 表示本机找不到。 */
  exePath: string | null;
  /** 命中的工具（'explicit' | 'v1.1.5' | 'tools-scan' | 'legacy'）。 */
  origin: 'explicit' | 'v1.1.5' | 'tools-scan' | 'legacy' | 'none';
}

/** 把候选根列表追加到 roots（工具目录及其中一层子目录，静默跳过不可读）。 */
function pushToolsSubdirs(roots: string[], gameRoot: string | undefined): void {
  if (!gameRoot) return;
  const toolsDir = join(gameRoot, '..', 'tools');
  try {
    roots.push(toolsDir);
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(toolsDir, entry.name));
    }
  } catch {
    // tools 目录不存在/不可读：跳过，继续其他候选。
  }
}

export interface DsLuaDecompilerLocatorContext {
  /** 已挂载原版根（用于扫描兄弟 tools）；可空。 */
  baseRoot?: string | null;
  /** 已挂载 overlay 根（用于向上两级扫描兄弟 tools）；可空。 */
  overlayRoot?: string | null;
  /** 显式环境变量 SOULFORGE_SEKIRO_GAME_ROOT 同款扫描根；可空。 */
  gameRootEnv?: string | null;
}

/**
 * 定位本机 DSLuaDecompiler.exe。
 *
 * 纯同步 fs 探测（与 locateUserEmedfSync / locateYappedSdtRootSync 同构）：
 * 环境变量 → 固定候选 → 兄弟 tools 扫描（含一层子目录）→ 旧拷贝 hks解码。
 * 找不到返回 exePath=null，由调用方降级（结构化失败，不假 hex 主视图）。
 */
export function locateDsLuaDecompilerSync(context: DsLuaDecompilerLocatorContext = {}): DsLuaDecompilerProbe {
  const probe = (candidate: string): boolean => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  };
  const explicit = process.env.SOULFORGE_DSLUADECOMPILER_PATH?.trim();
  if (explicit) {
    const candidate = explicit;
    if (probe(candidate)) return { exePath: candidate, origin: 'explicit' };
  }
  for (const candidate of DS_LUA_DECOMPILER_FIXED_CANDIDATES) {
    if (probe(candidate)) return { exePath: candidate, origin: 'v1.1.5' };
  }
  const roots: string[] = [];
  pushToolsSubdirs(roots, context.baseRoot ?? undefined);
  const overlay = context.overlayRoot?.trim();
  if (overlay) pushToolsSubdirs(roots, join(overlay, '..', '..'));
  if (context.gameRootEnv?.trim()) pushToolsSubdirs(roots, context.gameRootEnv.trim());
  for (const root of roots) {
    for (const relative of DS_LUA_DECOMPILER_RELATIVE_CANDIDATES) {
      const candidate = join(root, relative);
      if (probe(candidate)) return { exePath: candidate, origin: 'tools-scan' };
    }
  }
  return { exePath: null, origin: 'none' };
}
