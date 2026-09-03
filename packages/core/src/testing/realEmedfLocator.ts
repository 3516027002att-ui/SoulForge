/**
 * Locate a real DarkScript3-format EMEDF JSON on the local machine.
 *
 * Shared by the imported-registry smokes (runEmevdImportedRegistryProductionSmoke,
 * runEmevdImportedCoverageSmoke) and the multi-corpus matrix so that the
 * "real imported EMEDF cross-validation" leg of W-EMEVD-FULL-01 fires from the
 * plain npm scripts when a user-provided file exists locally, instead of
 * requiring SOULFORGE_EMEDF_PATH to be set by hand.
 *
 * Lookup order:
 *   1. SOULFORGE_EMEDF_PATH env (explicit caller choice);
 *   2. common DarkScript3 / Smithbox directory candidates;
 *   3. a bounded set of user-profile subdirectories for
 *      `sekiro-common.emedf.json`.
 * Returns undefined (fail-closed) when not found.
 *
 * DarkScript3 EMEDF data is All Rights Reserved; this locator only reads a
 * user-provided local file, never bundles or commits anything.
 */
import { access, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface RealEmedfLocatorOptions {
  /**
   * 已挂载的游戏根。传入时优先扫描其兄弟 `tools` 目录；未传入时回退到
   * SOULFORGE_SEKIRO_GAME_ROOT。这里只影响路径候选，不读取或解析 EMEDF 内容。
   */
  gameRoot?: string | null;
}

const REAL_EMEDF_CANDIDATE_PATHS = [
  'sekiro-common.emedf.json',
  'Sekiro/sekiro-common.emedf.json',
  'sekiro.emedf.json',
  // DarkScript3 发布包把 EMEDF 放在 Resources/ 下，是最常见的落地形态。
  'Resources/sekiro-common.emedf.json'
];

/**
 * 从游戏根推导出的工具目录候选（深度 1 子目录）。
 *
 * 实测（2026-08-08）：本机 EMEDF 落在
 * `<X>/tools/事件编辑器3.4.1/Resources/sekiro-common.emedf.json`，
 * 而游戏根是 `<X>/Sekiro` —— tools 是游戏根的**兄弟目录**。原先 11 个候选
 * 根全是 `D:/Repository/DarkScript3` 这类猜测，一个都没命中，于是四条
 * smoke（multi-corpus-matrix / corpus-matrix / imported-coverage /
 * imported-registry-production）的真实 EMEDF leg **从未执行过**，一直诚实跳过。
 *
 * 不硬编码那条路径：目录名带版本号（`3.4.1`）与中文名，是本机形态，写死
 * 只对我这台机器有效，下一个版本号变了又回到零命中。改为枚举 tools 下的
 * 一层子目录，对「<X>/Sekiro 游戏根 + <X>/tools/<任意工具>/Resources」这种
 * 布局通用。只读、深度固定为 1、失败即跳过，不递归整盘。
 */
async function toolsSiblingRoots(gameRoot: string): Promise<string[]> {
  const toolsDir = join(dirname(gameRoot), 'tools');
  try {
    const entries = await readdir(toolsDir, { withFileTypes: true });
    return [toolsDir, ...entries.filter((e) => e.isDirectory()).map((e) => join(toolsDir, e.name))];
  } catch {
    return [];
  }
}

export async function searchRealEmedf(
  options: RealEmedfLocatorOptions = {}
): Promise<string | undefined> {
  const explicit = process.env.SOULFORGE_EMEDF_PATH?.trim();
  if (explicit) return resolve(explicit);

  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const configuredGameRoot = options.gameRoot?.trim();
  const gameRoot = configuredGameRoot || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
  // 顺序即优先级：**有版本出处的工具发布包排在临时目录之前**。
  //
  // 实测（2026-08-08）踩到过：`%LOCALAPPDATA%/Temp` 下有一份 520398 字节、
  // mtime 2026-07-31 的同名文件（某轮取证落下的临时产物），而 tools 里那份是
  // 511328 字节、mtime 2023-07-03 的 DarkScript3 3.4.1 发布包原件——两份 sha256
  // 不同。Temp 排在前面时命中的是那份来历不明、可能已被改动的副本。
  // 拿它当交叉验证的权威语料，验证的就不再是「与上游 EMEDF 一致」。
  const roots = [
    ...(gameRoot ? await toolsSiblingRoots(gameRoot) : []),
    'D:/Repository/DarkScript3',
    'D:/Repository/Smithbox',
    'D:/Smithbox',
    'C:/Tools/Smithbox',
    'C:/DarkScript3',
    'D:/DarkScript3',
    home ? join(home, 'Desktop') : '',
    home ? join(home, 'Documents') : '',
    home ? join(home, 'Downloads') : '',
    home ? join(home, 'AppData', 'Roaming') : '',
    home ? join(home, 'AppData', 'Local', 'Temp') : ''
  ].filter(Boolean);
  for (const root of roots) {
    for (const rel of REAL_EMEDF_CANDIDATE_PATHS) {
      const candidate = join(root, rel);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return undefined;
}
