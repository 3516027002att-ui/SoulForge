/**
 * NSIS installer lifecycle harness — install / upgrade / uninstall / clean-target.
 *
 * Default mode is a structured preflight + skip (exit 0): it locates the unsigned
 * NSIS artifact, checks for an existing registered SoulForge install and running
 * processes, and reports exactly what an execution WOULD do.
 *
 * Execution mode (SOULFORGE_INSTALLER_LIFECYCLE_RUN=1) performs, on an
 * owner-controlled temporary target directory only (never Program Files or
 * user-writable common locations):
 *   1. install    — installer.exe /S /D=<temp-target>
 *   2. upgrade    — same installer run again over the existing install
 *   3. uninstall  — "<temp-target>/Uninstall <product>.exe" /S
 *   4. clean-target — target dir, uninstall registry key and shortcuts gone
 * Registry / start-menu / desktop state is snapshotted before install and after
 * uninstall so residual changes are reported as structured diagnostics.
 *
 * This harness does NOT claim external distribution, code signing or SmartScreen
 * reputation. Unsigned NSIS builds are only for owner-controlled test machines.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  createProcessCancellation,
  processSucceeded,
  readTimeoutMs,
  runProcess
} from './subprocess-control.mjs';
import {
  installerArtifactName,
  loadReleasePolicy
} from './release-compliance-lib.mjs';
import { resolveSafeScratchRoot, scratchBoundaryFailure } from './scratch-boundary.mjs';

const root = resolve(import.meta.dirname, '..');
const desktopPkg = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'));
const electronBuilderConfig = JSON.parse(
  readFileSync(resolve(root, 'apps/desktop/electron-builder.json'), 'utf8')
);
const productName = electronBuilderConfig.productName ?? 'SoulForge';
const appId = electronBuilderConfig.appId ?? 'com.soulforge.app';
const version = desktopPkg.version ?? '0.0.0';
const installerRelativePath = `apps/desktop/release/${installerArtifactName(electronBuilderConfig, desktopPkg)}`;
const installerPath = resolve(root, installerRelativePath);
const installTimeoutMs = readTimeoutMs('SOULFORGE_INSTALLER_INSTALL_TIMEOUT_MS', 5 * 60 * 1000);
const uninstallTimeoutMs = readTimeoutMs('SOULFORGE_INSTALLER_UNINSTALL_TIMEOUT_MS', 3 * 60 * 1000);
const cleanWaitMs = readTimeoutMs('SOULFORGE_INSTALLER_CLEAN_WAIT_MS', 2 * 60 * 1000);
const runMode = process.env.SOULFORGE_INSTALLER_LIFECYCLE_RUN === '1';

const report = {
  ok: null,
  status: 'unknown',
  authority: 'partial',
  scope: 'unsigned-win-x64-nsis-lifecycle',
  installer: {
    relativePath: installerRelativePath,
    fileName: basename(installerRelativePath),
    exists: existsSync(installerPath),
    productName,
    appId,
    version
  },
  runMode: runMode ? 'execute' : 'preflight-skip',
  steps: [],
  diagnostics: []
};

function diag(severity, code, message, details) {
  report.diagnostics.push({ severity, code, message, ...(details ? { details } : {}) });
}

function step(name, ok, extra) {
  report.steps.push({ name, ok, ...extra });
}

function runWithTimeout(command, args, timeoutMs) {
  const cancellation = createProcessCancellation();
  const task = runProcess({
    command,
    args,
    cwd: root,
    timeoutMs,
    signal: cancellation.signal
  });
  return task.finally(() => cancellation.dispose());
}

function snapshotState() {
  return {
    uninstallKeys: findUninstallKeys(),
    startMenuShortcuts: findShortcuts('start-menu'),
    desktopShortcuts: findShortcuts('desktop')
  };
}

function findUninstallKeys() {
  const hives = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  const hits = [];
  for (const hive of hives) {
    const found = regQuery(hive, ['/s', '/f', 'SoulForge']);
    if (found !== null && found.length > 0) {
      for (const line of found) {
        const trimmed = line.trim();
        if (/^HKEY_/i.test(trimmed)) hits.push(trimmed);
      }
    }
  }
  return [...new Set(hits)].sort();
}

function findShortcuts(kind) {
  const bases = [];
  if (kind === 'start-menu') {
    bases.push(join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  } else {
    bases.push(join(process.env.USERPROFILE ?? '', 'Desktop'));
    bases.push(join(process.env.USERPROFILE ?? '', 'OneDrive', 'Desktop'));
  }
  const hits = [];
  for (const base of bases) {
    if (!base || !existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      if (/^SoulForge/i.test(entry)) hits.push(join(base, entry));
    }
  }
  return hits.sort();
}

function regQuery(key, args) {
  const result = spawnSync('reg.exe', ['query', key, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false
  });
  if (result.status === 0) return (result.stdout ?? '').split(/\r?\n/).filter(Boolean);
  if (result.status === 1) return []; // not found
  return null; // query failed for another reason
}

function runningSoulForgeProcesses() {
  const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq SoulForge.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) return [];
  const lines = (result.stdout ?? '').split(/\r?\n/).filter((line) => /SoulForge\.exe/i.test(line));
  return lines.map((line) => line.trim());
}

function ensureRequiredPayload(targetDir) {
  const required = [
    'SoulForge.exe',
    'resources/app.asar',
    'resources/native/better_sqlite3.node',
    'resources/native/better_sqlite3.json'
  ];
  const missing = required.filter((relativePath) => !existsSync(join(targetDir, relativePath)));
  return { missing };
}

function waitForCondition(condition, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const tick = () => {
      if (condition()) return resolvePromise(true);
      if (Date.now() >= deadline) return resolvePromise(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

async function findUninstaller(targetDir) {
  if (!existsSync(targetDir)) return null;
  const candidates = [
    join(targetDir, `Uninstall ${productName}.exe`),
    join(targetDir, 'Uninstall.exe')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  let scanned = [];
  try {
    scanned = readdirSync(targetDir).filter((name) => /^Uninstall.*\.exe$/i.test(name));
  } catch { /* ignored */ }
  if (scanned.length > 0) return join(targetDir, scanned.sort()[0]);
  return null;
}

