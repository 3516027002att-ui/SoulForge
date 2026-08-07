/**
 * Real me3 → Sekiro launch/terminate/restart session smoke (native tier).
 *
 * This is the W-ME3-INSTALL-04 real-session verification. With
 * SOULFORGE_ME3_SEKIRO_SESSION_RUN=1 and SOULFORGE_SEKIRO_GAME_ROOT set it
 * genuinely starts Sekiro through the pinned me3 gateway:
 *
 *   1. createProfile      — me3 profile create -g sekiro
 *   2. launch #1          — me3 launch -g sekiro -p <profile> -d (suspend)
 *   3. alive check        — poll the real sekiro.exe process table
 *   4. terminate          — taskkill /T /F + confirm the tree is gone
 *   5. relaunch #2        — verify a post-rollback restart works
 *   6. terminate #2       — confirm the tree is gone again
 *
 * Launch is augmented by the privileged gateway env contract: a non-Steam game
 * root is passed to me3 via `-e <root>\sekiro.exe`, and SOULFORGE_ME3_SEKIRO_SUSPEND
 * keeps the game suspended until a debugger attaches so no renderer runs. The
 * game directory is only ever read (snapshotted before/after); me3 writes its
 * cache under its own LOCALAPPDATA directories, never the game folder.
 *
 * Without SOULFORGE_ME3_SEKIRO_SESSION_RUN the smoke is an honest skip: it
 * never fakes a launch.
 *
 * Safe-operation constraints honored here:
 *   - total session wall-clock is bounded by SOULFORGE_ME3_SEKIRO_SESSION_TIMEOUT_MS
 *   - every launch is terminated as soon as the process tree is confirmed
 *   - a watchdog force-kills any residual me3/sekiro process on overrun
 *   - the game directory is never written by this script
 */
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  RuntimeLaunchSession,
  RuntimeProfileRef
} from '@soulforge/core';
import { Me3RuntimeAdapter } from '@soulforge/core';
import { MainMe3RuntimeGateway } from './me3RuntimeGateway.js';

const SEKIRO_EXE = 'sekiro.exe';
const ME3_EXE = 'me3.exe';
const GAME_ROOT = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() ?? '';
const RUN = process.env.SOULFORGE_ME3_SEKIRO_SESSION_RUN === '1';
const SUSPEND = process.env.SOULFORGE_ME3_SEKIRO_SUSPEND === '1';
const WATCHDOG_MS = safeTimeoutMs('SOULFORGE_ME3_SEKIRO_SESSION_TIMEOUT_MS', 180_000);
const PROCESS_WAIT_MS = safeTimeoutMs('SOULFORGE_ME3_SEKIRO_PROCESS_WAIT_MS', 90_000);
const LOCAL_DATA_ROOT = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'SoulForge')
  : resolve('.', 'absent-local-appdata');

const POLICY = {
  policyId: 'soulforge.me3-v0_12_1',
  supportedVersions: ['0.12.1']
} as const;

const report: Record<string, unknown> = {
  ok: false,
  gate: 'me3-sekiro-session',
  status: 'unknown',
  authority: 'unverified',
  scope: 'win-x64-real-sekiro-session',
  suspendMode: SUSPEND,
  sekiroRootPresent: Boolean(GAME_ROOT),
  sekiroProcessLifecycleObserved: false,
  startedAt: new Date().toISOString(),
  steps: [],
  diagnostics: []
};
const steps: Record<string, unknown>[] = [];
const diagnostics: Array<{ severity: string; code: string; message: string; details?: unknown }> = [];

function step(name: string, ok: boolean, extra: Record<string, unknown> = {}): void {
  steps.push({ name, ok, ...extra });
}

function diag(severity: 'error' | 'warning' | 'info', code: string, message: string, details?: unknown): void {
  diagnostics.push({ severity, code, message, ...(details === undefined ? {} : { details }) });
}

function safeTimeoutMs(name: string, fallbackMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackMs;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 10 * 60 * 1000) {
    throw new Error(`${name} must be an integer between 1000 and 600000 milliseconds`);
  }
  return value;
}

// ---- process-table helpers (read-only) ----

interface ProcessRow {
  name: string;
  pid: number;
}

