/**
 * Smoke 临时目录清理门禁。
 *
 * 忘记清理临时目录不会让任何断言失败，所以它不会被任何测试发现——只会在本机
 * 静默累积。实测：本仓库 92 个 smoke 中 57 个用 mkdtemp 建临时工作区，其中 22 个
 * 从不清理，本机系统临时目录因此累积 25724 个残留 `soulforge-*` 目录（3.8 GB）。
 *
 * 判定分两个维度，任一命中即违规：
 *   1. 出现 `mkdtemp(` 但没有清理证据（harness 的 withSmokeWorkspace /
 *      createSmokeWorkspace，或 `rm(<x>, { recursive: true, force: true })`）。
 *   2. 调用了会建还原点的写路径 API 但没传 backupBaseDir / backupRoot。
 *
 * 维度 2 是实测补上的：四个已改用 harness 的 smoke 在维度 1 上判定干净，却仍每次
 * 残留两个 `soulforge-backup-*`——createRestorePoint 的 `baseDir ?? tmpdir()` 在
 * 不传参时落系统临时目录，而备份有意保留，没有清理路径会删它。
 *
 * 这是粗判定，会漏掉「写了 rm 但路径错」这类问题——那需要运行期观测，成本与收益
 * 不匹配。它要抓的是「完全没有清理」和「完全没传备份目录」这两个已实测存在的类别。
 *
 * 新增违规会失败关闭；存量违规走 KNOWN_DEBT 台账，只允许变少不允许变多。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const TESTING_DIR = join(repoRoot, 'packages', 'core', 'src', 'testing');

/**
 * 存量欠债台账：曾经存在、允许暂时保留的既有违规。
 *
 * 这里刻意用「精确清单 + 只允许缩小」而不是「阈值计数」：阈值会让人把新违规
 * 换掉旧违规而门禁无感，清单则要求每次变动都显式改台账。
 *
 * **当前为空——18 项存量欠债已全部清偿**（2026-08-02）：全部改用 harness 的
 * withSmokeWorkspace，9 项同时补上了 backupBaseDir。空台账让本门禁从「只允许缩小」
 * 升级为「零容忍」：此后任何一处泄漏都会直接失败关闭，不再有豁免名额。
 * 台账留着不删是有意的——它承载 STALE_DEBT_ENTRY 那条「修好必须销账」的规则，
 * 将来若确需临时豁免，仍走同一条路径而不是重新发明一个。
 */
const KNOWN_DEBT = Object.freeze(new Set([]));

/**
 * 清理证据的判据形态。
 *
 * 曾经的写法是「文件里出现 withSmokeWorkspace / createSmokeWorkspace /
 * `recursive: true, force: true` 任一串即算干净」。实测这是假门禁：负例把
 * `withSmokeWorkspace(...)` 换回裸 `mkdtemp`、但保留了那行 import，串仍在文件里，
 * 门禁照样报绿（`cleanSmokes` 还从 44 涨到 45）。判据问的是「文件里有没有清理字样」，
 * 该问的是「每个 mkdtemp 调用是否都被清理覆盖」——形态与被检对象错位。
 *
 * 现在改成逐调用点判定：harness 内部自带 mkdtemp 且保证 dispose，所以经 harness
 * 建的临时目录不算裸调用；只有 smoke 自己写的 `mkdtemp(` 才需要就地清理证据。
 */
const HARNESS_ENTRIES = Object.freeze(['withSmokeWorkspace(', 'createSmokeWorkspace(']);
const INLINE_CLEANUP_MARKERS = Object.freeze(['recursive: true, force: true']);

/**
 * 数一个源文件里「自己写的」mkdtemp 调用数。
 *
 * 只统计调用（`mkdtemp(`），import 里的裸标识符不计入——否则改用 harness 的文件
 * 会因为仍 import 了 mkdtemp 名字而被误判。
 */
