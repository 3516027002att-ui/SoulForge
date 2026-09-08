/**
 * Playwright 生产 main harness：直接运行**真实的** out/main/index.js，
 * 只把最外层不可控依赖换成受控替身。
 *
 * 为什么必须有它（这是本文件存在的全部理由）：
 *
 * 旧的 fixture-main.mjs 自建 19 个 channel、用 sandbox: false、并且一度指向与
 * 生产不同的 preload 产物。后果是**实测发生过的**：生产 preload 因
 * 「sandbox: true + ESM」冲突从未加载成功，window.soulforge 完全不存在，
 * 界面上所有按钮显示「浏览器预览：仅在 SoulForge 桌面版可用」——而 e2e 16/16
 * 全绿。测试环境与生产环境的每一处差异，都是一个能藏住整类缺陷的地方，
 * 而这一处藏住的是「整个应用不可用」。
 *
 * 本 harness 的做法：**不重建任何东西**。它在 import 生产 main 之前先装好
 * dialog 替身，然后让生产 main 自己走完 app.whenReady → createWindow →
 * registerIpcHandlers 的全部真实流程。因此：
 *   · webPreferences 是生产那一份（含 sandbox: true），不可能与生产漂移；
 *   · preload 路径是生产那一份，preload 那类缺陷会被立刻抓到；
 *   · 38 个 handle 注册点全部是生产实现。
 *
 * 与生产的唯一差异（每条都写明理由）：
 *
 *  1. dialog.showOpenDialog 被替身。真实对话框是模态原生窗口，e2e 无法关闭它，
 *     会挂到超时。替身返回受控临时目录，于是 workspace.openDialog /
 *     openBaseDialog 两个 channel 的**生产实现**（createDirectorySelection 的
 *     发送方校验、selectionId 生成、所有权绑定）全部照常执行。
 *  2. userData 由 --user-data-dir 指向临时目录（Playwright 启动参数给）。
 *     这是 Electron 标准隔离，不改任何生产代码路径；SQLite、凭据 vault、
 *     operation log 都落在临时目录。
 *
 * 明确不做的事：不 stub 任何 IPC handler、不 stub Bridge、不 stub 数据库、
 * 不新建 BrowserWindow、不放宽 webPreferences。这些都是「测试与生产不一致」
 * 的来源，正是本文件要消除的东西。
 */
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configuredSnapshotRoot = process.env.SF_PRODUCTION_ARTIFACT_SNAPSHOT_ROOT?.trim();
const snapshotRoot = configuredSnapshotRoot ? resolve(configuredSnapshotRoot) : null;
const configuredOutRoot = process.env.SF_PRODUCTION_OUT_ROOT?.trim();
const outRoot = resolve(configuredOutRoot || (snapshotRoot ? join(snapshotRoot, 'apps/desktop/out') : resolve(here, '../../out')));

/**
 * A real Agent/MAP run may be concurrent with a later source/build update.
 * When a snapshot root is supplied, pin every runtime lookup to that root and
 * fail before Electron creates a window if the snapshot marker is missing or
 * the caller accidentally points at the live out directory.
 */
