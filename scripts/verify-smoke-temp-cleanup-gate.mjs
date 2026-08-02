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
 * 存量欠债台账：本轮发现的既有违规。
 *
 * 这里刻意用「精确清单 + 只允许缩小」而不是「阈值计数」：阈值会让人把新违规
 * 换掉旧违规而门禁无感，清单则要求每次变动都显式改台账。
 */
const KNOWN_DEBT = Object.freeze(new Set([
  'runAssetImportSmoke.ts',
  'runAssetWritebackSmoke.ts',
  'runBridgeDaemonClientSmoke.ts',
  'runDdsConvertWritebackSmoke.ts',
  'runNativeBnd4TransactionSmoke.ts',
  'runNativeFmgSmoke.ts',
  'runNativeMsbSmoke.ts',
  'runNativeParamSmoke.ts',
  'runNativeScriptContainerReplaceSmoke.ts',
  'runParamDuplicateNativeSmoke.ts',
  'runSqliteCrashRecoverySmoke.ts',
  'runV05ArchitectureScaffoldSmoke.ts',
  'runV05FileRollbackSmoke.ts',
  'runV05FullFileWorkbenchSmoke.ts',
  'runV05P1Smoke.ts',
  'runV05RawFileWorkbenchSmoke.ts',
  'runV05SqliteAuthoritySmoke.ts',
  'runV06NativeContainerWorkbenchSmoke.ts'
]));

const CLEANUP_MARKERS = Object.freeze([
  'withSmokeWorkspace',
  'createSmokeWorkspace',
  'recursive: true, force: true'
]);

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
  'commitPatchProposal'
]);

const BACKUP_DIR_MARKERS = Object.freeze(['backupBaseDir', 'backupRoot']);

const violations = [];
const clean = [];
const remainingDebt = [];

for (const fileName of readdirSync(TESTING_DIR)) {
  if (!/^run.*Smoke\.ts$/.test(fileName)) continue;
  const source = readFileSync(join(TESTING_DIR, fileName), 'utf8');

  const leaksTempDir = source.includes('mkdtemp(')
    && !CLEANUP_MARKERS.some((marker) => source.includes(marker));
  const leaksBackupDir = BACKUP_PRODUCING_APIS.some((api) => source.includes(`${api}(`))
    && !BACKUP_DIR_MARKERS.some((marker) => source.includes(marker));

  if (!leaksTempDir && !leaksBackupDir) {
    if (source.includes('mkdtemp(') || BACKUP_PRODUCING_APIS.some((api) => source.includes(`${api}(`))) {
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
      message: '该 smoke 用 mkdtemp 建了临时目录但没有任何清理。'
        + ' 请改用 packages/core/src/testing/harness/smokeWorkspace.ts 的 withSmokeWorkspace，'
        + ' 或在 finally 中 rm(root, { recursive: true, force: true })。'
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