function listProcesses(name: string): ProcessRow[] {
  const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) return [];
  const rows: ProcessRow[] = [];
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const match = /"([^"]+)","(\d+)"/.exec(line);
    if (match && match[1]?.toLowerCase() === name.toLowerCase()) {
      rows.push({ name: match[1], pid: Number(match[2]) });
    }
  }
  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForProcessByName(
  name: string,
  timeoutMs: number
): Promise<{ found: boolean; pids: number[]; elapsedMs: number }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = listProcesses(name);
    if (rows.length > 0) {
      return { found: true, pids: rows.map((row) => row.pid), elapsedMs: Date.now() - started };
    }
    await sleep(500);
  }
  return { found: false, pids: [], elapsedMs: timeoutMs };
}

async function waitForProcessByNameGone(
  name: string,
  timeoutMs: number
): Promise<{ gone: boolean; residualPids: number[]; elapsedMs: number }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = listProcesses(name);
    if (rows.length === 0) {
      return { gone: true, residualPids: [], elapsedMs: Date.now() - started };
    }
    await sleep(500);
  }
  return { gone: false, residualPids: listProcesses(name).map((row) => row.pid), elapsedMs: timeoutMs };
}

// ---- game directory snapshot (read-only) ----

interface FileSnapshot {
  name: string;
  size: number;
  mtimeMs: number;
}