if (snapshotRoot) {
  const snapshotManifestPath = join(snapshotRoot, 'agent-production-snapshot.json');
  const expectedOutRoot = resolve(snapshotRoot, 'apps/desktop/out');
  if (!existsSync(snapshotManifestPath)) {
    throw new Error(`AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_MISSING: ${snapshotManifestPath}`);
  }
  if (outRoot.toLowerCase() !== expectedOutRoot.toLowerCase()) {
    throw new Error(`AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_OUT_MISMATCH: ${outRoot}`);
  }
  let snapshotManifest;
  try {
    snapshotManifest = JSON.parse(readFileSync(snapshotManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof snapshotManifest?.artifactId !== 'string' || snapshotManifest.artifactId.length < 16) {
    throw new Error(`AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_INVALID: ${snapshotManifestPath}`);
  }
  for (const requiredPath of [
    join(snapshotRoot, 'apps/desktop/.native/better_sqlite3.node'),
    join(outRoot, 'main/index.js'),
    join(outRoot, 'preload/index.cjs'),
    join(outRoot, 'renderer/index.html'),
    join(snapshotRoot, 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj'),
    join(snapshotRoot, 'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe')
  ]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_FILE_MISSING: ${requiredPath}`);
    }
  }
  const systemPromptPath = join(snapshotRoot, 'prompt/system.md');
  if (!existsSync(systemPromptPath)) {
    throw new Error(`AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_PROMPT_MISSING: ${systemPromptPath}`);
  }
  const mutterPath = join(snapshotRoot, 'mutter.md');
  process.env.SF_PRODUCTION_ARTIFACT_SNAPSHOT_MANIFEST = snapshotManifestPath;
  process.env.SF_PRODUCTION_ARTIFACT_ID = snapshotManifest.artifactId;
  process.env.SF_PRODUCTION_OUT_ROOT = outRoot;
  process.env.SOULFORGE_SYSTEM_PROMPT_PATH = systemPromptPath;
  if (existsSync(mutterPath)) process.env.SOULFORGE_MUTTER_PATH = mutterPath;
  else delete process.env.SOULFORGE_MUTTER_PATH;
  // runBridge resolves its project relative to cwd/moduleDir.  The copied
  // csproj + publish directory live under this root, so this also pins native
  // Bridge execution without introducing a production-only global env knob.
  process.chdir(snapshotRoot);
}

/**
 * 生产 main 关闭链路的旁路观测。这里只写最小、无路径的 JSON 行到 stderr，
 * 不阻止或改变 Electron 的任何退出事件；它用于区分窗口关闭、渲染器退出、
 * app 退出和主进程退出的先后关系。
 */
const PRODUCTION_CLOSE_TELEMETRY_MARKER = '[SF_PRODUCTION_CLOSE_TELEMETRY]';
const configuredCloseTelemetryArtifactId = process.env.SF_PRODUCTION_ARTIFACT_ID?.trim();
const closeTelemetryArtifactId = /^[a-f0-9]{16,128}$/i.test(configuredCloseTelemetryArtifactId ?? '')
  ? configuredCloseTelemetryArtifactId
  : null;

function emitProductionCloseTelemetry(event, details = {}) {
  const payload = {
    atUTC: new Date().toISOString(),
    pid: process.pid,
    artifactId: closeTelemetryArtifactId,
    windowId: Number.isInteger(details.windowId) ? details.windowId : null,
    event
  };
  if (typeof details.reason === 'string' && details.reason.length <= 64) payload.reason = details.reason;
  if (Number.isInteger(details.exitCode)) payload.exitCode = details.exitCode;
  if (Number.isInteger(details.code)) payload.code = details.code;
  try {
    process.stderr.write(`${PRODUCTION_CLOSE_TELEMETRY_MARKER} ${JSON.stringify(payload)}\n`);
  } catch {
    // Closing telemetry must never affect the production lifecycle.
  }
}

function installProductionCloseTelemetry() {
  app.on('browser-window-created', (_event, window) => {
    const windowId = Number.isInteger(window?.id) ? window.id : null;
    try {
      window?.on('close', () => emitProductionCloseTelemetry('window-close', { windowId }));
      window?.on('closed', () => emitProductionCloseTelemetry('window-closed', { windowId }));
      window?.webContents?.on('render-process-gone', (_renderEvent, details) => {
        emitProductionCloseTelemetry('render-process-gone', {
          windowId,
          reason: details?.reason,
          exitCode: details?.exitCode
        });
      });
    } catch {
      // A partially created window must not alter the main lifecycle.
    }
  });
  app.on('window-all-closed', () => emitProductionCloseTelemetry('window-all-closed'));
  app.on('before-quit', () => emitProductionCloseTelemetry('before-quit'));
  app.on('will-quit', () => emitProductionCloseTelemetry('will-quit'));
  app.on('child-process-gone', (_event, details) => {
    emitProductionCloseTelemetry('child-process-gone', {
      reason: details?.reason,
      exitCode: details?.exitCode
    });
  });
  process.once('exit', (code) => emitProductionCloseTelemetry('process-exit', { code }));
}

installProductionCloseTelemetry();

/** SF_E2E_DIALOG_CANCEL=1 时模拟用户在目录选择器里取消。 */
const CANCEL_DIALOG = process.env.SF_E2E_DIALOG_CANCEL === '1';

/**
 * MAP 真实生产链路的 main-side 观测夹具。
 *
 * 只有显式设置 SF_MAP_MAIN_TELEMETRY=1 时启用。它在生产 main 导入之前
 * 包装公开的 resource.readMapStaticGeometry handler，因此不改变 preload API、
 * 参数、返回值或调用顺序；每次请求都记录真实 BrowserWindow 状态和
 * backgroundThrottling，退出时再输出一个有限大小的汇总 marker，供真实 MAP
 * 探针从子进程 stdout 读取。powerMonitor 的 lock/suspend 事件也只计数，不
 * 伪造或阻止系统事件。
 */
const MAP_MAIN_TELEMETRY_ENABLED = process.env.SF_MAP_MAIN_TELEMETRY === '1';
const MAP_MAIN_TELEMETRY_MARKER = '[SF_MAP_MAIN_TELEMETRY]';
const mapMainTelemetry = {
  enabled: MAP_MAIN_TELEMETRY_ENABLED,
  startedAtMs: Date.now(),
  startedAtUTC: new Date().toISOString(),
  installed: false,
  handlerWrapped: false,
  instrumentationError: null,
  callSampleLimit: 512,
  stateTransitionLimit: 128,
  topSlowCallLimit: 16,
  timeBucketLimit: 3600,
  calls: [],
  topSlowCalls: [],
  timeBuckets: new Map(),
  stateTransitions: [],
  lastWindowState: null,
  totalCalls: 0,
  okCount: 0,
  failedCount: 0,
  totalMs: 0,
  minMs: Number.POSITIVE_INFINITY,
  maxMs: 0,
  powerEvents: {
    'lock-screen': 0,
    'unlock-screen': 0,
    suspend: 0,
    resume: 0
  },
  lastPowerEvent: null,
  finalEmitted: false
};

function mapMainPercentile(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))] ?? null;
}

function mapMainWindowState(event) {
  let window = null;
  try {
    window = BrowserWindow.fromWebContents?.(event?.sender) ?? BrowserWindow.getAllWindows?.()[0] ?? null;
  } catch {
    // The window may be closing while the last native request resolves.
  }
  let backgroundThrottling = null;
  let backgroundThrottlingSource = 'unavailable';
  try {
    const webContents = window?.webContents;
    let candidate;
    if (typeof webContents?.getBackgroundThrottling === 'function') {
      candidate = webContents.getBackgroundThrottling();
      backgroundThrottlingSource = 'getBackgroundThrottling';
    } else if (typeof webContents?.backgroundThrottling === 'boolean') {
      candidate = webContents.backgroundThrottling;
      backgroundThrottlingSource = 'webContents.backgroundThrottling';
    } else if (typeof webContents?.getLastWebPreferences === 'function') {
      candidate = webContents.getLastWebPreferences()?.backgroundThrottling;
      backgroundThrottlingSource = 'getLastWebPreferences';
    }
    if (typeof candidate === 'boolean') backgroundThrottling = candidate;
  } catch {
    // Keep an explicit null: an unavailable observation is not a false value.
  }
  const readWindowBoolean = (method) => {
    try {
      return typeof window?.[method] === 'function' ? Boolean(window[method]()) : null;
    } catch {
      return null;
    }
  };
  return {
    visible: readWindowBoolean('isVisible'),
    minimized: readWindowBoolean('isMinimized'),
    focused: readWindowBoolean('isFocused'),
    backgroundThrottling,
    backgroundThrottlingSource
  };
}

function emitMapMainTelemetry(payload) {
  if (!MAP_MAIN_TELEMETRY_ENABLED) return;
  try {
    // eslint-disable-next-line no-console
    console.log(`${MAP_MAIN_TELEMETRY_MARKER} ${JSON.stringify(payload)}`);
  } catch {
    // Telemetry must never affect the production request path.
  }
}

function mapMainTelemetrySummary() {
  const durations = mapMainTelemetry.calls.map((entry) => entry.elapsedMs);
  const firstRetainedCall = mapMainTelemetry.calls[0]?.index ?? null;
  const lastRetainedCall = mapMainTelemetry.calls.at(-1)?.index ?? null;
  return {
    enabled: mapMainTelemetry.enabled,
    startedAtUTC: mapMainTelemetry.startedAtUTC,
    installed: mapMainTelemetry.installed,
    handlerWrapped: mapMainTelemetry.handlerWrapped,
    instrumentationError: mapMainTelemetry.instrumentationError,
    calls: mapMainTelemetry.totalCalls,
    okCount: mapMainTelemetry.okCount,
    failedCount: mapMainTelemetry.failedCount,
    totalMs: mapMainTelemetry.totalMs,
    averageMs: mapMainTelemetry.totalCalls > 0 ? mapMainTelemetry.totalMs / mapMainTelemetry.totalCalls : null,
    minMs: Number.isFinite(mapMainTelemetry.minMs) ? mapMainTelemetry.minMs : null,
    p50Ms: mapMainPercentile(durations, 0.5),
    p95Ms: mapMainPercentile(durations, 0.95),
    maxMs: mapMainTelemetry.totalCalls > 0 ? mapMainTelemetry.maxMs : null,
    quantileSample: {
      kind: 'recent-call-samples',
      sampleCount: mapMainTelemetry.calls.length,
      sampleLimit: mapMainTelemetry.callSampleLimit,
      firstCallIndex: firstRetainedCall,
      lastCallIndex: lastRetainedCall,
      complete: mapMainTelemetry.totalCalls <= mapMainTelemetry.callSampleLimit
    },
    powerEvents: { ...mapMainTelemetry.powerEvents },
    lastPowerEvent: mapMainTelemetry.lastPowerEvent,
    recentCalls: mapMainTelemetry.calls.slice(-64),
    topSlowCalls: mapMainTelemetry.topSlowCalls.slice(),
    timeBuckets: [...mapMainTelemetry.timeBuckets.values()],
    stateTransitions: mapMainTelemetry.stateTransitions.slice(-mapMainTelemetry.stateTransitionLimit)
  };
}

function mapMainTelemetryCompactSummary() {
  const firstRetainedCall = mapMainTelemetry.calls[0]?.index ?? null;
  const lastRetainedCall = mapMainTelemetry.calls.at(-1)?.index ?? null;
  return {
    calls: mapMainTelemetry.totalCalls,
    okCount: mapMainTelemetry.okCount,
    failedCount: mapMainTelemetry.failedCount,
    totalMs: mapMainTelemetry.totalMs,
    minMs: Number.isFinite(mapMainTelemetry.minMs) ? mapMainTelemetry.minMs : null,
    maxMs: mapMainTelemetry.totalCalls > 0 ? mapMainTelemetry.maxMs : null,
    retainedSampleCount: mapMainTelemetry.calls.length,
    retainedSampleLimit: mapMainTelemetry.callSampleLimit,
    retainedSampleFirstCallIndex: firstRetainedCall,
    retainedSampleLastCallIndex: lastRetainedCall,
    powerEvents: { ...mapMainTelemetry.powerEvents },
    lastPowerEvent: mapMainTelemetry.lastPowerEvent
  };
}

function recordMapMainSlowCall(entry) {
  const slowCalls = mapMainTelemetry.topSlowCalls;
  if (slowCalls.length < mapMainTelemetry.topSlowCallLimit) {
    slowCalls.push(entry);
  } else {
    let slowestIndex = 0;
    for (let index = 1; index < slowCalls.length; index += 1) {
      if (slowCalls[index].elapsedMs < slowCalls[slowestIndex].elapsedMs) slowestIndex = index;
    }
    if (entry.elapsedMs > slowCalls[slowestIndex].elapsedMs) slowCalls[slowestIndex] = entry;
  }
  slowCalls.sort((left, right) => right.elapsedMs - left.elapsedMs);
}

function recordMapMainTimeBucket(entry) {
  const bucketIndex = Math.max(0, Math.floor(entry.relativeStartMs / 1000));
  let bucket = mapMainTelemetry.timeBuckets.get(bucketIndex);
  if (!bucket) {
    bucket = {
      bucketIndex,
      startRelativeMs: bucketIndex * 1000,
      calls: 0,
      okCount: 0,
      failedCount: 0,
      totalMs: 0,
      maxMs: 0
    };
    mapMainTelemetry.timeBuckets.set(bucketIndex, bucket);
  }
  bucket.calls += 1;
  if (entry.ok) bucket.okCount += 1;
  else bucket.failedCount += 1;
  bucket.totalMs += entry.elapsedMs;
  bucket.maxMs = Math.max(bucket.maxMs, entry.elapsedMs);
  while (mapMainTelemetry.timeBuckets.size > mapMainTelemetry.timeBucketLimit) {
    const oldest = mapMainTelemetry.timeBuckets.keys().next().value;
    if (typeof oldest !== 'number') break;
    mapMainTelemetry.timeBuckets.delete(oldest);
  }
}

function installMapMainTelemetry() {
  if (!MAP_MAIN_TELEMETRY_ENABLED) return;

  for (const eventName of Object.keys(mapMainTelemetry.powerEvents)) {
    try {
      powerMonitor.on(eventName, () => {
        mapMainTelemetry.powerEvents[eventName] += 1;
        const atMs = Date.now();
        mapMainTelemetry.lastPowerEvent = {
          event: eventName,
          atUTC: new Date(atMs).toISOString(),
          relativeMs: atMs - mapMainTelemetry.startedAtMs
        };
        emitMapMainTelemetry({ type: 'power-event', event: eventName });
      });
    } catch (error) {
      mapMainTelemetry.instrumentationError ??= `POWER_MONITOR_${eventName}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const originalHandle = ipcMain.handle.bind(ipcMain);
  const wrappedHandle = (channel, listener) => {
    if (channel !== 'resource.readMapStaticGeometry' || typeof listener !== 'function') {
      return originalHandle(channel, listener);
    }
    mapMainTelemetry.handlerWrapped = true;
    return originalHandle(channel, async (...args) => {
      const startedAt = process.hrtime.bigint();
      const startedAtMs = Date.now();
      let result;
      let thrown = null;
      try {
        result = await listener(...args);
        return result;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const completedAtMs = Date.now();
        const state = mapMainWindowState(args[0]);
        const entry = {
          index: mapMainTelemetry.totalCalls + 1,
          elapsedMs,
          startedAtUTC: new Date(startedAtMs).toISOString(),
          completedAtUTC: new Date(completedAtMs).toISOString(),
          relativeStartMs: startedAtMs - mapMainTelemetry.startedAtMs,
          relativeCompletedMs: completedAtMs - mapMainTelemetry.startedAtMs,
          ok: !thrown && result?.ok === true,
          modelName: typeof args[2] === 'string' ? args[2] : null,
          cursorPresent: Boolean(args[3]),
          sessionPresent: Boolean(args[4]),
          ...state,
          error: thrown ? String(thrown?.message ?? thrown) : null
        };
        mapMainTelemetry.totalCalls += 1;
        if (entry.ok) mapMainTelemetry.okCount += 1;
        else mapMainTelemetry.failedCount += 1;
        mapMainTelemetry.totalMs += elapsedMs;
        mapMainTelemetry.minMs = Math.min(mapMainTelemetry.minMs, elapsedMs);
        mapMainTelemetry.maxMs = Math.max(mapMainTelemetry.maxMs, elapsedMs);
        mapMainTelemetry.calls.push(entry);
        recordMapMainSlowCall(entry);
        recordMapMainTimeBucket(entry);
        const previousState = mapMainTelemetry.lastWindowState;
        const nextState = {
          visible: entry.visible,
          minimized: entry.minimized,
          focused: entry.focused,
          backgroundThrottling: entry.backgroundThrottling,
          backgroundThrottlingSource: entry.backgroundThrottlingSource
        };
        if (JSON.stringify(previousState) !== JSON.stringify(nextState)) {
          mapMainTelemetry.stateTransitions.push({
            atUTC: entry.completedAtUTC,
            relativeMs: entry.relativeCompletedMs,
            from: previousState,
            to: nextState,
            callIndex: entry.index
          });
          if (mapMainTelemetry.stateTransitions.length > mapMainTelemetry.stateTransitionLimit) {
            mapMainTelemetry.stateTransitions.shift();
          }
          mapMainTelemetry.lastWindowState = nextState;
        }
        if (mapMainTelemetry.calls.length > mapMainTelemetry.callSampleLimit) mapMainTelemetry.calls.shift();
        emitMapMainTelemetry({ type: 'call', ...entry, aggregate: mapMainTelemetryCompactSummary() });
      }
    });
  };
  try {
    ipcMain.handle = wrappedHandle;
  } catch {
    try {
      Object.defineProperty(ipcMain, 'handle', { configurable: true, writable: true, value: wrappedHandle });
    } catch (error) {
      mapMainTelemetry.instrumentationError = `IPC_HANDLE_WRAP_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
  }
  mapMainTelemetry.installed = true;
  emitMapMainTelemetry({
    type: 'installed',
    atUTC: new Date().toISOString(),
    relativeMs: Date.now() - mapMainTelemetry.startedAtMs
  });
}

function emitFinalMapMainTelemetry() {
  if (!MAP_MAIN_TELEMETRY_ENABLED || mapMainTelemetry.finalEmitted) return;
  mapMainTelemetry.finalEmitted = true;
  emitMapMainTelemetry({ type: 'summary', summary: mapMainTelemetrySummary() });
}

installMapMainTelemetry();
if (MAP_MAIN_TELEMETRY_ENABLED) {
  app.once('before-quit', emitFinalMapMainTelemetry);
  process.once('exit', emitFinalMapMainTelemetry);
}

// 允许一次真实资源探针把生产 main 接到用户指定的 overlay/base；默认仍使用
// 隔离的合成目录，避免普通 e2e 读写用户工作区。
const externalOverlayRoot = process.env.SF_E2E_OVERLAY_ROOT?.trim();
const externalBaseRoot = process.env.SF_E2E_BASE_ROOT?.trim();
const overlayRoot = externalOverlayRoot || join(app.getPath('userData'), 'e2e-overlay');
const baseRoot = externalBaseRoot || join(app.getPath('userData'), 'e2e-base');
// Keep production-Electron tests from opening the user's persistent
// <overlay>/.soulforge/workspace.db. Real assets remain read-only inputs;
// SQLite/fingerprint/staging state is isolated under this run's userData.
process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = join(app.getPath('userData'), 'workspace-storage');

/** 测试工作区：目录结构镜像真实 mod 布局，内容是最小合法样本。 */
function seedWorkspace() {
  if (externalOverlayRoot || externalBaseRoot) return;
  for (const dir of ['msg', 'param', 'event', 'script']) {
    mkdirSync(join(overlayRoot, dir), { recursive: true });
  }
  mkdirSync(baseRoot, { recursive: true });
  // 纯文本资源：足以驱动文本预览/编辑链路，不需要 native parser 或真实语料。
  writeFileSync(join(overlayRoot, 'msg', 'e2e-sample.txt'), 'SoulForge e2e sample\n', 'utf8');
}

/**
 * 只替换 dialog.showOpenDialog。用属性覆盖而不是改生产代码——生产 handler 一行不动。
 * 必须在 import 生产 main 之前装好，否则窗口可能已经创建、首个对话框已经弹出。
 */
function stubDialog() {
  dialog.showOpenDialog = async (options) => {
    if (CANCEL_DIALOG) return { canceled: true, filePaths: [] };
    // 按标题区分 overlay / base，对应生产的两个 channel 语义。
    const title = typeof options?.title === 'string' ? options.title : '';
    const target = /原版/.test(title) ? baseRoot : overlayRoot;
    return { canceled: false, filePaths: [target] };
  };
}

seedWorkspace();
stubDialog();

// 让生产 main 自己跑完整流程。它的顶层就绑了 app.whenReady → createWindow →
// registerIpcHandlers，所以这里不需要（也不应该）自己建窗口。
await import(pathToFileURL(join(outRoot, 'main', 'index.js')).href);