// ---- Preflight (always runs) ----
if (!existsSync(installerPath)) {
  diag('error', 'INSTALLER_ARTIFACT_MISSING', `未找到 NSIS 安装包：${installerRelativePath}；先构建 NSIS。`);
  report.ok = false;
  report.status = 'failed';
  finish();
}

const preInstall = snapshotState();
report.preflight = {
  installerExists: true,
  existingUninstallKeys: preInstall.uninstallKeys,
  runningProcesses: runningSoulForgeProcesses(),
  startMenuShortcutsBefore: preInstall.startMenuShortcuts,
  desktopShortcutsBefore: preInstall.desktopShortcuts,
  targetRoot: join(tmpdir(), 'soulforge-lifecycle')
};
step('preflight', true, {
  existingUninstallKeys: preInstall.uninstallKeys,
  runningProcesses: report.preflight.runningProcesses,
  installerPresent: true
});

if (!runMode) {
  report.ok = true;
  report.status = 'skipped';
  report.message = 'lifecycle 未执行（结构化预检通过）。设置 SOULFORGE_INSTALLER_LIFECYCLE_RUN=1 在所有者控制的临时目标目录执行安装/升级/卸载。';
  report.nonClaim = '跳过不代表安装/升级/卸载已通过；未签名 NSIS 仅限所有者内部测试机，不声明外部分发或签名。';
  finish();
} else {
// ---- Execution mode ----
if (preInstall.uninstallKeys.length > 0) {
  diag('error', 'EXISTING_INSTALLATION_FOUND', '本机已注册 SoulForge 安装，拒绝执行以避免覆盖用户环境。', { keys: preInstall.uninstallKeys });
  report.ok = false;
  report.status = 'failed';
  finish();
}
const running = runningSoulForgeProcesses();
if (running.length > 0) {
  diag('error', 'SOULFORGE_PROCESS_RUNNING', '检测到运行中的 SoulForge 进程，拒绝执行。', { processes: running });
  report.ok = false;
  report.status = 'failed';
  finish();
}

const workspaceRoot = resolve(root);
const protectedRoots = [
  { label: 'repository-root', path: workspaceRoot },
  { label: 'mod-workspace-root', path: resolve(root, 'mods') },
  { label: 'sekiro-game-root', path: process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? '' },
  { label: 'native-fixture-root', path: process.env.SOULFORGE_NATIVE_FIXTURE_ROOT ?? '' }
];
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let scratch;
try {
  scratch = await resolveSafeScratchRoot({
    scratch: join(tmpdir(), `soulforge-lifecycle-${runId}`),
    repositoryRoot: workspaceRoot,
    protectedRoots
  });
  await mkdir(scratch, { recursive: true });
} catch (error) {
  diag('error', 'SCRATCH_RESOLUTION_FAILED', '无法解析生命周期临时目标目录。', scratchBoundaryFailure(error));
  report.ok = false;
  report.status = 'failed';
  finish();
}

const targetDir = join(scratch, 'install');
if (/ /.test(targetDir)) {
  diag('error', 'TARGET_PATH_CONTAINS_SPACES', '临时目标目录包含空格，NSIS /D 参数不可靠，拒绝执行。', { targetDir });
  report.ok = false;
  report.status = 'failed';
  await rm(scratch, { recursive: true, force: true });
  finish();
}
report.targetDir = targetDir;

const installResult = await runWithTimeout(installerPath, ['/S', `/D=${targetDir}`], installTimeoutMs);
const installSucceeded = processSucceeded(installResult);
step('install', installSucceeded, {
  code: installResult.code,
  timedOut: installResult.timedOut,
  cancelled: installResult.cancelled,
  stdoutTail: installResult.stdout.slice(-800),
  stderrTail: installResult.stderr.slice(-800)
});
const installedPayload = existsSync(targetDir) ? ensureRequiredPayload(targetDir) : { missing: ['<target-not-created>'] };
const installedUninstallKeys = findUninstallKeys();
step('install-payload', installedPayload.missing.length === 0, {
  missing: installedPayload.missing,
  uninstallKeysAfterInstall: installedUninstallKeys
});
if (!installSucceeded || installedPayload.missing.length > 0 || installedUninstallKeys.length === 0) {
  diag('error', 'INSTALL_FAILED', '安装阶段失败：安装器非零/超时/取消，或必装文件/卸载键未就绪。');
  report.ok = false;
  report.status = 'failed';
  await rm(scratch, { recursive: true, force: true });
  finish();
}

const afterInstallState = snapshotState();

const upgradeResult = await runWithTimeout(installerPath, ['/S', `/D=${targetDir}`], installTimeoutMs);
const upgradeSucceeded = processSucceeded(upgradeResult);
step('upgrade', upgradeSucceeded, {
  code: upgradeResult.code,
  timedOut: upgradeResult.timedOut,
  cancelled: upgradeResult.cancelled,
  stdoutTail: upgradeResult.stdout.slice(-800),
  stderrTail: upgradeResult.stderr.slice(-800)
});
const upgradedPayload = existsSync(targetDir) ? ensureRequiredPayload(targetDir) : { missing: ['<target-not-created>'] };
step('upgrade-payload', upgradedPayload.missing.length === 0, { missing: upgradedPayload.missing });
if (!upgradeSucceeded || upgradedPayload.missing.length > 0) {
  diag('error', 'UPGRADE_FAILED', '升级（覆盖安装）阶段失败。');
  report.ok = false;
  report.status = 'failed';
  const uninstallerPath = await findUninstaller(targetDir);
  if (uninstallerPath) {
    const rollback = await runWithTimeout(uninstallerPath, ['/S'], uninstallTimeoutMs);
    step('rollback-uninstall', processSucceeded(rollback), { code: rollback.code });
  }
  await rm(scratch, { recursive: true, force: true });
  finish();
}

const uninstallerPath = await findUninstaller(targetDir);
if (!uninstallerPath) {
  diag('error', 'UNINSTALLER_NOT_FOUND', `未在安装目录找到卸载器（Uninstall ${productName}.exe）。`);
  report.ok = false;
  report.status = 'failed';
  await rm(scratch, { recursive: true, force: true });
  finish();
}
step('uninstaller-located', true, { path: uninstallerPath });

const uninstallResult = await runWithTimeout(uninstallerPath, ['/S'], uninstallTimeoutMs);
const uninstallSucceeded = processSucceeded(uninstallResult);
step('uninstall', uninstallSucceeded, {
  code: uninstallResult.code,
  timedOut: uninstallResult.timedOut,
  cancelled: uninstallResult.cancelled,
  stdoutTail: uninstallResult.stdout.slice(-800),
  stderrTail: uninstallResult.stderr.slice(-800)
});
if (!uninstallSucceeded) {
  diag('error', 'UNINSTALL_FAILED', '卸载阶段失败：卸载器非零/超时/取消。');
  report.ok = false;
  report.status = 'failed';
  await rm(scratch, { recursive: true, force: true });
  finish();
}

const targetGone = await waitForCondition(() => !existsSync(targetDir), cleanWaitMs);
// The NSIS uninstaller removes the HKCU uninstall key asynchronously after the
// uninstaller process exits (observed: the key is still present immediately
// after the process closes and disappears shortly after). Judging residual
// state from a single snapshot taken right after exit is a race; wait out the
// clean window for the key to settle before declaring residuals.
let residualUninstallKeys = [];
await waitForCondition(() => {
  const after = snapshotState();
  residualUninstallKeys = after.uninstallKeys.filter(
    (key) => !preInstall.uninstallKeys.includes(key)
  );
  return residualUninstallKeys.length === 0;
}, cleanWaitMs);
const afterUninstall = snapshotState();
const residualShortcuts = [
  ...afterUninstall.startMenuShortcuts,
  ...afterUninstall.desktopShortcuts
].filter((path) => (
  !preInstall.startMenuShortcuts.includes(path) && !preInstall.desktopShortcuts.includes(path)
));
step('clean-target', targetGone && residualUninstallKeys.length === 0 && residualShortcuts.length === 0, {
  targetGone,
  residualUninstallKeys,
  residualShortcuts,
  startMenuShortcutsRemoved: afterInstallState.startMenuShortcuts.filter((p) => !afterUninstall.startMenuShortcuts.includes(p)),
  desktopShortcutsRemoved: afterInstallState.desktopShortcuts.filter((p) => !afterUninstall.desktopShortcuts.includes(p))
});
if (!targetGone) diag('error', 'CLEAN_TARGET_REMAINS', `卸载后安装目标目录仍存在：${targetDir}`);
for (const key of residualUninstallKeys) diag('error', 'CLEAN_REGISTRY_REMAINS', `卸载后残留卸载注册表键：${key}`);
for (const path of residualShortcuts) diag('error', 'CLEAN_SHORTCUT_REMAINS', `卸载后残留快捷方式：${path}`);

await rm(scratch, { recursive: true, force: true });
step('scratch-cleanup', true, { scratch });

const cleanErrors = report.diagnostics.filter((item) => item.severity === 'error');
report.ok = cleanErrors.length === 0;
report.status = cleanErrors.length === 0 ? 'passed' : 'failed';
report.message = cleanErrors.length === 0
  ? 'NSIS 安装 → 升级（覆盖安装）→ 卸载 → 干净目标检查通过（所有者控制临时目标）。'
  : 'NSIS lifecycle 存在失败阶段。';
report.authority = cleanErrors.length === 0 ? 'partial' : 'failed';
report.nonClaim = '本 harness 只证明所有者内部临时目标上的安装/升级/卸载正确性；不声明外部分发、代码签名、SmartScreen 信誉或真实游戏验收。';
finish();
}

function finish() {
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'skipped' || report.status === 'passed' ? 0 : 1;
}