async function snapshotGameRoot(root: string): Promise<FileSnapshot[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: FileSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const info = await stat(join(root, entry.name));
      files.push({ name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      files.push({ name: entry.name, size: -1, mtimeMs: -1 });
    }
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function snapshotDigest(files: FileSnapshot[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file.name}|${file.size}|${file.mtimeMs};`);
  }
  return hash.digest('hex');
}

function diffSnapshots(before: FileSnapshot[], after: FileSnapshot[]): string[] {
  const afterByName = new Map(after.map((file) => [file.name, file]));
  const changes: string[] = [];
  for (const file of before) {
    const next = afterByName.get(file.name);
    if (!next) {
      changes.push(`removed:${file.name}`);
    } else if (next.size !== file.size || next.mtimeMs !== file.mtimeMs) {
      changes.push(`changed:${file.name}`);
    }
  }
  for (const file of after) {
    if (!before.some((item) => item.name === file.name)) changes.push(`added:${file.name}`);
  }
  return changes.sort();
}

// ---- watchdog ----

const sessionStartedAt = Date.now();
let forcedCleanup = false;
function forceCleanup(): void {
  forcedCleanup = true;
  const killed: string[] = [];
  for (const image of [SEKIRO_EXE, ME3_EXE]) {
    const result = spawnSync('taskkill', ['/IM', image, '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    if (result.status !== 0 && result.status !== 128) killed.push(`${image}(code=${result.status})`);
  }
  diag('error', 'ME3_SESSION_WATCHDOG_KILLED', '会话超时，看门狗已强制终止残留 me3/sekiro 进程树。', {
    killed
  });
}
const watchdog = setTimeout(() => {
  forceCleanup();
  finish('failed', '会话总时长超过上限，已强制清理并中止。', { timeoutMs: WATCHDOG_MS });
}, WATCHDOG_MS);
watchdog.unref();

// ---- session flow ----

function failClosed(message: string, extra: Record<string, unknown> = {}): never {
  forceCleanup();
  finish('failed', message, extra);
}

function finish(status: string, message: string, extra: Record<string, unknown> = {}): never {
  clearTimeout(watchdog);
  report.ok = status === 'passed';
  report.status = status;
  report.message = message;
  report.steps = steps;
  report.diagnostics = diagnostics;
  report.elapsedMs = Date.now() - sessionStartedAt;
  Object.assign(report, extra);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
  // finish() is used as `never`; a delayed watchdog must not run after this.
  process.exit(process.exitCode);
}

async function main(): Promise<void> {
  // 1. Environment preflight
  if (!RUN) {
    finish('skipped',
      'SOULFORGE_ME3_SEKIRO_SESSION_RUN 未设置，真实 Sekiro 会话未执行（结构化预检 + 诚实跳过）。');
  }
  step('env', true, {
    run: RUN,
    suspend: SUSPEND,
    gameRootPresent: Boolean(GAME_ROOT)
  });
  if (!GAME_ROOT || !isAbsolute(GAME_ROOT)) {
    failClosed('SOULFORGE_SEKIRO_GAME_ROOT 必须是绝对路径，无法启动真实游戏。');
  }
  const sekiroExe = join(GAME_ROOT, SEKIRO_EXE);
  try {
    const info = await stat(sekiroExe);
    if (!info.isFile()) failClosed(`${SEKIRO_EXE} 不是普通文件。`);
  } catch {
    failClosed(`${SEKIRO_EXE} 不存在于游戏根目录。`);
  }
  step('sekiro-exe', true, { path: SEKIRO_EXE });

  const beforeSnapshot = await snapshotGameRoot(GAME_ROOT);
  step('game-dir-snapshot-before', true, {
    fileCount: beforeSnapshot.length,
    digest: snapshotDigest(beforeSnapshot)
  });

  const gateway = new MainMe3RuntimeGateway({ localDataRoot: LOCAL_DATA_ROOT });
  const adapter = new Me3RuntimeAdapter({ gateway, versionPolicy: POLICY });

  // 2. detect
  const capability = await adapter.detect({ timeoutMs: 5_000 });
  step('detect', capability.state === 'exit-zero-unverified', {
    state: capability.state,
    detectedVersion: capability.detectedVersion ?? null,
    diagnostics: capability.diagnostics.map((item) => item.code)
  });
  if (capability.state !== 'exit-zero-unverified') {
    failClosed('me3 版本探测未达到 exit-zero-unverified，无法继续真实会话。', {
      state: capability.state
    });
  }

  // 3. createProfile
  const profileResult = await adapter.prepareProfile(
    { workspaceSessionId: 'sekiro-session-smoke', game: 'sekiro' },
    { timeoutMs: 20_000 }
  );
  step('create-profile', profileResult.ok === true && profileResult.status === 'succeeded', {
    status: profileResult.status,
    code: profileResult.diagnostics[0]?.code ?? null
  });
  if (profileResult.ok !== true || !profileResult.data) {
    failClosed('me3 profile 创建失败。', { diagnostics: profileResult.diagnostics });
  }
  const profile: RuntimeProfileRef = profileResult.data;

  // 4. launch #1
  const launch1 = await adapter.launch(
    { profile, operationId: 'sekiro-session-1' },
    { timeoutMs: 15_000 }
  );
  step('launch-1', launch1.ok === true, {
    status: launch1.status,
    code: launch1.diagnostics[0]?.code ?? null
  });
  if (launch1.ok !== true || !launch1.data) {
    failClosed('第一次 me3 launch 未成功。', { diagnostics: launch1.diagnostics });
  }
  const session1: RuntimeLaunchSession = launch1.data;

  const alive1 = await waitForProcessByName(SEKIRO_EXE, PROCESS_WAIT_MS);
  step('alive-1', alive1.found, {
    pids: alive1.pids,
    elapsedMs: alive1.elapsedMs
  });
  if (!alive1.found) {
    // Still record the terminate attempt before failing so the tree is cleaned.
    const term = await adapter.terminate(session1, { timeoutMs: 30_000 });
    step('terminate-1', term.ok === true, { status: term.status });
    failClosed('Sekiro 进程未在预期时间内出现；真实启动未确认。');
  }

  const me3LauncherRows = listProcesses(ME3_EXE);
  step('launcher-observed', me3LauncherRows.length > 0, { pids: me3LauncherRows.map((row) => row.pid) });

  // 5. terminate #1 + tree-gone confirmation
  const term1 = await adapter.terminate(session1, { timeoutMs: 30_000 });
  const gone1 = await waitForProcessByNameGone(SEKIRO_EXE, PROCESS_WAIT_MS);
  step('terminate-1', term1.ok === true && gone1.gone, {
    terminated: term1.ok === true,
    residualPids: gone1.residualPids,
    elapsedMs: gone1.elapsedMs
  });
  if (term1.ok !== true || !gone1.gone) {
    failClosed('第一次终止未确认进程树消失。', { residualPids: gone1.residualPids });
  }

  // 6. relaunch #2 (rollback-restart)
  const launch2 = await adapter.launch(
    { profile, operationId: 'sekiro-session-2' },
    { timeoutMs: 15_000 }
  );
  step('launch-2', launch2.ok === true, {
    status: launch2.status,
    code: launch2.diagnostics[0]?.code ?? null
  });
  if (launch2.ok !== true || !launch2.data) {
    failClosed('回滚后第二次 me3 launch 未成功。', { diagnostics: launch2.diagnostics });
  }
  const session2: RuntimeLaunchSession = launch2.data;

  const alive2 = await waitForProcessByName(SEKIRO_EXE, PROCESS_WAIT_MS);
  step('alive-2', alive2.found, {
    pids: alive2.pids,
    elapsedMs: alive2.elapsedMs
  });
  if (!alive2.found) {
    const term = await adapter.terminate(session2, { timeoutMs: 30_000 });
    step('terminate-2', term.ok === true, { status: term.status });
    failClosed('回滚后复启的 Sekiro 进程未出现。');
  }

  // 7. terminate #2 + final tree-gone confirmation
  const term2 = await adapter.terminate(session2, { timeoutMs: 30_000 });
  const gone2 = await waitForProcessByNameGone(SEKIRO_EXE, PROCESS_WAIT_MS);
  const me3Residual = listProcesses(ME3_EXE);
  step('terminate-2', term2.ok === true && gone2.gone, {
    terminated: term2.ok === true,
    residualPids: gone2.residualPids,
    me3ResidualPids: me3Residual.map((row) => row.pid),
    elapsedMs: gone2.elapsedMs
  });

  // 8. game directory read-only check
  const afterSnapshot = await snapshotGameRoot(GAME_ROOT);
  const changes = diffSnapshots(beforeSnapshot, afterSnapshot);
  if (changes.length > 0) {
    diag('warning', 'GAME_DIR_CHANGED', '会话期间游戏目录出现文件变动（本 smoke 自身不写入）。', {
      changes
    });
  }
  step('game-dir-snapshot-after', changes.length === 0, {
    fileCount: afterSnapshot.length,
    digest: snapshotDigest(afterSnapshot),
    changes
  });

  const clean = term2.ok === true
    && gone2.gone
    && me3Residual.length === 0
    && changes.length === 0;
  if (clean) {
    // 字段名与 authority 都必须与本套件真正观测到的东西对齐。
    //
    // 本套件观测的全是**进程生命周期**：profile 创建、launch、轮询 tasklist
    // 确认存活、terminate 后进程树消失、游戏目录快照无变动。它用 --suspend
    // 启动（渲染器不运行），且 me3RuntimeAdapter 传入的 packagePaths 为空数组
    // ——启动的 profile 里 Mod 包数为零。没有任何一步读内存、读游戏日志或观察画面。
    //
    // 因此：
    //  · 字段名从 sekiroProcessLifecycleObserved 改为 sekiroProcessLifecycleObserved
    //    ——「executed」读起来像「游戏跑起来了并加载了我们的东西」；
    //  · authority 不再置 native-verified。进程起来又干净退出，不足以支撑
    //    「原生已验证」；真实 Mod 加载确认仍是 REL-H 的 open 项。
    //
    // 另注意成功判据里的 changes.length === 0 是「我们没写游戏目录」，
    // 它是 Mod 已加载的**反面**证据，不能被读成加载成功。
    report.sekiroProcessLifecycleObserved = true;
    report.authority = 'candidate';
    finish('passed',
      '真实 Sekiro 进程生命周期通过：profile 创建、launch、进程存活、terminate 进程树消失、'
      + '回滚后复启均已确认。**不含**游戏内 Mod 加载确认——本次以 --suspend 启动且 profile '
      + '内 Mod 包数为零，authority 保持 candidate。');
  }
  failClosed('会话存在未清理的进程或游戏目录变动。', {
    terminateConfirmed: term2.ok === true,
    sekiroGone: gone2.gone,
    me3Residual: me3Residual.map((row) => row.pid),
    gameDirChanges: changes
  });
}

main().catch((error) => {
  forceCleanup();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  finish('failed', '会话 smoke 抛出了未捕获异常。', {
    error: error instanceof Error ? error.message : String(error)
  });
});