function countBareMkdtempCalls(source) {
  return (source.match(/\bmkdtemp\(/g) ?? []).length;
}

/**
 * 第二维度：写路径 API 的备份目录必须显式指定。
 *
 * 这一维度是实测补上的。改造后的四个 smoke 已经用了 withSmokeWorkspace（第一维度
 * 判定「干净」），却仍每次残留 `soulforge-backup-*`：createRestorePoint 的
 * `baseDir ?? tmpdir()` 会在不传参时落系统临时目录，而备份是有意保留的，所以
 * 没有任何清理路径会删它。只查 mkdtemp 看不见这类泄漏。
 */
const BACKUP_PRODUCING_APIS = Object.freeze([
  'createWorkspaceTransaction',
  'rollbackOperation',
  'saveTextResource',
  'commitValidatedStagingArea',
  'commitPatchProposal',
  // 下面两条是运行期观测补上的。清偿 18 项存量欠债后，asset-writeback 与
  // dds-convert-writeback 静态判定已干净，实跑却各残留一个 soulforge-backup-*：
  // 它们经 commitAssetImportThroughPatchIr 转调 executePatchIrThroughTransaction，
  // 而清单里没有这两个名字，第二维度整个漏过。这正是「只迭代自己的清单」形态——
  // 清单型判据的覆盖面等于清单本身，新写路径入口必须显式登记。
  'commitAssetImportThroughPatchIr',
  'convertRgbaToDdsAndWriteback'
]);

const BACKUP_DIR_MARKERS = Object.freeze(['backupBaseDir', 'backupRoot']);

const violations = [];
const clean = [];
const remainingDebt = [];

for (const fileName of readdirSync(TESTING_DIR)) {
  if (!/^run.*Smoke\.ts$/.test(fileName)) continue;
  const source = readFileSync(join(TESTING_DIR, fileName), 'utf8');

  // 经 harness 建的目录由 harness 自己 dispose；只有 smoke 自己调 mkdtemp 才需要
  // 就地清理证据。两者都可能出现在同一文件（harness 建外层 + 自己再建一个），
  // 所以判「有裸调用且无就地清理」，而不是「文件里有没有 harness 字样」。
  const bareMkdtempCalls = countBareMkdtempCalls(source);
  const hasInlineCleanup = INLINE_CLEANUP_MARKERS.some((marker) => source.includes(marker));
  const leaksTempDir = bareMkdtempCalls > 0 && !hasInlineCleanup;
  const leaksBackupDir = BACKUP_PRODUCING_APIS.some((api) => source.includes(`${api}(`))
    && !BACKUP_DIR_MARKERS.some((marker) => source.includes(marker));

  if (!leaksTempDir && !leaksBackupDir) {
    // clean 只统计「确实建了临时目录或走了写路径」的 smoke。经 harness 的算在内，
    // 否则改造反而让 cleanSmokes 变小，看起来像覆盖退化。
    const usesTempDir = bareMkdtempCalls > 0
      || HARNESS_ENTRIES.some((entry) => source.includes(entry));
    if (usesTempDir || BACKUP_PRODUCING_APIS.some((api) => source.includes(`${api}(`))) {
      clean.push(fileName);
    }
    continue;
  }
  if (KNOWN_DEBT.has(fileName)) {
    remainingDebt.push(fileName);
    continue;
  }
  if (leaksTempDir) {
    violations.push({
      file: `packages/core/src/testing/${fileName}`,
      code: 'SMOKE_TEMP_DIR_LEAK',
      message: `该 smoke 自己调了 ${bareMkdtempCalls} 处 mkdtemp( 但没有就地清理证据。`
        + ' 请改用 packages/core/src/testing/harness/smokeWorkspace.ts 的 withSmokeWorkspace，'
        + ' 或在 finally 中 rm(root, { recursive: true, force: true })。'
        + (HARNESS_ENTRIES.some((entry) => source.includes(entry))
          ? ' 注意：本文件已经在用 harness，但仍有裸 mkdtemp 调用——'
            + 'harness 只清理它自己建的目录，另开的那个不在其中。'
          : '')
    });
  }
  if (leaksBackupDir) {
    violations.push({
      file: `packages/core/src/testing/${fileName}`,
      code: 'SMOKE_BACKUP_DIR_LEAK',
      message: '该 smoke 调用了会建还原点的写路径 API 但没传备份目录。'
        + ' 不传时备份落系统临时目录且有意保留，无人清理。'
        + ' 请传 backupBaseDir / backupRoot 指向本次临时工作区内的子目录。'
    });
  }
}

/** 台账里已修好的条目必须从台账删除，否则台账会慢慢变成永久豁免。 */
const staleDebt = [...KNOWN_DEBT].filter(
  (fileName) => !remainingDebt.includes(fileName)
);

if (violations.length > 0 || staleDebt.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    code: violations.length > 0 ? 'SMOKE_TEMP_DIR_LEAK' : 'STALE_DEBT_ENTRY',
    message: violations.length > 0
      ? '新增了不清理临时目录的 smoke。忘记清理不会让任何断言失败，只会静默累积。'
      : '台账里有已修好的条目未移除。台账只允许缩小，否则会退化成永久豁免。',
    newViolations: violations,
    staleDebtEntries: staleDebt.map((fileName) => ({
      file: `packages/core/src/testing/${fileName}`,
      message: '该文件已有清理，请从 verify-smoke-temp-cleanup-gate.mjs 的 KNOWN_DEBT 中移除。'
    }))
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  message: '无新增临时目录泄漏（存量欠债受台账约束，只允许缩小）',
  cleanSmokes: clean.length,
  knownDebt: remainingDebt.length,
  harness: 'packages/core/src/testing/harness/smokeWorkspace.ts',
  dimensions: ['mkdtemp 有清理', '写路径 API 有传备份目录'],
  note: '本门禁是静态判定；清理路径是否正确需运行期观测，不在此范围'
}, null, 2));
