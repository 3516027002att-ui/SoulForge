/**
 * 受控真实 MAP 流式加载探针。
 *
 * 这个脚本只读取真实只狼资源：
 *   - 通过 production-main.mjs 启动真实 Electron main/preload/Bridge 链；
 *   - 通过公开 window.soulforge API 读取完整 MSB 与分页静态几何；
 *   - 通过真实 MAP 工作台触发 proxy -> geometry 的热替换；
 *   - 在 renderer 侧只安装观测夹具，记录 draw-call、RAF 长帧和切图 cleanup。
 *
 * 它不调用任何写回 API，不复制/改写 mods，不修改 package.json/tiers。
 * 默认运行 normal；传 --cancel 可运行切图取消观测。native 取消只按 main
 * 侧结构化 Bridge 终端回执判定，renderer cleanup 与 command/artifact 终态严格分开。
 * 传 --fixture 只运行本文件内的累计窗口/状态夹具，不启动 Electron 或读取资源。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import {
  assertAgentProductionArtifactSnapshotFresh,
  createAgentProductionArtifactSnapshot
} from './agent-production-build-lib.mjs';
import {
  createMapNativeTimingAccumulator,
  recordMapNativeTimingCall,
  snapshotMapNativeTimingAccumulator
} from './map-native-timing-aggregate.mjs';
import {
  createCharacterNativeTimingAccumulator,
  recordCharacterNativeTimingCall,
  snapshotCharacterNativeTimingAccumulator,
  validateCharacterNativeTimingSummary
} from './character-native-timing-aggregate.mjs';
import {
  createCharacterMainTimingAccumulator,
  recordCharacterMainTimingCall,
  snapshotCharacterMainTimingAccumulator,
  validateCharacterMainTimingSummary
} from './character-main-timing-aggregate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_STREAMING_USAGE = [
  'Usage: node scripts/verify-map-streaming-native.mjs [--fixture] [--cancel]',
  '',
  '  --fixture  run local telemetry/state fixtures without Electron or native resources',
  '  --cancel   run the real MAP switch/cancellation observation instead of normal load',
  '  -h, --help show this usage'
].join('\n');
const CLI_ARGS = new Set(['--fixture', '--cancel', '-h', '--help']);
const cliArgs = process.argv.slice(2);
const unknownCliArgs = cliArgs.filter((argument) => !CLI_ARGS.has(argument));
if (unknownCliArgs.length > 0) {
  process.stderr.write(`[SF_MAP_ARGS] unknown argument(s): ${unknownCliArgs.join(', ')}\n`);
  process.exit(2);
}
if (cliArgs.includes('-h') || cliArgs.includes('--help')) {
  process.stdout.write(`${MAP_STREAMING_USAGE}\n`);
  process.exit(0);
}

const GAME_ROOT = process.env.SOULFORGE_SEKIRO_ROOT?.trim()
  || 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
const OVERLAY_ROOT = process.env.SOULFORGE_SEKIRO_MOD_ROOT?.trim() || join(GAME_ROOT, 'mods');
const MAP_ID = process.env.SF_MAP_ID?.trim() || 'm11_00_00_00';
const REQUESTED_MODEL = process.env.SF_MAP_MODEL_NAME?.trim() || 'o000100';
const MODE = process.argv.includes('--cancel') || process.env.SF_MAP_MODE === 'cancel' ? 'cancel' : 'normal';
const FIXTURE_ONLY = process.argv.includes('--fixture');
const AGENT_CONCURRENT_LOAD = process.env.SF_MAP_AGENT_CONCURRENT?.trim() || 'unknown';
const AGENT_SESSION = process.env.SF_MAP_AGENT_SESSION?.trim() || null;
const ARTIFACT_LABEL = process.env.SF_MAP_ARTIFACT_LABEL?.trim() || null;
const LIVE_PRODUCTION_MAIN = join(ROOT, 'apps/desktop/e2e/playwright/production-main.mjs');
const MAP_RELATIVE_PATH = `map/mapstudio/${MAP_ID}.msb.dcx`;
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_DIRECT_TIMEOUT_MS = 180_000;
const DEFAULT_CANCEL_DELAY_MS = 1_000;
const CANCEL_OBSERVATION_MIN_MS = 5_000;
const CANCEL_OBSERVATION_MAX_MS = 30_000;
// 单阶段 timeout 仍保留用于区分具体卡点；总 deadline 防止 workspace scan、
// 两次 native read、Electron UI 等阶段叠加后无限延长。15 分钟足够覆盖真实
// m11 大地图的冷启动和分页，同时让 Ctrl+C/外部 runner 能在有界时间内收口。
const DEFAULT_TOTAL_TIMEOUT_MS = 900_000;
// Renderer-side observations must never keep the probe's report/finally path
// open indefinitely.  These are intentionally shorter than the phase budgets
// so a timeout can be recorded and the Electron process can still be closed.
const MAP_PAGE_SNAPSHOT_TIMEOUT_MS = 10_000;
const RENDERER_PROFILE_COMMAND_TIMEOUT_MS = 5_000;
const RENDERER_PROFILE_STOP_TIMEOUT_MS = 15_000;
const RENDERER_PROFILE_CLEANUP_TIMEOUT_MS = 2_000;
const RENDERER_PROFILE_WRITE_TIMEOUT_MS = 10_000;
const RENDERER_PROFILE_PHASE_TIMEOUT_MS = 30_000;

function boundedInteger(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

const UI_TIMEOUT_MS = boundedInteger('SF_MAP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 10_000, 600_000);
const DIRECT_TIMEOUT_MS = boundedInteger('SF_MAP_DIRECT_TIMEOUT_MS', DEFAULT_DIRECT_TIMEOUT_MS, 10_000, 600_000);
const CANCEL_DELAY_MS = boundedInteger('SF_MAP_CANCEL_DELAY_MS', DEFAULT_CANCEL_DELAY_MS, 100, 30_000);
const MAX_GEOMETRY_PAGES = boundedInteger('SF_MAP_MAX_GEOMETRY_PAGES', 256, 1, 4096);
const TOTAL_TIMEOUT_MS = boundedInteger('SF_MAP_TOTAL_TIMEOUT_MS', DEFAULT_TOTAL_TIMEOUT_MS, 60_000, 1_800_000);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = resolve(ROOT, 'output/playwright', `map-streaming-native-${MAP_ID}-${MODE}-${stamp}`);
const scratchRoot = FIXTURE_ONLY ? null : await mkdtemp(join(tmpdir(), 'soulforge-map-streaming-native-'));
const userDataDir = scratchRoot ? join(scratchRoot, 'user-data') : null;
if (!FIXTURE_ONLY) await mkdir(reportDir, { recursive: true });

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
function bounded(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

const finiteTimingNumber = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

/**
 * Page timing is kept only when the page supplied every finite numeric field
 * and its monotonic clock did not move backwards.  The page and Node wall
 * clocks are different domains; consumers must use pageDurationMs for an
 * exact duration and must not infer a cross-process delay from the wall times.
 */
function normalizePageTaskTiming(timing) {
  if (!timing || typeof timing !== 'object') return null;
  const normalized = {
    pageStartedAtUTC: finiteTimingNumber(timing.pageStartedAtUTC),
    pageCompletedAtUTC: finiteTimingNumber(timing.pageCompletedAtUTC),
    pageStartedAt: finiteTimingNumber(timing.pageStartedAt),
    pageCompletedAt: finiteTimingNumber(timing.pageCompletedAt),
    pageDurationMs: finiteTimingNumber(timing.pageDurationMs)
  };
  if (Object.values(normalized).some((value) => value === null)) return null;
  const monotonicDurationMs = normalized.pageCompletedAt - normalized.pageStartedAt;
  if (
    monotonicDurationMs < 0
    || Math.abs(normalized.pageDurationMs - monotonicDurationMs) > 0.5
  ) return null;
  normalized.pageDurationMs = monotonicDurationMs;
  return normalized;
}

/**
 * Run a bounded observation with at most one underlying operation in flight.
 *
 * Promise.race (used by bounded()) limits how long the caller waits, but it
 * cannot cancel Playwright's page.evaluate.  The normal MAP polling loop must
 * therefore retain the timed-out operation as the single-flight owner: later
 * polls return a structured pending-deadline record until that operation
 * settles.  This keeps a renderer stall from turning one slow evaluate into a
 * queue of evaluates and locator requests.
 */
function createSingleFlightBounded(
  name,
  { now = () => Date.now(), inFlightCode = 'SINGLE_FLIGHT_IN_FLIGHT' } = {}
) {
  let nextCallId = 0;
  let pending = null;
  const records = [];
  const counts = {
    started: 0,
    completed: 0,
    slow: 0,
    timedOut: 0,
    failed: 0,
    lateSettled: 0,
    lateFailed: 0,
    pendingDeadline: 0
  };

  const safeError = (error) => ({
    name: error instanceof Error && error.name ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  });
  const remember = (record) => {
    records.push(record);
    if (records.length > 256) records.shift();
  };
  const pendingRecord = (status, reason, requestedAt, pendingCallId = null) => {
    const record = {
      operation: name,
      callId: null,
      status,
      reason,
      requestedAt,
      startedAt: null,
      settledAt: null,
      elapsedMs: 0,
      receivedAt: null,
      complete: false,
      slow: false,
      failed: false,
      timedOut: false,
      lateSettled: false,
      underlyingPending: pendingCallId !== null,
      pendingCallId,
      lateOutcome: null,
      taskTiming: null,
      error: null,
      timeoutMs: null,
      effectiveTimeoutMs: null,
      deadlineAt: null
    };
    counts.pendingDeadline += 1;
    remember(record);
    return record;
  };

  const run = (task, options = {}) => {
    const requestedAt = now();
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 5_000;
    const slowMs = Number.isFinite(options.slowMs) ? Math.max(0, options.slowMs) : timeoutMs;
    if (pending) {
      const deadlineReached = Number.isFinite(options.deadlineAt) && requestedAt >= options.deadlineAt;
      const record = pendingRecord(
        'pending-deadline',
        deadlineReached ? `${inFlightCode}_AT_DEADLINE` : inFlightCode,
        requestedAt,
        pending.callId
      );
      record.timeoutMs = timeoutMs;
      record.deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : null;
      return Promise.resolve({ value: null, record });
    }
    if (Number.isFinite(options.deadlineAt) && requestedAt >= options.deadlineAt) {
      const record = pendingRecord('pending-deadline', 'deadline-reached', requestedAt);
      record.timeoutMs = timeoutMs;
      record.deadlineAt = options.deadlineAt;
      return Promise.resolve({ value: null, record });
    }

    const deadlineRemainingMs = Number.isFinite(options.deadlineAt)
      ? Math.max(1, options.deadlineAt - requestedAt)
      : Number.POSITIVE_INFINITY;
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, deadlineRemainingMs));

    const callId = ++nextCallId;
    const record = {
      operation: name,
      callId,
      status: 'pending',
      reason: null,
      requestedAt,
      startedAt: requestedAt,
      settledAt: null,
      elapsedMs: 0,
      receivedAt: null,
      complete: false,
      slow: false,
      failed: false,
      timedOut: false,
      lateSettled: false,
      underlyingPending: true,
      pendingCallId: null,
      lateOutcome: null,
      taskTiming: null,
      error: null,
      timeoutMs,
      effectiveTimeoutMs,
      deadlineAt: Number.isFinite(options.deadlineAt) ? options.deadlineAt : null
    };
    remember(record);
    counts.started += 1;
    let resolveSettlement;
    const settlementPromise = new Promise((resolve) => {
      resolveSettlement = resolve;
    });
    const owner = {
      callId,
      startedAt: requestedAt,
      record,
      settlementPromise,
      resolveSettlement,
      settled: false
    };
    pending = owner;
    let timer = null;
    let resolveResult;
    let callerSettled = false;
    const resultPromise = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const settle = (outcome, value, error) => {
      const receivedAt = finiteTimingNumber(now());
      const elapsedMs = receivedAt === null || !Number.isFinite(owner.startedAt)
        ? null
        : Math.max(0, receivedAt - owner.startedAt);
      const taskTiming = outcome === 'fulfilled'
        ? normalizePageTaskTiming(value?.timing)
        : null;
      record.receivedAt = receivedAt;
      record.settledAt = receivedAt;
      record.elapsedMs = elapsedMs;
      record.taskTiming = taskTiming;
      record.underlyingPending = false;
      if (pending === owner) pending = null;
      if (timer !== null) clearTimeout(timer);
      owner.settled = true;
      resolveSettlement({ value: outcome === 'fulfilled' ? value : null, record });
      if (record.timedOut) {
        record.lateSettled = true;
        record.lateOutcome = outcome;
        if (outcome === 'failed') {
          counts.lateFailed += 1;
          record.failed = true;
          record.error = safeError(error);
        }
        counts.lateSettled += 1;
        return;
      }
      counts.completed += 1;
      if (outcome === 'failed') {
        counts.failed += 1;
        record.status = 'failed';
        record.failed = true;
        record.error = safeError(error);
        callerSettled = true;
        resolveResult({ value: null, record });
        return;
      }
      record.slow = elapsedMs >= slowMs;
      record.complete = true;
      record.status = record.slow ? 'slow' : 'completed';
      if (record.slow) counts.slow += 1;
      callerSettled = true;
      resolveResult({ value, record });
    };
    let taskPromise;
    try {
      taskPromise = Promise.resolve().then(task);
    } catch (error) {
      taskPromise = Promise.reject(error);
    }
    // Always attach both handlers.  A timed-out operation is deliberately
    // allowed to settle later, but must never become an unhandled rejection.
    taskPromise.then(
      (value) => settle('fulfilled', value, null),
      (error) => settle('failed', null, error)
    );
    timer = setTimeout(() => {
      if (callerSettled || record.timedOut) return;
      counts.timedOut += 1;
      record.status = 'timeout';
      record.reason = options.timeoutCode ?? 'SINGLE_FLIGHT_TIMEOUT';
      record.timedOut = true;
      record.complete = false;
      record.underlyingPending = true;
      callerSettled = true;
      resolveResult({ value: null, record });
    }, effectiveTimeoutMs);
    return resultPromise;
  };

  const waitForPending = async (timeoutMs = 5_000, deadlineAt = null) => {
    const owner = pending;
    if (!owner) return { settled: true, record: null };
    const requestedAt = now();
    const remainingMs = Number.isFinite(deadlineAt)
      ? deadlineAt - requestedAt
      : Number.POSITIVE_INFINITY;
    if (remainingMs <= 0) {
      return {
        settled: false,
        record: {
          ...owner.record,
          status: 'pending-deadline',
          reason: 'pending-settlement-deadline',
          pendingCallId: owner.callId,
          underlyingPending: true
        }
      };
    }
    const effectiveTimeoutMs = Math.max(1, Math.min(
      Number.isFinite(timeoutMs) ? timeoutMs : 5_000,
      remainingMs
    ));
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), effectiveTimeoutMs);
    });
    const outcome = await Promise.race([
      owner.settlementPromise.then(() => ({ settled: true, record: owner.record })),
      timeout
    ]);
    clearTimeout(timer);
    if (outcome.settled) return outcome;
    return {
      settled: false,
      record: {
        ...owner.record,
        status: 'pending-deadline',
        reason: 'pending-settlement-deadline',
        pendingCallId: owner.callId,
        underlyingPending: true
      }
    };
  };

  return {
    run,
    waitForPending,
    snapshot() {
      return {
        operation: name,
        counts: { ...counts },
        pending: pending
          ? { callId: pending.callId, startedAt: pending.startedAt, ageMs: Math.max(0, now() - pending.startedAt) }
          : null,
        records: records.map((record) => ({ ...record }))
      };
    }
  };
}

function createMapCrashEvidencePaths(reportRoot) {
  const root = resolve(reportRoot);
  return Object.freeze({
    crashDumps: join(root, 'crashes'),
    receipt: join(root, 'crash-reporter-receipt.json'),
    parentExit: join(root, 'electron-exit.json'),
    entryExit: join(root, 'electron-entry-exit.json')
  });
}

/**
 * Generate the private Electron entry used by the real MAP probe.
 *
 * Crashpad must be configured before production-main is imported.  The entry
 * deliberately does not call app.whenReady(): production-main owns that
 * lifecycle and must keep its normal startup ordering.  The generated file is
 * placed in this run's scratch directory, while the receipt, crash dumps, and
 * child-exit evidence are kept in reportDir so scratch cleanup cannot erase
 * diagnostics.
 */
function createOfflineCrashpadEntrySource({
  productionMain,
  artifactId,
  crashDumpsPath,
  receiptPath,
  entryExitInfoPath
}) {
  const config = {
    artifactId,
    crashDumpsPath,
    entryExitInfoPath,
    productionMainUrl: pathToFileURL(productionMain).href,
    receiptPath
  };
  return `import { app, crashReporter } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';

const config = ${JSON.stringify(config)};
const startedAtUTC = new Date().toISOString();
const receipt = {
  schemaVersion: 1,
  mode: 'offline-crashpad',
  startedAtUTC,
  pid: process.pid,
  artifactId: config.artifactId,
  crashDumpsPath: config.crashDumpsPath,
  crashDumpsConfigured: false,
  started: false,
  uploadToServer: false,
  compress: false,
  importProductionMain: config.productionMainUrl,
  error: null
};

function writeDiagnostic(operation, path, error) {
  try {
    process.stderr.write(\`[SF_MAP_OFFLINE_CRASHPAD] \${JSON.stringify({
      code: 'SF_MAP_OFFLINE_CRASHPAD_WRITE_ERROR',
      operation,
      path,
      error: error instanceof Error ? error.message : String(error),
      atUTC: new Date().toISOString(),
      pid: process.pid
    })}\\n\`);
  } catch {
    // Diagnostics must never change the Electron startup/exit path.
  }
}

function writeJson(path, value, operation) {
  try {
    writeFileSync(path, \`${'${JSON.stringify(value, null, 2)}'}\\n\`, 'utf8');
  } catch (error) {
    writeDiagnostic(operation, path, error);
  }
}

function writeExitInfo(exitCode) {
  writeJson(config.entryExitInfoPath, {
    schemaVersion: 1,
    source: 'electron-offline-crashpad-entry',
    atUTC: new Date().toISOString(),
    pid: process.pid,
    exitCode,
    signal: null,
    crashDumpsPath: config.crashDumpsPath,
    artifactId: config.artifactId,
    settled: true
  }, 'write-entry-exit');
}

mkdirSync(config.crashDumpsPath, { recursive: true });
process.once('exit', writeExitInfo);
try {
  app.setPath('crashDumps', config.crashDumpsPath);
  receipt.crashDumpsConfigured = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
}
try {
  crashReporter.start({
    productName: 'SoulForge-map-streaming-native',
    companyName: 'SoulForge-offline-diagnostic',
    uploadToServer: false,
    compress: false,
    ignoreSystemCrashHandler: false
  });
  receipt.started = true;
  receipt.uploadToServer = typeof crashReporter.getUploadToServer === 'function'
    ? crashReporter.getUploadToServer()
    : false;
} catch (error) {
  receipt.error = receipt.error ?? (error instanceof Error ? error.message : String(error));
}
writeJson(config.receiptPath, receipt, 'write-receipt');

try {
  await import(config.productionMainUrl);
} catch (error) {
  receipt.importError = error instanceof Error ? error.stack ?? error.message : String(error);
  writeJson(config.receiptPath, receipt, 'write-receipt-import-error');
  throw error;
}
`;
}

function runOfflineCrashpadEntryFixture() {
  const crashEvidencePaths = createMapCrashEvidencePaths('D:/report');
  const source = createOfflineCrashpadEntrySource({
    productionMain: 'D:/snapshot/apps/desktop/e2e/playwright/production-main.mjs',
    artifactId: 'fixture-artifact',
    crashDumpsPath: crashEvidencePaths.crashDumps,
    receiptPath: crashEvidencePaths.receipt,
    entryExitInfoPath: crashEvidencePaths.entryExit
  });
  const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: source,
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1 * 1024 * 1024,
    timeout: 10_000
  });
  const setPathAt = source.indexOf("app.setPath('crashDumps'");
  const startAt = source.indexOf('crashReporter.start(');
  const importAt = source.indexOf('await import(config.productionMainUrl)');
  const entryExitPath = crashEvidencePaths.entryExit;
  const parentExitPath = crashEvidencePaths.parentExit;
  const launchBeforeAppEvidence = new Map([
    [entryExitPath, { source: 'electron-offline-crashpad-entry', exitCode: 4294930435, settled: true }],
    [parentExitPath, { source: 'playwright-parent-finally', exitCode: null, settled: false }]
  ]);
  const launchBeforeAppIsolation = launchBeforeAppEvidence.get(entryExitPath)?.exitCode === 4294930435
    && launchBeforeAppEvidence.get(entryExitPath)?.settled === true
    && launchBeforeAppEvidence.get(parentExitPath)?.exitCode === null
    && launchBeforeAppEvidence.get(parentExitPath)?.settled === false
    && entryExitPath !== parentExitPath;
  const pass = setPathAt >= 0
    && startAt > setPathAt
    && importAt > startAt
    && source.includes('uploadToServer: false')
    && source.includes('compress: false')
    && !source.includes('app.whenReady')
    && source.includes('electron-offline-crashpad-entry')
    && source.includes('write-entry-exit')
    && source.includes('SF_MAP_OFFLINE_CRASHPAD_WRITE_ERROR')
    && source.includes('operation,')
    && source.includes('path,')
    && source.includes('error: error instanceof Error')
    && !syntax.error
    && syntax.status === 0
    && launchBeforeAppIsolation;
  return {
    ordering: {
      crashDumpsBeforeCrashReporter: setPathAt >= 0 && startAt > setPathAt,
      crashReporterBeforeProductionMain: startAt >= 0 && importAt > startAt
    },
    offline: source.includes('uploadToServer: false') && source.includes('compress: false'),
    noWhenReady: !source.includes('app.whenReady'),
    launchBeforeAppIsolation,
    generatedEntrySyntax: syntax.error?.message ?? syntax.stderr?.trim() ?? null,
    pass
  };
}

/**
 * Run one externally visible phase under both its local budget and the probe's
 * total deadline.  The progress entries are intentionally plain JSON so a
 * long real-resource run can be followed from stdout and the final report.
 */
async function runPhase(report, phase, requestedTimeoutMs, deadlineAt, startedAt, work) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(`MAP_PROBE_DEADLINE_EXCEEDED: ${phase}`);
  const timeoutMs = Math.min(requestedTimeoutMs, remainingMs);
  const phaseStartedAt = Date.now();
  report.progress ??= [];
  const progress = { phase, status: 'started', elapsedMs: phaseStartedAt - startedAt };
  report.progress.push(progress);
  console.log(JSON.stringify({ type: 'map-probe-progress', ...progress }));
  try {
    const result = await bounded(
      Promise.resolve().then(work),
      timeoutMs,
      timeoutMs < requestedTimeoutMs
        ? `MAP_PROBE_DEADLINE_EXCEEDED: ${phase}`
        : `MAP_PROBE_PHASE_TIMEOUT: ${phase}`
    );
    progress.status = 'completed';
    progress.elapsedMs = Date.now() - phaseStartedAt;
    console.log(JSON.stringify({
      type: 'map-probe-progress',
      phase,
      status: progress.status,
      elapsedMs: progress.elapsedMs,
      totalElapsedMs: Date.now() - startedAt
    }));
    return result;
  } catch (error) {
    progress.status = 'failed';
    progress.elapsedMs = Date.now() - phaseStartedAt;
    progress.error = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({
      type: 'map-probe-progress',
      phase,
      status: progress.status,
      elapsedMs: progress.elapsedMs,
      totalElapsedMs: Date.now() - startedAt,
      error: progress.error
    }));
    throw error;
  }
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function diagnosticsCodes(value) {
  return Array.isArray(value)
    ? value.map((item) => item && typeof item.code === 'string' ? item.code : null).filter(Boolean)
    : [];
}

const MAP_TELEMETRY_BOUNDARY_NAMES = Object.freeze(['total', 'mapCanvas', 'streamLoad']);
const MAP_WINDOW_OBSERVER_KEY = '__soulforgeMapForegroundObserverV1';
const MAP_WINDOW_OBSERVER_EVENT_LIMIT = 1_024;
const MAP_MAIN_TIMING_PHASE_KEY = '__soulforgeMapMainTimingV1';
const MAIN_MAP_TELEMETRY_MAX_LINE_CHARS = 512 * 1024;
const MAP_API_OBSERVER_MAX_DIAGNOSTICS = 16;
const MAP_API_OBSERVER_MAX_CODE_CHARS = 96;
const MAP_API_OBSERVER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,95}$/;

function stableMapApiObserverCode(value) {
  return typeof value === 'string' && MAP_API_OBSERVER_CODE_PATTERN.test(value) ? value : null;
}

function projectMapApiObserverResult(result) {
  const responseError = result?.error && typeof result.error === 'object' ? result.error : null;
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  const diagnosticCodes = [];
  for (const item of diagnostics.slice(0, MAP_API_OBSERVER_MAX_DIAGNOSTICS)) {
    const code = stableMapApiObserverCode(item?.code);
    if (code !== null) diagnosticCodes.push(code);
  }
  return {
    resultErrorCode: stableMapApiObserverCode(responseError?.code),
    diagnosticCodes
  };
}

function makeRafBoundary(name, startAt, startFrame) {
  return {
    name,
    startAt,
    endAt: null,
    startFrame,
    endFrame: null,
    frames: 0,
    firstFrameIndex: null,
    lastFrameIndex: null,
    startRafAt: null,
    endRafAt: null,
    lastRafAt: null,
    maxGapMs: 0,
    longGapCount: 0,
    visibleMaxGapMs: 0,
    hiddenMaxGapMs: 0,
    visibleLongGapCount: 0,
    hiddenLongGapCount: 0,
    trailingGapMs: 0,
    trailingGapVisibility: null,
    trailingLongGapCount: 0,
    longTaskCount: 0,
    maxLongTaskMs: 0,
    longTasks: []
  };
}

function snapshotRafBoundary(boundary, retainedSampleCount, sampleLimit, longTaskObserverAvailable = true) {
  const closed = boundary.endAt !== null;
  return {
    ...boundary,
    closed,
    sampleCoverageComplete: closed,
    retainedSampleCount,
    sampleLimit,
    sampleKind: 'boundary-cumulative',
    longTaskSamplesComplete: closed && longTaskObserverAvailable
  };
}

/**
 * RAF 计时器的状态机与页面实际 requestAnimationFrame 解耦，方便在探针内
 * 用 >ring-buffer 的确定性样本验证「保留窗口」不会改变最新帧基线。
 *
 * boundaries 是独立的累计窗口：它们只保存标量和有限的长任务尾部，不能
 * 被 2,000 帧调试 ring 覆盖。窗口的第一帧 gap 沿用真实 RAF 间隔（可能
 * 跨过窗口起点），因此 mapCanvas/streamLoad 的边界口径不会丢掉起始阻塞。
 */
function createRafAccounting(sampleLimit = 2_000) {
  const state = {
    frames: 0,
    maxGapMs: 0,
    longGapCount: 0,
    visibleMaxGapMs: 0,
    hiddenMaxGapMs: 0,
    visibleLongGapCount: 0,
    hiddenLongGapCount: 0,
    lastRafAt: null,
    lastVisibilityState: 'visible',
    samples: [],
    boundaries: new Map(),
    boundaryErrors: [],
    longTaskTotalCount: 0,
    maxLongTaskMs: 0,
    longTaskObserverAvailable: true
  };

  const validateBoundaryName = (name) => MAP_TELEMETRY_BOUNDARY_NAMES.includes(name);
  const beginBoundary = (name, at = state.lastRafAt ?? 0) => {
    if (!validateBoundaryName(name)) {
      state.boundaryErrors.push(`UNKNOWN_BOUNDARY:${String(name)}`);
      return false;
    }
    if (state.boundaries.has(name)) {
      state.boundaryErrors.push(`DUPLICATE_BOUNDARY:${name}`);
      return false;
    }
    const boundary = makeRafBoundary(name, at, state.frames);
    boundary.startRafAt = state.lastRafAt;
    state.boundaries.set(name, boundary);
    return true;
  };
  const endBoundary = (name, at = state.lastRafAt ?? 0) => {
    const boundary = state.boundaries.get(name);
    if (!boundary) {
      state.boundaryErrors.push(`BOUNDARY_NOT_STARTED:${name}`);
      return false;
    }
    if (boundary.endAt !== null) {
      state.boundaryErrors.push(`BOUNDARY_ALREADY_ENDED:${name}`);
      return false;
    }
    boundary.endAt = at;
    boundary.endFrame = state.frames;
    boundary.endRafAt = state.lastRafAt;
    // Closing can happen before the next RAF callback. Preserve the pending
    // tail as an observed boundary gap instead of silently turning it into
    // zero; no extra frame is fabricated.
    if (boundary.frames > 0 && Number.isFinite(boundary.lastRafAt) && at > boundary.lastRafAt) {
      const trailingGapMs = at - boundary.lastRafAt;
      const trailingVisibility = state.lastVisibilityState;
      boundary.trailingGapMs = trailingGapMs;
      boundary.trailingGapVisibility = trailingVisibility;
      boundary.maxGapMs = Math.max(boundary.maxGapMs, trailingGapMs);
      if (trailingVisibility === 'hidden') boundary.hiddenMaxGapMs = Math.max(boundary.hiddenMaxGapMs, trailingGapMs);
      else boundary.visibleMaxGapMs = Math.max(boundary.visibleMaxGapMs, trailingGapMs);
      if (trailingGapMs >= 50) {
        boundary.trailingLongGapCount += 1;
        boundary.longGapCount += 1;
        if (trailingVisibility === 'hidden') boundary.hiddenLongGapCount += 1;
        else boundary.visibleLongGapCount += 1;
      }
    }
    return true;
  };
  const recordBoundaryFrame = ({ frameIndex, at, gapMs, visibility }) => {
    for (const boundary of state.boundaries.values()) {
      if (boundary.endAt !== null || at < boundary.startAt) continue;
      boundary.frames += 1;
      boundary.firstFrameIndex ??= frameIndex;
      boundary.lastFrameIndex = frameIndex;
      boundary.lastRafAt = at;
      boundary.maxGapMs = Math.max(boundary.maxGapMs, gapMs);
      if (visibility === 'hidden') boundary.hiddenMaxGapMs = Math.max(boundary.hiddenMaxGapMs, gapMs);
      else boundary.visibleMaxGapMs = Math.max(boundary.visibleMaxGapMs, gapMs);
      if (gapMs >= 50) {
        boundary.longGapCount += 1;
        if (visibility === 'hidden') boundary.hiddenLongGapCount += 1;
        else boundary.visibleLongGapCount += 1;
      }
    }
  };
  const recordLongTask = (startTime, duration) => {
    const at = Number(startTime);
    const durationMs = Number(duration);
    if (!Number.isFinite(at) || !Number.isFinite(durationMs)) return;
    state.longTaskTotalCount += 1;
    state.maxLongTaskMs = Math.max(state.maxLongTaskMs, durationMs);
    for (const boundary of state.boundaries.values()) {
      if (at < boundary.startAt || (boundary.endAt !== null && at >= boundary.endAt)) continue;
      boundary.longTaskCount += 1;
      boundary.maxLongTaskMs = Math.max(boundary.maxLongTaskMs, durationMs);
      if (boundary.longTasks.length >= 500) boundary.longTasks.shift();
      boundary.longTasks.push({ startTime: at, duration: durationMs });
    }
  };

  const record = (now, visibilityState = 'visible') => {
    const visibility = visibilityState === 'hidden' ? 'hidden' : 'visible';
    const previous = state.lastRafAt;
    const gap = previous === null ? 0 : Math.max(0, now - previous);
    const gapVisibility = previous === null
      ? visibility
      : (state.lastVisibilityState === 'hidden' || visibility === 'hidden' ? 'hidden' : 'visible');
    state.frames += 1;
    // 关键修复：这个基准每一帧更新；ring buffer 只限制 retained samples。
    state.lastRafAt = now;
    state.lastVisibilityState = visibility;
    state.maxGapMs = Math.max(state.maxGapMs, gap);
    if (gapVisibility === 'hidden') state.hiddenMaxGapMs = Math.max(state.hiddenMaxGapMs, gap);
    else state.visibleMaxGapMs = Math.max(state.visibleMaxGapMs, gap);
    if (gap >= 50) {
      state.longGapCount += 1;
      if (gapVisibility === 'hidden') state.hiddenLongGapCount += 1;
      else state.visibleLongGapCount += 1;
    }
    recordBoundaryFrame({ frameIndex: state.frames, at: now, gapMs: gap, visibility: gapVisibility });
    if (state.samples.length >= sampleLimit) state.samples.shift();
    state.samples.push({ at: now, gapMs: gap, visibility: gapVisibility });
  };

  return {
    record,
    snapshot: () => ({
      frames: state.frames,
      maxGapMs: state.maxGapMs,
      longGapCount: state.longGapCount,
      visibleMaxGapMs: state.visibleMaxGapMs,
      hiddenMaxGapMs: state.hiddenMaxGapMs,
      visibleLongGapCount: state.visibleLongGapCount,
      hiddenLongGapCount: state.hiddenLongGapCount,
      lastRafAt: state.lastRafAt,
      lastVisibilityState: state.lastVisibilityState,
      sampleCount: state.samples.length,
      sampleLimit,
      recentGaps: state.samples.slice(-20),
      boundaries: Object.fromEntries([...state.boundaries.entries()].map(([name, boundary]) => [
        name,
        snapshotRafBoundary(boundary, state.samples.length, sampleLimit, state.longTaskObserverAvailable)
      ])),
      boundaryErrors: state.boundaryErrors.slice(),
      longTaskTotalCount: state.longTaskTotalCount,
      maxLongTaskMs: state.maxLongTaskMs,
      longTaskObserverAvailable: state.longTaskObserverAvailable
    }),
    beginBoundary,
    endBoundary,
    recordLongTask,
    setLongTaskObserverAvailable: (available) => {
      state.longTaskObserverAvailable = available === true;
    }
  };
}

function runRafAccountingFixture() {
  const requestedFrames = 2_105;
  const accounting = createRafAccounting(2_000);
  for (let index = 0; index < requestedFrames; index += 1) {
    accounting.record(index * 16, 'visible');
  }
  const result = accounting.snapshot();
  return {
    requestedFrames,
    ...result,
    pass: result.frames === requestedFrames
      && result.sampleCount === 2_000
      && result.maxGapMs === 16
      && result.visibleMaxGapMs === 16
      && result.lastRafAt === (requestedFrames - 1) * 16
  };
}

function runRafBoundaryFixture() {
  const accounting = createRafAccounting(2_000);
  accounting.beginBoundary('total', 0);
  accounting.record(0, 'visible');
  // The first RAF after a window starts retains the full gap from the prior
  // RAF. This models a mount/canvas stall that begins before the callback
  // boundary and must not disappear from the mapCanvas window.
  accounting.beginBoundary('mapCanvas', 8);
  accounting.record(120, 'visible');
  accounting.record(136, 'hidden');
  accounting.record(196, 'hidden');
  accounting.recordLongTask(100, 75);
  accounting.endBoundary('mapCanvas', 196);
  accounting.beginBoundary('streamLoad', 196);
  accounting.record(212, 'hidden');
  accounting.record(228, 'visible');

  const requestedFrames = 2_105;
  for (let index = 0; index < requestedFrames; index += 1) {
    const base = 244 + index * 16;
    // Keep the pause in the timeline so the next frame does not move
    // backwards. The middle frame is intentionally beyond the 2,000-sample
    // debug ring's eventual retained tail.
    const now = base + (index >= 1_000 ? 64 : 0);
    accounting.record(now, 'visible');
  }
  const lastStreamRafAt = 244 + (requestedFrames - 1) * 16 + 64;
  const streamEnd = lastStreamRafAt + 80;
  // Simulate PerformanceObserver delivery after streamLoad was closed. The
  // entry's startTime still belongs to the closed window and must be retained.
  accounting.endBoundary('streamLoad', streamEnd);
  accounting.recordLongTask(streamEnd - 20, 66);
  accounting.endBoundary('total', streamEnd);
  const result = accounting.snapshot();
  const canvas = result.boundaries.mapCanvas;
  const stream = result.boundaries.streamLoad;
  const total = result.boundaries.total;
  return {
    requestedFrames,
    retainedSamples: result.sampleCount,
    canvas: {
      frames: canvas?.frames ?? null,
      maxGapMs: canvas?.maxGapMs ?? null,
      visibleLongGapCount: canvas?.visibleLongGapCount ?? null,
      hiddenLongGapCount: canvas?.hiddenLongGapCount ?? null,
      longTaskCount: canvas?.longTaskCount ?? null
    },
    stream: {
      frames: stream?.frames ?? null,
      maxGapMs: stream?.maxGapMs ?? null,
      longGapCount: stream?.longGapCount ?? null,
      longTaskCount: stream?.longTaskCount ?? null,
      trailingGapMs: stream?.trailingGapMs ?? null,
      trailingLongGapCount: stream?.trailingLongGapCount ?? null,
      sampleCoverageComplete: stream?.sampleCoverageComplete ?? false,
      longTaskSamplesComplete: stream?.longTaskSamplesComplete ?? false
    },
    total: {
      frames: total?.frames ?? null,
      maxGapMs: total?.maxGapMs ?? null,
      visibleLongGapCount: total?.visibleLongGapCount ?? null,
      hiddenLongGapCount: total?.hiddenLongGapCount ?? null,
      longTaskCount: total?.longTaskCount ?? null
    },
    pass: result.sampleCount === 2_000
      && canvas?.maxGapMs === 120
      && canvas?.frames === 3
      && canvas?.visibleLongGapCount === 1
      && canvas?.hiddenLongGapCount === 1
      && canvas?.longTaskCount === 1
      && stream?.frames === requestedFrames + 2
      && stream?.maxGapMs === 80
      && stream?.longGapCount === 2
      && stream?.trailingGapMs === 80
      && stream?.trailingLongGapCount === 1
      && stream?.longTaskCount === 1
      && stream?.sampleCoverageComplete === true
      && stream?.longTaskSamplesComplete === true
      && total?.maxGapMs === 120
      && total?.longTaskCount === 2
      && result.boundaryErrors.length === 0
  };
}

/**
 * Installed after preload is ready and before opening the MAP resource.  The
 * canvas/context hooks therefore observe the real renderer without changing
 * the production renderer source or choosing a different backend.
 */
function installMapTelemetry() {
  if (globalThis.__sfMapTelemetry?.installed) return globalThis.__sfMapTelemetry.snapshot();

  const telemetry = {
    installed: true,
    installedAt: performance.now(),
    contexts: [],
    webgl: {
      drawCalls: 0,
      instancedDrawCalls: 0,
      methods: Object.create(null),
      hookStatus: 'pending'
    },
    webgpu: {
      drawCalls: 0,
      instancedDrawCalls: 0,
      renderPasses: 0,
      hookStatus: 'pending'
    },
    raf: null,
    visibility: {
      currentState: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
      changes: []
    },
    longTasks: [],
    longTaskTotalCount: 0,
    maxObservedLongTaskMs: 0,
    longTaskObserverAvailable: false,
    longTaskObserverError: null,
    errors: []
  };
  // Keep this implementation local to page.evaluate: Playwright serializes the
  // function body, so it cannot close over Node-side helpers.
  const makeRafBoundary = (name, startAt, startFrame) => ({
    name,
    startAt,
    endAt: null,
    startFrame,
    endFrame: null,
    frames: 0,
    firstFrameIndex: null,
    lastFrameIndex: null,
    startRafAt: null,
    endRafAt: null,
    lastRafAt: null,
    maxGapMs: 0,
    longGapCount: 0,
    visibleMaxGapMs: 0,
    hiddenMaxGapMs: 0,
    visibleLongGapCount: 0,
    hiddenLongGapCount: 0,
    trailingGapMs: 0,
    trailingGapVisibility: null,
    trailingLongGapCount: 0,
    longTaskCount: 0,
    maxLongTaskMs: 0,
    longTasks: []
  });
  const snapshotRafBoundary = (boundary, retainedSampleCount, sampleLimit, observerAvailable) => ({
    ...boundary,
    closed: boundary.endAt !== null,
    sampleCoverageComplete: boundary.endAt !== null,
    retainedSampleCount,
    sampleLimit,
    sampleKind: 'boundary-cumulative',
    longTaskSamplesComplete: boundary.endAt !== null && observerAvailable
  });
  const makeRafAccounting = (sampleLimit = 2_000) => {
    const state = {
      frames: 0,
      maxGapMs: 0,
      longGapCount: 0,
      visibleMaxGapMs: 0,
      hiddenMaxGapMs: 0,
      visibleLongGapCount: 0,
      hiddenLongGapCount: 0,
      lastRafAt: null,
      lastVisibilityState: 'visible',
      samples: [],
      boundaries: new Map(),
      boundaryErrors: [],
      longTaskTotalCount: 0,
      maxLongTaskMs: 0,
      longTaskObserverAvailable: false
    };
    const validateBoundaryName = (name) => ['total', 'mapCanvas', 'streamLoad'].includes(name);
    const beginBoundary = (name, at = state.lastRafAt ?? 0) => {
      if (!validateBoundaryName(name)) {
        state.boundaryErrors.push(`UNKNOWN_BOUNDARY:${String(name)}`);
        return false;
      }
      if (state.boundaries.has(name)) {
        state.boundaryErrors.push(`DUPLICATE_BOUNDARY:${name}`);
        return false;
      }
      const boundary = makeRafBoundary(name, Number(at), state.frames);
      boundary.startRafAt = state.lastRafAt;
      state.boundaries.set(name, boundary);
      return true;
    };
    const endBoundary = (name, at = state.lastRafAt ?? 0) => {
      const boundary = state.boundaries.get(name);
      if (!boundary) {
        state.boundaryErrors.push(`BOUNDARY_NOT_STARTED:${name}`);
        return false;
      }
      if (boundary.endAt !== null) {
        state.boundaryErrors.push(`BOUNDARY_ALREADY_ENDED:${name}`);
        return false;
      }
      boundary.endAt = Number(at);
      boundary.endFrame = state.frames;
      boundary.endRafAt = state.lastRafAt;
      // A window may close before the next RAF callback. Count the observed
      // tail as a gap without inventing a frame, so a stalled tail is never
      // reported as zero merely because the boundary closed first.
      if (boundary.frames > 0 && Number.isFinite(boundary.lastRafAt) && boundary.endAt > boundary.lastRafAt) {
        const trailingGapMs = boundary.endAt - boundary.lastRafAt;
        const trailingVisibility = state.lastVisibilityState;
        boundary.trailingGapMs = trailingGapMs;
        boundary.trailingGapVisibility = trailingVisibility;
        boundary.maxGapMs = Math.max(boundary.maxGapMs, trailingGapMs);
        if (trailingVisibility === 'hidden') boundary.hiddenMaxGapMs = Math.max(boundary.hiddenMaxGapMs, trailingGapMs);
        else boundary.visibleMaxGapMs = Math.max(boundary.visibleMaxGapMs, trailingGapMs);
        if (trailingGapMs >= 50) {
          boundary.trailingLongGapCount += 1;
          boundary.longGapCount += 1;
          if (trailingVisibility === 'hidden') boundary.hiddenLongGapCount += 1;
          else boundary.visibleLongGapCount += 1;
        }
      }
      return true;
    };
    const closeOpenBoundaries = (at = performance.now()) => {
      const closed = [];
      for (const [name, boundary] of state.boundaries.entries()) {
        if (boundary.endAt === null && endBoundary(name, at)) closed.push(name);
      }
      return { at, closed };
    };
    const recordBoundaryFrame = ({ frameIndex, at, gapMs, visibility }) => {
      for (const boundary of state.boundaries.values()) {
        if (boundary.endAt !== null || at < boundary.startAt) continue;
        boundary.frames += 1;
        boundary.firstFrameIndex ??= frameIndex;
        boundary.lastFrameIndex = frameIndex;
        boundary.lastRafAt = at;
        boundary.maxGapMs = Math.max(boundary.maxGapMs, gapMs);
        if (visibility === 'hidden') boundary.hiddenMaxGapMs = Math.max(boundary.hiddenMaxGapMs, gapMs);
        else boundary.visibleMaxGapMs = Math.max(boundary.visibleMaxGapMs, gapMs);
        if (gapMs >= 50) {
          boundary.longGapCount += 1;
          if (visibility === 'hidden') boundary.hiddenLongGapCount += 1;
          else boundary.visibleLongGapCount += 1;
        }
      }
    };
    const recordLongTask = (startTime, duration) => {
      const at = Number(startTime);
      const durationMs = Number(duration);
      if (!Number.isFinite(at) || !Number.isFinite(durationMs)) return;
      state.longTaskTotalCount += 1;
      state.maxLongTaskMs = Math.max(state.maxLongTaskMs, durationMs);
      for (const boundary of state.boundaries.values()) {
        // PerformanceObserver delivery can be delayed until after a boundary
        // closes; classify by entry.startTime, never delivery time.
        if (at < boundary.startAt || (boundary.endAt !== null && at >= boundary.endAt)) continue;
        boundary.longTaskCount += 1;
        boundary.maxLongTaskMs = Math.max(boundary.maxLongTaskMs, durationMs);
        if (boundary.longTasks.length >= 500) boundary.longTasks.shift();
        boundary.longTasks.push({ startTime: at, duration: durationMs });
      }
    };
    const record = (now, visibilityState = 'visible') => {
      const visibility = visibilityState === 'hidden' ? 'hidden' : 'visible';
      const previous = state.lastRafAt;
      const gap = previous === null ? 0 : Math.max(0, now - previous);
      const gapVisibility = previous === null
        ? visibility
        : (state.lastVisibilityState === 'hidden' || visibility === 'hidden' ? 'hidden' : 'visible');
      state.frames += 1;
      state.lastRafAt = now;
      state.lastVisibilityState = visibility;
      state.maxGapMs = Math.max(state.maxGapMs, gap);
      if (gapVisibility === 'hidden') state.hiddenMaxGapMs = Math.max(state.hiddenMaxGapMs, gap);
      else state.visibleMaxGapMs = Math.max(state.visibleMaxGapMs, gap);
      if (gap >= 50) {
        state.longGapCount += 1;
        if (gapVisibility === 'hidden') state.hiddenLongGapCount += 1;
        else state.visibleLongGapCount += 1;
      }
      recordBoundaryFrame({ frameIndex: state.frames, at: now, gapMs: gap, visibility: gapVisibility });
      if (state.samples.length >= sampleLimit) state.samples.shift();
      state.samples.push({ frameIndex: state.frames, at: now, gapMs: gap, visibility: gapVisibility });
    };
    return {
      record,
      snapshot: (options = {}) => ({
        frames: state.frames,
        maxGapMs: state.maxGapMs,
        longGapCount: state.longGapCount,
        visibleMaxGapMs: state.visibleMaxGapMs,
        hiddenMaxGapMs: state.hiddenMaxGapMs,
        visibleLongGapCount: state.visibleLongGapCount,
        hiddenLongGapCount: state.hiddenLongGapCount,
        lastRafAt: state.lastRafAt,
        lastVisibilityState: state.lastVisibilityState,
        sampleCount: state.samples.length,
        sampleLimit,
        recentGaps: state.samples.slice(-20),
        ...(options.includeSamples ? { samples: state.samples.slice() } : {}),
        boundaries: Object.fromEntries([...state.boundaries.entries()].map(([name, boundary]) => [
          name,
          snapshotRafBoundary(boundary, state.samples.length, sampleLimit, state.longTaskObserverAvailable)
        ])),
        boundaryErrors: state.boundaryErrors.slice(),
        longTaskTotalCount: state.longTaskTotalCount,
        maxLongTaskMs: state.maxLongTaskMs,
        longTaskObserverAvailable: state.longTaskObserverAvailable
      }),
      beginBoundary,
      endBoundary,
      closeOpenBoundaries,
      recordLongTask,
      setLongTaskObserverAvailable: (available) => {
        state.longTaskObserverAvailable = available === true;
      }
    };
  };
  const rafAccounting = makeRafAccounting();
  const fixtureAccounting = makeRafAccounting();
  fixtureAccounting.setLongTaskObserverAvailable(true);
  const fixtureRequestedFrames = 2_105;
  fixtureAccounting.beginBoundary('total', 0);
  fixtureAccounting.record(0, 'visible');
  fixtureAccounting.beginBoundary('mapCanvas', 8);
  fixtureAccounting.record(120, 'visible');
  fixtureAccounting.record(136, 'hidden');
  fixtureAccounting.record(196, 'hidden');
  fixtureAccounting.recordLongTask(100, 75);
  fixtureAccounting.endBoundary('mapCanvas', 196);
  fixtureAccounting.beginBoundary('streamLoad', 196);
  fixtureAccounting.record(212, 'hidden');
  fixtureAccounting.record(228, 'visible');
  for (let index = 0; index < fixtureRequestedFrames; index += 1) {
    const base = 244 + index * 16;
    fixtureAccounting.record(base + (index >= 1_000 ? 64 : 0), 'visible');
  }
  const fixtureLastStreamRafAt = 244 + (fixtureRequestedFrames - 1) * 16 + 64;
  const fixtureStreamEnd = fixtureLastStreamRafAt + 80;
  fixtureAccounting.endBoundary('streamLoad', fixtureStreamEnd);
  fixtureAccounting.recordLongTask(fixtureStreamEnd - 20, 66);
  fixtureAccounting.endBoundary('total', fixtureStreamEnd);
  const fixtureSnapshot = fixtureAccounting.snapshot();
  const fixtureCanvas = fixtureSnapshot.boundaries.mapCanvas;
  const fixtureStream = fixtureSnapshot.boundaries.streamLoad;
  telemetry.rafAccountingFixture = {
    requestedFrames: fixtureRequestedFrames,
    ...fixtureSnapshot,
    pass: fixtureSnapshot.sampleCount === 2_000
      && fixtureCanvas?.frames === 3
      && fixtureCanvas?.maxGapMs === 120
      && fixtureCanvas?.visibleLongGapCount === 1
      && fixtureCanvas?.hiddenLongGapCount === 1
      && fixtureCanvas?.longTaskCount === 1
      && fixtureStream?.frames === fixtureRequestedFrames + 2
      && fixtureStream?.maxGapMs === 80
      && fixtureStream?.longGapCount === 2
      && fixtureStream?.trailingGapMs === 80
      && fixtureStream?.trailingLongGapCount === 1
      && fixtureStream?.longTaskCount === 1
      && fixtureStream?.sampleCoverageComplete === true
      && fixtureStream?.longTaskSamplesComplete === true
      && fixtureSnapshot.boundaries.total?.longTaskCount === 2
      && fixtureSnapshot.boundaryErrors.length === 0
  };
  const wrappedGlPrototypes = new WeakSet();
  const wrappedGpuDevices = new WeakSet();
  const wrappedGpuPasses = new WeakSet();

  const recordDraw = (method, instanced) => {
    telemetry.webgl.drawCalls += 1;
    if (instanced) telemetry.webgl.instancedDrawCalls += 1;
    telemetry.webgl.methods[method] = (telemetry.webgl.methods[method] ?? 0) + 1;
  };

  const wrapWebGl = (context, type) => {
    const prototype = Object.getPrototypeOf(context);
    if (!prototype || wrappedGlPrototypes.has(prototype)) return;
    wrappedGlPrototypes.add(prototype);
    const methods = [
      ['drawArrays', false],
      ['drawElements', false],
      ['drawArraysInstanced', true],
      ['drawElementsInstanced', true],
      ['drawRangeElements', false],
      ['drawArraysInstancedANGLE', true],
      ['drawElementsInstancedANGLE', true],
      ['multiDrawArraysWEBGL', true],
      ['multiDrawElementsWEBGL', true]
    ];
    let wrapped = 0;
    for (const [method, instanced] of methods) {
      const original = prototype[method];
      if (typeof original !== 'function') continue;
      const wrapper = function (...args) {
        recordDraw(method, instanced);
        return original.apply(this, args);
      };
      try {
        prototype[method] = wrapper;
        wrapped += 1;
      } catch {
        try {
          Object.defineProperty(prototype, method, { configurable: true, writable: true, value: wrapper });
          wrapped += 1;
        } catch {
          // A browser-owned method can be non-configurable; leave it unhooked.
        }
      }
    }
    telemetry.webgl.hookStatus = wrapped > 0 ? 'installed' : 'unavailable';
    telemetry.contexts.push({ type, backend: 'webgl', methodsWrapped: wrapped });
  };

  const wrapGpuPass = (pass) => {
    if (!pass || wrappedGpuPasses.has(pass)) return;
    wrappedGpuPasses.add(pass);
    telemetry.webgpu.renderPasses += 1;
    let wrapped = 0;
    for (const method of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
      const original = pass[method];
      if (typeof original !== 'function') continue;
      const wrapper = function (...args) {
        telemetry.webgpu.drawCalls += 1;
        if (method.includes('Indexed')) telemetry.webgpu.instancedDrawCalls += 1;
        return original.apply(this, args);
      };
      try {
        pass[method] = wrapper;
        wrapped += 1;
      } catch {
        try {
          Object.defineProperty(pass, method, { configurable: true, writable: true, value: wrapper });
          wrapped += 1;
        } catch {
          // Some Chromium GPU objects expose read-only methods.
        }
      }
    }
    if (wrapped > 0) telemetry.webgpu.hookStatus = 'installed';
  };

  const wrapGpuDevice = (device) => {
    if (!device || wrappedGpuDevices.has(device)) return;
    wrappedGpuDevices.add(device);
    const original = device.createCommandEncoder;
    if (typeof original !== 'function') {
      telemetry.webgpu.hookStatus = 'unavailable';
      return;
    }
    const wrapper = function (...args) {
      const encoder = original.apply(this, args);
      if (!encoder || typeof encoder.beginRenderPass !== 'function') return encoder;
      const begin = encoder.beginRenderPass;
      const beginWrapper = function (...beginArgs) {
        const pass = begin.apply(this, beginArgs);
        wrapGpuPass(pass);
        return pass;
      };
      try {
        encoder.beginRenderPass = beginWrapper;
      } catch {
        try { Object.defineProperty(encoder, 'beginRenderPass', { configurable: true, writable: true, value: beginWrapper }); } catch {}
      }
      return encoder;
    };
    try {
      device.createCommandEncoder = wrapper;
      telemetry.webgpu.hookStatus = 'installed';
    } catch {
      try {
        Object.defineProperty(device, 'createCommandEncoder', { configurable: true, writable: true, value: wrapper });
        telemetry.webgpu.hookStatus = 'installed';
      } catch {
        telemetry.webgpu.hookStatus = 'unavailable';
      }
    }
  };

  const gpu = navigator.gpu;
  if (gpu && typeof gpu.requestAdapter === 'function') {
    const requestAdapter = gpu.requestAdapter.bind(gpu);
    try {
      gpu.requestAdapter = async (...args) => {
        const adapter = await requestAdapter(...args);
        if (!adapter || typeof adapter.requestDevice !== 'function') return adapter;
        const requestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (...deviceArgs) => {
          const device = await requestDevice(...deviceArgs);
          wrapGpuDevice(device);
          return device;
        };
        return adapter;
      };
      telemetry.webgpu.hookStatus = 'armed';
    } catch {
      telemetry.webgpu.hookStatus = 'unavailable';
    }
  } else {
    telemetry.webgpu.hookStatus = 'not-available';
  }

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const context = originalGetContext.apply(this, args);
    const type = String(args[0] ?? '').toLowerCase();
    if (context && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      wrapWebGl(context, type);
    } else if (context && type === 'webgpu') {
      telemetry.contexts.push({ type, backend: 'webgpu' });
    }
    return context;
  };

  const recordVisibility = () => {
    const currentState = document.visibilityState === 'hidden' ? 'hidden' : 'visible';
    telemetry.visibility.currentState = currentState;
    if (telemetry.visibility.changes.length < 100) {
      telemetry.visibility.changes.push({ at: performance.now(), state: currentState });
    }
  };
  document.addEventListener('visibilitychange', recordVisibility);
  recordVisibility();

  const rafTick = (now) => {
    rafAccounting.record(now, telemetry.visibility.currentState);
    requestAnimationFrame(rafTick);
  };
  requestAnimationFrame(rafTick);

  let longTaskObserver = null;
  const consumeLongTaskEntries = (entries) => {
    for (const entry of entries) {
      telemetry.longTaskTotalCount += 1;
      telemetry.maxObservedLongTaskMs = Math.max(telemetry.maxObservedLongTaskMs, entry.duration);
      if (telemetry.longTasks.length >= 500) telemetry.longTasks.shift();
      telemetry.longTasks.push({
        sequence: telemetry.longTaskTotalCount,
        startTime: entry.startTime,
        duration: entry.duration
      });
      // Keep boundary accounting independent from the global 500-entry debug
      // ring. PerformanceObserver may deliver this entry after a window has
      // closed; recordLongTask uses entry.startTime for ownership.
      rafAccounting.recordLongTask(entry.startTime, entry.duration);
    }
  };
  const flushLongTaskRecords = () => {
    if (!longTaskObserver || typeof longTaskObserver.takeRecords !== 'function') return;
    consumeLongTaskEntries(longTaskObserver.takeRecords());
  };
  if (typeof PerformanceObserver === 'function') {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        consumeLongTaskEntries(list.getEntries());
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
      telemetry.longTaskObserverAvailable = true;
      rafAccounting.setLongTaskObserverAvailable(true);
    } catch (error) {
      telemetry.longTaskObserverError = error instanceof Error ? error.message : String(error);
      telemetry.errors.push('LONGTASK_OBSERVER_UNAVAILABLE');
    }
  } else {
    telemetry.longTaskObserverError = 'PERFORMANCE_OBSERVER_UNAVAILABLE';
    telemetry.errors.push('LONGTASK_OBSERVER_UNAVAILABLE');
  }

  telemetry.beginBoundary = (name, at = performance.now()) => rafAccounting.beginBoundary(name, at);
  telemetry.endBoundary = (name, at = performance.now()) => rafAccounting.endBoundary(name, at);
  telemetry.transitionBoundaries = ({ end = [], begin = [] } = {}) => {
    const at = performance.now();
    const ended = end.map((name) => ({ name, ok: rafAccounting.endBoundary(name, at) }));
    const started = begin.map((name) => ({ name, ok: rafAccounting.beginBoundary(name, at) }));
    return { at, ended, started };
  };
  telemetry.closeOpenBoundaries = (at = performance.now()) => rafAccounting.closeOpenBoundaries(at);
  telemetry.snapshot = (options = {}) => {
    flushLongTaskRecords();
    const snapshot = {
      installed: telemetry.installed,
      contexts: telemetry.contexts.slice(-20),
      webgl: { ...telemetry.webgl, methods: { ...telemetry.webgl.methods } },
      webgpu: { ...telemetry.webgpu },
      raf: rafAccounting.snapshot(options),
      rafAccountingFixture: telemetry.rafAccountingFixture,
      visibility: {
        currentState: telemetry.visibility.currentState,
        changes: telemetry.visibility.changes.slice(-20)
      },
      longTaskCount: telemetry.longTasks.length,
      longTaskTotalCount: telemetry.longTaskTotalCount,
      maxLongTaskMs: telemetry.maxObservedLongTaskMs,
      longTaskObserverAvailable: telemetry.longTaskObserverAvailable,
      longTaskObserverError: telemetry.longTaskObserverError,
      errors: telemetry.errors.slice()
    };
    if (options.includeLongTasks) snapshot.longTasks = telemetry.longTasks.slice();
    return snapshot;
  };
  globalThis.__sfMapTelemetry = telemetry;
  return telemetry.snapshot();
}

async function openResource(page, query) {
  const close = page.getByRole('button', { name: '关闭 Agent 面板' });
  if (await close.isVisible().catch(() => false)) await close.click();
  await page.keyboard.press('Control+k');
  const input = page.locator('.cmdk__input-wrap input');
  await input.fill(query);
  await page.locator('.cmdk-item').filter({ hasText: query }).first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.keyboard.press('Enter');
}

async function snapshotTelemetry(page, options = {}) {
  return page.evaluate((snapshotOptions) => globalThis.__sfMapTelemetry?.snapshot?.(snapshotOptions) ?? null, options).catch(() => null);
}

async function snapshotTelemetryWithProgress(page, options = {}) {
  return page.evaluate((snapshotOptions) => {
    const pageStartedAtUTC = Date.now();
    const pageStartedAt = performance.now();
    const telemetry = globalThis.__sfMapTelemetry?.snapshot?.(snapshotOptions) ?? null;
    const progressElement = document.querySelector('progress[aria-label="地图模型加载进度"]');
    const progress = progressElement?.getAttribute('value') ?? null;
    const max = progressElement?.getAttribute('max') ?? null;
    const pageCompletedAt = performance.now();
    const pageCompletedAtUTC = Date.now();
    return {
      telemetry,
      progress: progress === null ? null : Number(progress),
      max: max === null ? null : Number(max),
      timing: {
        pageStartedAtUTC,
        pageCompletedAtUTC,
        pageStartedAt,
        pageCompletedAt,
        pageDurationMs: pageCompletedAt - pageStartedAt
      }
    };
  }, options);
}

async function transitionMapTelemetryBoundaries(page, transition) {
  return page.evaluate((next) => {
    const telemetry = globalThis.__sfMapTelemetry;
    if (!telemetry?.transitionBoundaries) {
      return { ok: false, reason: 'MAP_TELEMETRY_BOUNDARY_API_MISSING' };
    }
    const result = telemetry.transitionBoundaries(next);
    const operations = [...(result.ended ?? []), ...(result.started ?? [])];
    return {
      ...result,
      ok: operations.every((operation) => operation.ok === true)
    };
  }, transition);
}

async function closeOpenMapTelemetryBoundaries(page) {
  return page.evaluate(() => {
    const telemetry = globalThis.__sfMapTelemetry;
    if (!telemetry?.closeOpenBoundaries) {
      return { ok: false, reason: 'MAP_TELEMETRY_BOUNDARY_API_MISSING' };
    }
    const result = telemetry.closeOpenBoundaries();
    return { ...result, ok: true };
  });
}

/**
 * Compare two renderer snapshots at explicit MAP phase boundaries. Startup
 * work before the map-open operation may have its own long task, so the
 * responsiveness decision must use counters/events observed after the
 * boundary rather than the renderer's lifetime maximum alone.
 */
function diffMapTelemetry(start, end, boundaryName = null) {
  const explicitBoundary = boundaryName
    ? end?.raf?.boundaries?.[boundaryName] ?? end?.boundaries?.[boundaryName] ?? null
    : null;
  if (explicitBoundary?.closed === true) {
    const longTasks = Array.isArray(explicitBoundary.longTasks) ? explicitBoundary.longTasks : [];
    const longTaskSamplesComplete = explicitBoundary.longTaskSamplesComplete === true;
    return {
      available: true,
      source: 'boundary-cumulative',
      boundaryName,
      closed: explicitBoundary.closed === true,
      startAt: explicitBoundary.startAt ?? null,
      endAt: explicitBoundary.endAt ?? null,
      boundaryErrors: Array.isArray(end?.raf?.boundaryErrors)
        ? end.raf.boundaryErrors.slice()
        : Array.isArray(end?.boundaryErrors)
          ? end.boundaryErrors.slice()
          : [],
      startFrames: Number(explicitBoundary.startFrame) || 0,
      endFrames: Number(explicitBoundary.endFrame) || 0,
      longTaskCount: Number(explicitBoundary.longTaskCount) || 0,
      maxLongTaskMs: Number(explicitBoundary.maxLongTaskMs) || 0,
      maxLongTaskMsKnown: longTaskSamplesComplete,
      longTasks: longTasks.slice(-100),
      raf: {
        frames: Number(explicitBoundary.frames) || 0,
        maxGapMs: Number(explicitBoundary.maxGapMs) || 0,
        maxGapMsKnown: explicitBoundary.sampleCoverageComplete === true,
        longGapCount: Number(explicitBoundary.longGapCount) || 0,
        visibleLongGapCount: Number(explicitBoundary.visibleLongGapCount) || 0,
        hiddenLongGapCount: Number(explicitBoundary.hiddenLongGapCount) || 0,
        visibleMaxGapMs: Number(explicitBoundary.visibleMaxGapMs) || 0,
        hiddenMaxGapMs: Number(explicitBoundary.hiddenMaxGapMs) || 0,
        trailingGapMs: Number(explicitBoundary.trailingGapMs) || 0,
        trailingGapVisibility: explicitBoundary.trailingGapVisibility ?? null,
        trailingLongGapCount: Number(explicitBoundary.trailingLongGapCount) || 0,
        lastRafAt: Number.isFinite(explicitBoundary.lastRafAt) ? explicitBoundary.lastRafAt : null,
        sampleCount: Number(explicitBoundary.retainedSampleCount) || 0,
        sampleLimit: Number(explicitBoundary.sampleLimit) || 2_000,
        sampleCoverageComplete: explicitBoundary.sampleCoverageComplete === true
      },
      longTaskSampleCount: Number(explicitBoundary.longTaskCount) || 0,
      longTaskSampleLimit: 500,
      longTaskSamplesComplete
    };
  }
  if (!start || !end) return { available: false, reason: 'BOUNDARY_SNAPSHOT_UNAVAILABLE' };
  const startRaf = start.raf ?? {};
  const endRaf = end.raf ?? {};
  const startFrames = Number.isFinite(startRaf.frames) ? startRaf.frames : 0;
  const endFrames = Number.isFinite(endRaf.frames) ? endRaf.frames : startFrames;
  const frameDelta = Math.max(0, endFrames - startFrames);
  const endSamples = Array.isArray(endRaf.samples) ? endRaf.samples : [];
  const intervalSamples = endSamples.filter((sample) => Number(sample?.frameIndex) > startFrames);
  const frameSampleCoverageComplete = frameDelta === 0
    || (intervalSamples.length >= frameDelta && Number(intervalSamples[0]?.frameIndex) === startFrames + 1);
  const maxGapMs = intervalSamples.reduce((max, sample) => Math.max(max, Number(sample?.gapMs) || 0), 0);
  const startLongTaskTotal = Number.isFinite(start.longTaskTotalCount)
    ? start.longTaskTotalCount
    : Number(start.longTaskCount) || 0;
  const endLongTaskTotal = Number.isFinite(end.longTaskTotalCount)
    ? end.longTaskTotalCount
    : Number(end.longTaskCount) || startLongTaskTotal;
  const longTaskDelta = Math.max(0, endLongTaskTotal - startLongTaskTotal);
  const endLongTasks = Array.isArray(end.longTasks) ? end.longTasks : [];
  const intervalLongTasks = endLongTasks.filter((entry) => Number(entry?.sequence) > startLongTaskTotal);
  const longTaskSamplesComplete = longTaskDelta === 0 || intervalLongTasks.length >= longTaskDelta;
  const maxLongTaskMs = intervalLongTasks.reduce((max, entry) => Math.max(max, Number(entry?.duration) || 0), 0);
  const subtract = (key) => Math.max(0, (Number(endRaf[key]) || 0) - (Number(startRaf[key]) || 0));
  return {
    available: true,
    startFrames,
    endFrames,
    longTaskCount: longTaskDelta,
    maxLongTaskMs,
    maxLongTaskMsKnown: longTaskSamplesComplete,
    longTasks: intervalLongTasks.slice(-100),
    raf: {
      frames: frameDelta,
      maxGapMs,
      maxGapMsKnown: frameSampleCoverageComplete,
      longGapCount: subtract('longGapCount'),
      visibleLongGapCount: subtract('visibleLongGapCount'),
      hiddenLongGapCount: subtract('hiddenLongGapCount'),
      visibleMaxGapMs: maxGapMs,
      hiddenMaxGapMs: intervalSamples
        .filter((sample) => sample?.visibility === 'hidden')
        .reduce((max, sample) => Math.max(max, Number(sample?.gapMs) || 0), 0),
      lastRafAt: Number.isFinite(endRaf.lastRafAt) ? endRaf.lastRafAt : null,
      sampleCount: intervalSamples.length,
      sampleLimit: endRaf.sampleLimit ?? null,
      sampleCoverageComplete: frameSampleCoverageComplete
    },
    longTaskSampleCount: intervalLongTasks.length,
    longTaskSampleLimit: 500,
    longTaskSamplesComplete
  };
}

/**
 * 只读包装 preload 暴露的 geometry API，记录每次 renderer -> IPC/native
 * 调用的墙钟时间。这个包装不改变参数、返回值或调用顺序；如果
 * contextBridge 将方法设为不可写，则报告 unavailable，而不是猜测 native
 * 等待时间。调用记录只保留有限的尾部样本，汇总保留全部计时所需的标量。
 */
async function installMapApiTimingTelemetry(page) {
  return page.evaluate(() => {
    const existing = globalThis.__sfMapApiTiming;
    if (existing?.installed) return existing.snapshot();
    const api = globalThis.soulforge;
    const original = api?.readMapStaticGeometry;
    if (typeof original !== 'function') {
      const unavailable = {
        installed: false,
        reason: 'READ_MAP_STATIC_GEOMETRY_METHOD_MISSING'
      };
      globalThis.__sfMapApiTiming = { snapshot: () => unavailable };
      return unavailable;
    }
    const maxDiagnosticCount = 16;
    const stableCodePattern = /^[A-Z][A-Z0-9_]{0,95}$/;
    const projectResultDiagnostics = (result) => {
      const responseError = result?.error && typeof result.error === 'object' ? result.error : null;
      const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
      const diagnosticCodes = [];
      for (const item of diagnostics.slice(0, maxDiagnosticCount)) {
        if (typeof item?.code === 'string' && stableCodePattern.test(item.code)) diagnosticCodes.push(item.code);
      }
      return {
        resultErrorCode: typeof responseError?.code === 'string' && stableCodePattern.test(responseError.code)
          ? responseError.code
          : null,
        diagnosticCodes
      };
    };
    const state = {
      installed: false,
      reason: null,
      phase: 'unlabelled',
      calls: 0,
      okCount: 0,
      failedCount: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      durations: [],
      phaseStats: Object.create(null),
      recent: []
    };
    const wrapped = async function (...args) {
      const started = performance.now();
      const phase = state.phase;
      let result;
      let thrown = null;
      try {
        // Preserve the contextBridge receiver. Calling the original function
        // detached from api can fail with Chromium's Illegal invocation.
        result = await original.apply(this, args);
        return result;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        const elapsedMs = performance.now() - started;
        const modelName = typeof args[1] === 'string' ? args[1] : null;
        const cursorPresent = Boolean(args[2]);
        const sessionPresent = Boolean(args[3]);
        const ok = !thrown && result?.ok === true;
        const data = result?.data ?? null;
        const chunks = Array.isArray(data?.chunks) ? data.chunks : [];
        const resultDiagnostics = projectResultDiagnostics(result);
        const wireBase64Chars = chunks.reduce((sum, chunk) => sum + [
          chunk?.positionsBase64,
          chunk?.indicesBase64,
          chunk?.uvsBase64,
          chunk?.normalsBase64
        ].reduce((inner, value) => inner + (typeof value === 'string' ? value.length : 0), 0), 0);
        state.calls += 1;
        if (ok) state.okCount += 1;
        else state.failedCount += 1;
        state.totalMs += elapsedMs;
        state.minMs = Math.min(state.minMs, elapsedMs);
        state.maxMs = Math.max(state.maxMs, elapsedMs);
        state.durations.push(elapsedMs);
        if (state.durations.length > 10_000) state.durations.shift();
        const stats = state.phaseStats[phase] ?? (state.phaseStats[phase] = {
          calls: 0,
          okCount: 0,
          failedCount: 0,
          totalMs: 0,
          minMs: Number.POSITIVE_INFINITY,
          maxMs: 0,
          durations: []
        });
        stats.calls += 1;
        if (ok) stats.okCount += 1;
        else stats.failedCount += 1;
        stats.totalMs += elapsedMs;
        stats.minMs = Math.min(stats.minMs, elapsedMs);
        stats.maxMs = Math.max(stats.maxMs, elapsedMs);
        stats.durations.push(elapsedMs);
        if (stats.durations.length > 10_000) stats.durations.shift();
        state.recent.push({
          phase,
          modelName,
          cursorPresent,
          sessionPresent,
          elapsedMs,
          ok,
          complete: data?.complete ?? null,
          nextCursorPresent: Boolean(data?.nextCursor),
          chunkCount: chunks.length,
          wireBase64Chars,
          error: thrown ? String(thrown?.message ?? thrown) : null,
          ...resultDiagnostics
        });
        if (state.recent.length > 200) state.recent.shift();
      }
    };
    let assigned = false;
    try {
      api.readMapStaticGeometry = wrapped;
      assigned = api.readMapStaticGeometry === wrapped;
    } catch (error) {
      state.reason = `ASSIGNMENT_FAILED: ${String(error?.message ?? error)}`;
    }
    if (!assigned) {
      try {
        Object.defineProperty(api, 'readMapStaticGeometry', {
          configurable: true,
          writable: true,
          value: wrapped
        });
        assigned = api.readMapStaticGeometry === wrapped;
      } catch (error) {
        state.reason ??= `DEFINE_PROPERTY_FAILED: ${String(error?.message ?? error)}`;
      }
    }
    state.installed = assigned;
    state.reason ??= assigned ? null : 'CONTEXT_BRIDGE_METHOD_NOT_WRITABLE';
    const quantile = (values, percentile) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))] ?? null;
    };
    const cleanStats = (stats) => ({
      calls: stats.calls,
      okCount: stats.okCount,
      failedCount: stats.failedCount,
      totalMs: stats.totalMs,
      averageMs: stats.calls > 0 ? stats.totalMs / stats.calls : null,
      minMs: Number.isFinite(stats.minMs) ? stats.minMs : null,
      p50Ms: quantile(stats.durations, 0.5),
      p95Ms: quantile(stats.durations, 0.95),
      maxMs: stats.maxMs
    });
    state.snapshot = () => ({
      installed: state.installed,
      reason: state.reason,
      phase: state.phase,
      calls: state.calls,
      okCount: state.okCount,
      failedCount: state.failedCount,
      totalMs: state.totalMs,
      averageMs: state.calls > 0 ? state.totalMs / state.calls : null,
      minMs: Number.isFinite(state.minMs) ? state.minMs : null,
      p50Ms: quantile(state.durations, 0.5),
      p95Ms: quantile(state.durations, 0.95),
      maxMs: state.calls > 0 ? state.maxMs : null,
      phaseStats: Object.fromEntries(Object.entries(state.phaseStats).map(([key, value]) => [key, cleanStats(value)])),
      recent: state.recent.slice(-200)
    });
    state.setPhase = (phase) => { state.phase = typeof phase === 'string' ? phase : 'unlabelled'; };
    globalThis.__sfMapApiTiming = state;
    return state.snapshot();
  });
}

async function setMapApiTimingPhase(page, phase) {
  return page.evaluate((nextPhase) => {
    const timing = globalThis.__sfMapApiTiming;
    if (timing?.setPhase) timing.setPhase(nextPhase);
    return timing?.snapshot?.() ?? null;
  }, phase).catch(() => null);
}

async function snapshotMapApiTiming(page) {
  return page.evaluate(() => globalThis.__sfMapApiTiming?.snapshot?.() ?? null).catch(() => null);
}

/**
 * Set the phase captured by production-main's test-only MAP timing harness.
 * This is intentionally main-process state rather than a new renderer/API
 * channel, so an IPC request keeps the phase it had at invocation start even
 * if the probe advances to the next boundary while it is still in flight.
 */
async function setMainMapTimingPhase(app, phase) {
  if (!app) return { ok: false, reason: 'MAP_MAIN_TIMING_APP_MISSING' };
  return app.evaluate((_electron, options) => {
    const control = globalThis[options?.key];
    if (!control || typeof control.setPhase !== 'function') {
      return { ok: false, reason: 'MAP_MAIN_TIMING_CONTROL_UNAVAILABLE' };
    }
    return control.setPhase(options.phase);
  }, { key: MAP_MAIN_TIMING_PHASE_KEY, phase });
}

async function summarizeMsb(page, sourceUri) {
  return page.evaluate(async ({ sourceUri }) => {
    const started = performance.now();
    const result = await globalThis.soulforge.readMsbDocument(sourceUri);
    const data = result?.data ?? null;
    const models = Array.isArray(data?.models) ? data.models : [];
    const parts = Array.isArray(data?.parts) ? data.parts : [];
    const names = models
      .map((model) => typeof model?.name === 'string' ? model.name : null)
      .filter((name) => Boolean(name));
    const byModel = new Map();
    for (const part of parts) {
      const modelName = typeof part?.modelName === 'string'
        ? part.modelName
        : Number.isInteger(part?.modelIndex) && typeof models[part.modelIndex]?.name === 'string'
          ? models[part.modelIndex].name
          : null;
      if (modelName) byModel.set(modelName, (byModel.get(modelName) ?? 0) + 1);
    }
    return {
      ok: Boolean(result?.ok),
      elapsedMs: performance.now() - started,
      sourceUri,
      sourceHashLength: typeof data?.sourceHash === 'string' ? data.sourceHash.length : 0,
      version: data?.version ?? null,
      modelCount: data?.modelCount ?? models.length,
      partCount: data?.partCount ?? parts.length,
      regionCount: data?.regionCount ?? data?.regions?.length ?? 0,
      eventCount: data?.eventCount ?? data?.events?.length ?? 0,
      routeCount: data?.routeCount ?? data?.routes?.length ?? 0,
      modelNames: names,
      repeatedModelCounts: [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
      diagnostics: Array.isArray(result?.diagnostics)
        ? result.diagnostics.map((item) => item?.code).filter(Boolean)
        : []
    };
  }, { sourceUri });
}

async function readGeometryPages(page, sourceUri, modelName) {
  return page.evaluate(async ({ sourceUri, modelName, maxPages }) => {
    let cursor = null;
    let sessionToken = null;
    let pageCount = 0;
    let chunkCount = 0;
    let vertexCount = 0;
    let indexBytes = 0;
    let wireBytes = 0;
    let firstPageMs = null;
    let lastPageMs = null;
    let complete = false;
    let ok = true;
    const diagnostics = [];
    let nativeTimingSummary = null;
    const pageTimings = [];
    while (pageCount < maxPages) {
      const started = performance.now();
      const result = await globalThis.soulforge.readMapStaticGeometry(sourceUri, modelName, cursor, sessionToken);
      const elapsedMs = performance.now() - started;
      pageCount += 1;
      firstPageMs ??= elapsedMs;
      lastPageMs = elapsedMs;
      pageTimings.push(elapsedMs);
      if (!result?.ok) {
        ok = false;
        if (Array.isArray(result?.diagnostics)) {
          diagnostics.push(...result.diagnostics.map((item) => item?.code).filter(Boolean));
          nativeTimingSummary ??= result.diagnostics.find((item) => item?.code === 'MAP_NATIVE_TIMING_SUMMARY')?.details ?? null;
        }
        break;
      }
      if (Array.isArray(result?.diagnostics)) {
        diagnostics.push(...result.diagnostics.map((item) => item?.code).filter(Boolean));
        nativeTimingSummary ??= result.diagnostics.find((item) => item?.code === 'MAP_NATIVE_TIMING_SUMMARY')?.details ?? null;
      }
      const data = result.data ?? {};
      const chunks = Array.isArray(data.chunks) ? data.chunks : [];
      chunkCount += chunks.length;
      for (const chunk of chunks) {
        const positionBytes = typeof chunk?.positionsBase64 === 'string' ? chunk.positionsBase64.length * 3 / 4 : 0;
        const indexBytesHere = typeof chunk?.indicesBase64 === 'string' ? chunk.indicesBase64.length * 3 / 4 : 0;
        vertexCount += Math.floor(positionBytes / 12);
        indexBytes += indexBytesHere;
        wireBytes += [chunk?.positionsBase64, chunk?.indicesBase64, chunk?.uvsBase64, chunk?.normalsBase64]
          .reduce((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0);
      }
      sessionToken = data.sessionToken ?? sessionToken;
      cursor = data.nextCursor ?? null;
      complete = Boolean(data.complete || !cursor);
      if (complete) break;
    }
    return {
      ok,
      sourceUri,
      modelName,
      pageCount,
      chunkCount,
      vertexCount,
      indexBytes: Math.round(indexBytes),
      wireBase64Chars: wireBytes,
      firstPageMs,
      lastPageMs,
      pageTimings,
      complete,
      truncatedByPageLimit: !complete && pageCount >= maxPages,
      diagnostics,
      nativeTimingSummary
    };
  }, { sourceUri, modelName, maxPages: MAX_GEOMETRY_PAGES });
}

async function getWorkspaceAndMap(page) {
  // 这里必须走真实 React 入口，而不是直接调用公开 dialog/scan API：只有
  // StartWorkspacePanel -> App.openWorkspace -> mountWorkspace 才会把扫描结果
  // 写入 renderer state，随后资源列表/地图工作台才与生产用户路径一致。
  await page.waitForFunction(() => Boolean(globalThis.soulforge));
  const start = page.getByRole('region', { name: '开始' });
  await start.getByTestId('choose-base-directory').click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="choose-base-directory"]');
    return button?.textContent?.includes('更换原版目录') === true;
  }, undefined, { timeout: 30_000 });
  await start.getByTestId('open-workspace').click();
  await page.locator('.workspace-switcher__trigger').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const label = document.querySelector('.workspace-switcher__label')?.textContent ?? '';
    return label.includes('mods');
  }, undefined, { timeout: 180_000 });

  return page.evaluate(async ({ mapRelativePath }) => {
    const api = globalThis.soulforge;
    const resources = await api.searchResources(mapRelativePath);
    const candidates = Array.isArray(resources) ? resources.map((file) => ({
      sourceUri: file?.sourceUri ?? null,
      relativePath: file?.relativePath ?? null,
      game: file?.game ?? null,
      resourceKind: file?.resourceKind ?? null
    })) : [];
    const map = candidates.find((file) => file.relativePath?.replace(/\\/g, '/').toLowerCase() === mapRelativePath.toLowerCase())
      ?? candidates[0]
      ?? null;
    return {
      // UI mount 已经在 App.mountWorkspace 内完成 scanWorkspace；不再从探针
      // 重复调用 scanWorkspace，避免把“公开 API 直扫”误报成用户真实路径。
      scan: { fileCount: null, countsByKind: null, completedBy: 'renderer-ui-mount' },
      baseSelected: true,
      candidates,
      map
    };
  }, { mapRelativePath: MAP_RELATIVE_PATH });
}

function chooseModel(names) {
  const normalize = (value) => String(value).replace(/\\/g, '/').split('/').pop().toLowerCase();
  const exact = names.find((name) => normalize(name) === normalize(REQUESTED_MODEL));
  const fallback = names.find((name) => /^(o|c)\d/i.test(normalize(name)))
    ?? names.find((name) => !/^h\d/i.test(normalize(name)))
    ?? names[0]
    ?? null;
  return {
    requestedModel: REQUESTED_MODEL,
    selectedModel: exact ?? fallback,
    exact: Boolean(exact),
    modelCount: names.length
  };
}

function extractLoaderEvent(events, phrase) {
  return events.filter((entry) => entry.text.includes(phrase));
}

const MAP_LOAD_RETENTION_MARKER = '[SF_MAP_LOAD_RETENTION]';
const MAP_LOAD_RETENTION_COUNT_KEYS = [
  'preparedEnvelopeCount',
  'inFlightCount',
  'legacyInFlightCount',
  'uploadedCount'
];

function parseMapLoadRetentionMarker(text) {
  if (typeof text !== 'string') return null;
  const markerIndex = text.indexOf(MAP_LOAD_RETENTION_MARKER);
  if (markerIndex < 0) return null;
  const payload = text.slice(markerIndex + MAP_LOAD_RETENTION_MARKER.length).trim();
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const counts = {};
    for (const key of MAP_LOAD_RETENTION_COUNT_KEYS) {
      const value = parsed[key];
      if (!Number.isSafeInteger(value) || value < 0) return null;
      counts[key] = value;
    }
    return counts;
  } catch {
    return null;
  }
}

function extractMapLoadRetentionEvents(events) {
  return events.flatMap((entry) => {
    const counts = parseMapLoadRetentionMarker(entry?.text);
    if (!counts) return [];
    return [{
      atMs: Number.isFinite(entry?.atMs) ? entry.atMs : null,
      ...counts
    }];
  });
}

const MAP_CANCELLATION_TERMINAL_MARKER = '[SF_MAP_CANCELLATION_TERMINAL]';
const MAP_CANCELLATION_REQUESTED_MARKER = '[SF_MAP_CANCELLATION_REQUESTED]';

/**
 * Read the main-process cancellation terminal marker as a structured stream.
 * A renderer cleanup is not native evidence: only a receipt with the exact
 * schema/source, this run's opaque owner/request handle, outcome=cancelled,
 * and requestPhase=command can establish command cancellation. Artifact
 * receipts remain visible but are never promoted to native command evidence.
 */
function createMapCancellationTelemetryCollector() {
  const maxLineChars = 128 * 1024;
  const receiptLimit = 256;
  const state = {
    buffer: '',
    discardingOversizeLine: false,
    droppedOversizeLineCount: 0,
    ignoredOversizeLineCount: 0,
    malformedCount: 0,
    invalidTimestampCount: 0,
    invalidIdentityCount: 0,
    receipts: [],
    cancelRequests: [],
    overflow: false
  };
  const consumeLine = (line) => {
    // Markers are emitted as complete lines by main.  Requiring the prefix
    // prevents arbitrary application text containing the marker from becoming
    // cancellation evidence.
    const candidate = line.trimStart();
    const terminalIndex = candidate.startsWith(MAP_CANCELLATION_TERMINAL_MARKER) ? 0 : -1;
    const requestedIndex = candidate.startsWith(MAP_CANCELLATION_REQUESTED_MARKER) ? 0 : -1;
    const isTerminal = terminalIndex >= 0 && (requestedIndex < 0 || terminalIndex < requestedIndex);
    const markerIndex = isTerminal ? terminalIndex : requestedIndex;
    if (markerIndex < 0) return;
    const marker = isTerminal ? MAP_CANCELLATION_TERMINAL_MARKER : MAP_CANCELLATION_REQUESTED_MARKER;
    const payload = candidate.slice(markerIndex + marker.length).trim();
    let value;
    try {
      value = JSON.parse(payload);
    } catch {
      state.malformedCount += 1;
      return;
    }
    const expectedSource = isTerminal
      ? 'soulforge.main.map.runBridge'
      : 'soulforge.main.map.cancelMapStaticGeometry';
    const timestampField = isTerminal ? value?.receivedAt : value?.atUTC;
    const timestampMs = typeof timestampField === 'string' ? Date.parse(timestampField) : Number.NaN;
    const identityValid = value && typeof value === 'object'
      && value.schemaVersion === 1
      && value.source === expectedSource
      && Number.isSafeInteger(value.ownerId)
      && typeof value.requestId === 'string' && value.requestId.length > 0;
    const terminalShapeValid = !isTerminal || (
      typeof value.bridgeRequestId === 'string' && value.bridgeRequestId.length > 0
      && ['result', 'failed', 'cancelled'].includes(value.outcome)
      && ['command', 'artifact'].includes(value.requestPhase)
      && typeof value.cancelRequested === 'boolean'
    );
    const requestedShapeValid = isTerminal
      || Boolean(value && ['cancelled', 'already-cancelled', 'not-found'].includes(value.status));
    if (!identityValid) state.invalidIdentityCount += 1;
    if (!Number.isFinite(timestampMs)) state.invalidTimestampCount += 1;
    if (!identityValid || !terminalShapeValid || !requestedShapeValid || !Number.isFinite(timestampMs)) {
      state.malformedCount += 1;
      return;
    }
    if (isTerminal && state.receipts.length >= receiptLimit) {
      state.overflow = true;
      return;
    }
    if (!isTerminal && state.cancelRequests.length >= receiptLimit) {
      state.overflow = true;
      return;
    }
    if (isTerminal) state.receipts.push({ ...value, receivedAtMs: timestampMs });
    else state.cancelRequests.push({ ...value, atMs: timestampMs });
  };
  const recordOversize = (relevant) => {
    if (relevant) state.droppedOversizeLineCount += 1;
    else state.ignoredOversizeLineCount += 1;
  };
  return {
    ingest(chunk) {
      let remaining = String(chunk ?? '');
      while (remaining.length > 0) {
        if (state.discardingOversizeLine) {
          const newlineIndex = remaining.indexOf('\n');
          if (newlineIndex < 0) return;
          remaining = remaining.slice(newlineIndex + 1);
          state.discardingOversizeLine = false;
          continue;
        }
        const newlineIndex = remaining.indexOf('\n');
        if (newlineIndex < 0) {
          if (state.buffer.length + remaining.length > maxLineChars) {
            const candidate = `${state.buffer}${remaining}`.trimStart();
            state.buffer = '';
            state.discardingOversizeLine = true;
            recordOversize(candidate.startsWith(MAP_CANCELLATION_TERMINAL_MARKER)
              || candidate.startsWith(MAP_CANCELLATION_REQUESTED_MARKER));
          } else {
            state.buffer += remaining;
          }
          return;
        }
        const linePart = remaining.slice(0, newlineIndex);
        if (state.buffer.length + linePart.length > maxLineChars) {
          const candidate = `${state.buffer}${linePart}`.trimStart();
          state.buffer = '';
          recordOversize(candidate.startsWith(MAP_CANCELLATION_TERMINAL_MARKER)
            || candidate.startsWith(MAP_CANCELLATION_REQUESTED_MARKER));
        } else {
          const line = `${state.buffer}${linePart}`;
          state.buffer = '';
          consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        }
        remaining = remaining.slice(newlineIndex + 1);
      }
    },
    snapshot() {
      return {
        receipts: state.receipts.slice(),
        receiptCount: state.receipts.length,
        cancelRequests: state.cancelRequests.slice(),
        cancelRequestCount: state.cancelRequests.length,
        overflow: state.overflow,
        malformedCount: state.malformedCount,
        invalidTimestampCount: state.invalidTimestampCount,
        invalidIdentityCount: state.invalidIdentityCount,
        droppedOversizeLineCount: state.droppedOversizeLineCount,
        ignoredOversizeLineCount: state.ignoredOversizeLineCount,
        pendingLineChars: state.buffer.length,
        discardingOversizeLine: state.discardingOversizeLine
      };
    }
  };
}

function cancellationObservationHasTerminalForEveryAcceptedRequest(
  snapshot,
  requestStart,
  receiptStart
) {
  const accepted = (snapshot?.cancelRequests ?? []).slice(requestStart)
    .filter((request) => request?.status === 'cancelled' || request?.status === 'already-cancelled');
  if (accepted.length === 0) return false;
  const terminalKeys = new Set((snapshot?.receipts ?? []).slice(receiptStart)
    .map((receipt) => `${receipt?.ownerId}\u0000${receipt?.requestId}`));
  return [...new Set(accepted.map((request) => `${request?.ownerId}\u0000${request?.requestId}`))]
    .every((key) => terminalKeys.has(key));
}

function requestIdsFromRendererEvents(events) {
  const ids = new Set();
  for (const event of events ?? []) {
    const match = String(event?.text ?? '').match(/"requestId"\s*:\s*"([^"]+)"/);
    if (match?.[1]) ids.add(match[1]);
    const active = String(event?.text ?? '').match(/"activeRequestIds"\s*:\s*\[([^\]]*)\]/);
    if (active?.[1]) {
      for (const id of active[1].matchAll(/"([^"]+)"/g)) ids.add(id[1]);
    }
  }
  return ids;
}

function extractStructuredNativeCancellationEvidence({
  receipts,
  cancelRequests,
  eventsBeforeSwitch,
  eventsAfterSwitch,
  switchStartedAtMs = 0,
  switchFinishedAtMs = Number.POSITIVE_INFINITY,
  collectorIntegrity = {}
}) {
  // Renderer logs are retained for diagnostics only.  They are not an
  // authority for cancellation ownership; only the main cancel IPC marker
  // can establish which owner/request this switch actually cancelled.
  const startedRequestIds = requestIdsFromRendererEvents(eventsBeforeSwitch);
  const cleanupRequestIds = requestIdsFromRendererEvents(eventsAfterSwitch);
  const validCancelRequests = (cancelRequests ?? []).filter((request) =>
    (request.status === 'cancelled' || request.status === 'already-cancelled')
    && request.atMs >= switchStartedAtMs
    && request.atMs <= switchFinishedAtMs
  );
  const cancelKeys = new Set(validCancelRequests.map((request) => `${request.ownerId}\u0000${request.requestId}`));
  const postSwitchReceipts = (receipts ?? []).filter((receipt) => {
    const key = `${receipt.ownerId}\u0000${receipt.requestId}`;
    return cancelKeys.has(key)
      && receipt.receivedAtMs >= switchStartedAtMs
      && receipt.receivedAtMs <= switchFinishedAtMs;
  });
  const acceptedRequestKeys = [...cancelKeys];
  const terminalRequestKeys = [...new Set(postSwitchReceipts.map((receipt) => `${receipt.ownerId}\u0000${receipt.requestId}`))];
  const terminalRequestKeySet = new Set(terminalRequestKeys);
  const missingTerminalRequestKeys = acceptedRequestKeys.filter((key) => !terminalRequestKeySet.has(key));
  const acceptedRequestCoverage = {
    acceptedRequestCount: acceptedRequestKeys.length,
    terminalRequestCount: acceptedRequestKeys.filter((key) => terminalRequestKeySet.has(key)).length,
    missingTerminalRequestKeys,
    complete: acceptedRequestKeys.length > 0 && missingTerminalRequestKeys.length === 0
  };
  const commandCancelled = postSwitchReceipts.filter((receipt) =>
    receipt.outcome === 'cancelled'
    && receipt.requestPhase === 'command'
    && receipt.cancelRequested === true
  );
  const artifactCancelled = postSwitchReceipts.filter((receipt) =>
    receipt.outcome === 'cancelled'
    && receipt.requestPhase === 'artifact'
    && receipt.cancelRequested === true
  );
  const unmatched = (receipts ?? []).filter((receipt) => !postSwitchReceipts.includes(receipt));
  const terminalGroups = new Map();
  for (const receipt of postSwitchReceipts) {
    const key = [receipt.ownerId, receipt.requestId, receipt.bridgeRequestId, receipt.requestPhase].join('\u0000');
    const group = terminalGroups.get(key) ?? [];
    group.push(receipt);
    terminalGroups.set(key, group);
  }
  const duplicateTerminalGroups = [...terminalGroups.values()].filter((group) => group.length > 1);
  const contradictoryTerminalGroups = duplicateTerminalGroups.filter((group) =>
    new Set(group.map((receipt) => receipt.outcome)).size > 1
  );
  const integrityIssue = Boolean(
    collectorIntegrity.overflow
    || collectorIntegrity.malformedCount > 0
    || collectorIntegrity.invalidIdentityCount > 0
    || collectorIntegrity.invalidTimestampCount > 0
    || collectorIntegrity.droppedOversizeLineCount > 0
    || duplicateTerminalGroups.length > 0
    || contradictoryTerminalGroups.length > 0
    || unmatched.length > 0
  );
  const nativeCommandCancellationObserved = commandCancelled.length > 0;
  const completeAcceptedRequestCoverage = acceptedRequestCoverage.complete;
  return {
    startedRequestIds: [...startedRequestIds],
    cleanupRequestIds: [...cleanupRequestIds],
    cancelRequests: validCancelRequests,
    correlatedRequestIds: [...new Set(validCancelRequests.map((request) => request.requestId))],
    acceptedRequestCoverage,
    receipts: postSwitchReceipts,
    commandCancelled,
    artifactCancelled,
    unmatched,
    duplicateTerminalGroups,
    contradictoryTerminalGroups,
    nativeCommandCancellationObserved,
    nativeAbortObserved: nativeCommandCancellationObserved && completeAcceptedRequestCoverage && !integrityIssue,
    verification: integrityIssue
      ? nativeCommandCancellationObserved ? 'partial-integrity-unverified' : 'unverified-integrity'
      : !completeAcceptedRequestCoverage
        ? nativeCommandCancellationObserved ? 'partial-missing-terminal-unverified' : 'unverified-missing-terminal'
      : nativeCommandCancellationObserved
        ? 'observed'
      : artifactCancelled.length > 0
        ? 'unverified-artifact-only'
        : postSwitchReceipts.length > 0
          ? 'unverified-no-command-cancelled'
          : 'unverified-missing-or-unmatched'
  };
}

function runMapCancellationTelemetryFixture() {
  const collector = createMapCancellationTelemetryCollector();
  const command = {
    schemaVersion: 1,
    source: 'soulforge.main.map.runBridge',
    ownerId: 41,
    requestId: 'page-command',
    bridgeRequestId: 'bridge-command',
    outcome: 'cancelled',
    requestPhase: 'command',
    cancelRequested: true,
    receivedAt: '2026-09-09T00:00:00.000Z'
  };
  const artifact = {
    ...command,
    requestId: 'page-artifact',
    bridgeRequestId: 'bridge-artifact',
    requestPhase: 'artifact'
  };
  const commandCancel = {
    schemaVersion: 1,
    source: 'soulforge.main.map.cancelMapStaticGeometry',
    ownerId: 41,
    requestId: 'page-command',
    status: 'cancelled',
    atUTC: '2026-09-09T00:00:00.000Z'
  };
  const artifactCancel = {
    ...commandCancel,
    requestId: 'page-artifact',
    status: 'already-cancelled'
  };
  const crossOwnerCancel = {
    ...commandCancel,
    requestId: 'cross-owner'
  };
  const startOnly = {
    ...command,
    requestId: 'start-only',
    bridgeRequestId: 'bridge-start-only'
  };
  const invalidTimestampCancel = {
    ...commandCancel,
    requestId: 'invalid-time',
    atUTC: 'not-a-timestamp'
  };
  const crossOwnerTerminal = {
    ...command,
    ownerId: 99,
    requestId: 'cross-owner',
    bridgeRequestId: 'bridge-cross-owner'
  };
  const duplicateTerminal = {
    ...command,
    outcome: 'result'
  };
  const missingIdentity = { ...command };
  delete missingIdentity.ownerId;
  const lines = [
    `${MAP_CANCELLATION_REQUESTED_MARKER} ${JSON.stringify(commandCancel)}\n`,
    `${MAP_CANCELLATION_REQUESTED_MARKER} ${JSON.stringify(artifactCancel)}\n`,
    `${MAP_CANCELLATION_REQUESTED_MARKER} ${JSON.stringify(crossOwnerCancel)}\n`,
    `${MAP_CANCELLATION_REQUESTED_MARKER} ${JSON.stringify(invalidTimestampCancel)}\n`,
    `${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify(command)}\n`,
    `${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify(artifact)}\n`,
    `${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify(crossOwnerTerminal)}\n`,
    `${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify(startOnly)}\n`,
    `${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify(duplicateTerminal)}\n`,
    `${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify(missingIdentity)}\n`,
    `${MAP_CANCELLATION_TERMINAL_MARKER} not-json\n`,
    `unrelated-log ${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify(command)}\n`,
    `${'x'.repeat(128 * 1024 + 32)}\n`
  ].join('');
  for (let offset = 0; offset < lines.length; offset += 7) collector.ingest(lines.slice(offset, offset + 7));
  const snapshot = collector.snapshot();
  const evidence = extractStructuredNativeCancellationEvidence({
    receipts: snapshot.receipts,
    cancelRequests: snapshot.cancelRequests,
    eventsBeforeSwitch: [{ text: '[MsbScenePanel] MAP mesh page start {"requestId":"page-command"}' }, { text: '[MsbScenePanel] MAP mesh page start {"requestId":"page-artifact"}' }],
    eventsAfterSwitch: [{ text: '[MsbScenePanel] MAP mesh effect cleanup {"activeRequestIds":["page-command","page-artifact"]}' }],
    collectorIntegrity: snapshot
  });
  const cleanCollector = createMapCancellationTelemetryCollector();
  cleanCollector.ingest(`${MAP_CANCELLATION_REQUESTED_MARKER} ${JSON.stringify(commandCancel)}\n${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify(command)}\n`);
  const cleanSnapshot = cleanCollector.snapshot();
  const cleanEvidence = extractStructuredNativeCancellationEvidence({
    receipts: cleanSnapshot.receipts,
    cancelRequests: cleanSnapshot.cancelRequests,
    eventsBeforeSwitch: [],
    eventsAfterSwitch: [],
    collectorIntegrity: cleanSnapshot
  });
  const droppedLineEvidence = extractStructuredNativeCancellationEvidence({
    receipts: cleanSnapshot.receipts,
    cancelRequests: cleanSnapshot.cancelRequests,
    eventsBeforeSwitch: [],
    eventsAfterSwitch: [],
    collectorIntegrity: { ...cleanSnapshot, droppedOversizeLineCount: 1 }
  });
  return {
    receiptCount: snapshot.receiptCount,
    cancelRequestCount: snapshot.cancelRequestCount,
    malformedCount: snapshot.malformedCount,
    invalidTimestampCount: snapshot.invalidTimestampCount,
    invalidIdentityCount: snapshot.invalidIdentityCount,
    ignoredOversizeLineCount: snapshot.ignoredOversizeLineCount,
    commandCancellationCount: evidence.commandCancelled.length,
    artifactCancellationCount: evidence.artifactCancelled.length,
    acceptedRequestCoverage: evidence.acceptedRequestCoverage,
    unmatchedCount: evidence.unmatched.length,
    duplicateTerminalGroupCount: evidence.duplicateTerminalGroups.length,
    contradictoryTerminalGroupCount: evidence.contradictoryTerminalGroups.length,
    cleanVerification: cleanEvidence.verification,
    droppedLineVerification: droppedLineEvidence.verification,
    verification: evidence.verification,
    pass: snapshot.receiptCount === 5
      && snapshot.cancelRequestCount === 3
      && snapshot.malformedCount === 3
      && snapshot.invalidTimestampCount === 1
      && snapshot.invalidIdentityCount === 1
      && snapshot.ignoredOversizeLineCount >= 1
      && evidence.commandCancelled.length === 1
      && evidence.artifactCancelled.length === 1
      && evidence.nativeCommandCancellationObserved === true
      && evidence.nativeAbortObserved === false
      && evidence.verification === 'partial-integrity-unverified'
      && evidence.acceptedRequestCoverage.acceptedRequestCount === 3
      && evidence.acceptedRequestCoverage.terminalRequestCount === 2
      && evidence.acceptedRequestCoverage.complete === false
      && evidence.unmatched.length === 2
      && evidence.duplicateTerminalGroups.length === 1
      && evidence.contradictoryTerminalGroups.length === 1
      && cleanEvidence.nativeAbortObserved === true
      && cleanEvidence.acceptedRequestCoverage.complete === true
      && cleanEvidence.verification === 'observed'
      && droppedLineEvidence.nativeAbortObserved === false
      && droppedLineEvidence.verification === 'partial-integrity-unverified'
  };
}

const MAP_MODEL_UNAVAILABLE_TELEMETRY_MARKER = '[SF_MAP_MODEL_UNAVAILABLE]';
const MAP_MODEL_UNAVAILABLE_TELEMETRY_LIMIT = 256;
const STABLE_MAP_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * Keep normal-run per-model unavailable evidence bounded and structured. The
 * renderer emits only a model name, stable diagnostic codes, and an empty
 * geometry classification; this collector does not reread native data or
 * infer a missing path from diagnostic text.
 */
function createMapModelUnavailableTelemetryCollector() {
  const state = {
    records: [],
    seenModelNames: new Set(),
    overflow: false,
    malformedCount: 0
  };
  const consumeLine = (line) => {
    const candidate = String(line ?? '').trimStart();
    if (!candidate.startsWith(MAP_MODEL_UNAVAILABLE_TELEMETRY_MARKER)) return;
    const payload = candidate.slice(MAP_MODEL_UNAVAILABLE_TELEMETRY_MARKER.length).trim();
    let value;
    try {
      value = JSON.parse(payload);
    } catch {
      state.malformedCount += 1;
      return;
    }
    const modelName = typeof value?.modelName === 'string' && value.modelName.length > 0
      && value.modelName.length <= 512
      ? value.modelName
      : null;
    const diagnosticCodes = Array.isArray(value?.diagnosticCodes)
      && value.diagnosticCodes.length <= 32
      && value.diagnosticCodes.every((code) => typeof code === 'string' && STABLE_MAP_DIAGNOSTIC_CODE.test(code))
      ? [...new Set(value.diagnosticCodes)].sort()
      : null;
    const geometryClassification = value?.geometryClassification;
    if (!modelName || !diagnosticCodes || !['empty-geometry', 'skeleton-only', 'unclassified'].includes(geometryClassification)) {
      state.malformedCount += 1;
      return;
    }
    if (state.seenModelNames.has(modelName)) return;
    state.seenModelNames.add(modelName);
    if (state.records.length >= MAP_MODEL_UNAVAILABLE_TELEMETRY_LIMIT) {
      state.overflow = true;
      return;
    }
    state.records.push({ modelName, diagnosticCodes, geometryClassification });
  };
  return {
    ingest(chunk) {
      for (const line of String(chunk ?? '').split(/\r?\n/)) consumeLine(line);
    },
    snapshot() {
      return {
        records: state.records.slice(),
        recordCount: state.records.length,
        overflow: state.overflow,
        malformedCount: state.malformedCount
      };
    }
  };
}

function runMapModelUnavailableTelemetryFixture() {
  const collector = createMapModelUnavailableTelemetryCollector();
  collector.ingest(`${MAP_MODEL_UNAVAILABLE_TELEMETRY_MARKER} ${JSON.stringify({
    modelName: 'o000100',
    diagnosticCodes: ['MAP_STATIC_GEOMETRY_COMPLETE'],
    geometryClassification: 'empty-geometry'
  })}\n`);
  collector.ingest(`${MAP_MODEL_UNAVAILABLE_TELEMETRY_MARKER} ${JSON.stringify({
    modelName: 'c0000',
    diagnosticCodes: ['MAP_CHARACTER_GEOMETRY_UNAVAILABLE'],
    geometryClassification: 'skeleton-only'
  })}\n`);
  // Duplicate model entries are not a second unavailable model.
  collector.ingest(`${MAP_MODEL_UNAVAILABLE_TELEMETRY_MARKER} ${JSON.stringify({
    modelName: 'o000100',
    diagnosticCodes: ['MAP_STATIC_GEOMETRY_COMPLETE'],
    geometryClassification: 'empty-geometry'
  })}\n`);
  collector.ingest(`${MAP_MODEL_UNAVAILABLE_TELEMETRY_MARKER} not-json\n`);
  for (let index = 0; index <= MAP_MODEL_UNAVAILABLE_TELEMETRY_LIMIT; index += 1) {
    collector.ingest(`${MAP_MODEL_UNAVAILABLE_TELEMETRY_MARKER} ${JSON.stringify({
      modelName: `h${String(index).padStart(6, '0')}`,
      diagnosticCodes: [],
      geometryClassification: 'unclassified'
    })}\n`);
  }
  const snapshot = collector.snapshot();
  return {
    recordCount: snapshot.recordCount,
    overflow: snapshot.overflow,
    malformedCount: snapshot.malformedCount,
    pass: snapshot.recordCount === MAP_MODEL_UNAVAILABLE_TELEMETRY_LIMIT
      && snapshot.overflow === true
      && snapshot.malformedCount === 1
      && snapshot.records[0]?.modelName === 'o000100'
      && snapshot.records[0]?.geometryClassification === 'empty-geometry'
      && snapshot.records[1]?.geometryClassification === 'skeleton-only'
  };
}

function runMapLoadRetentionTelemetryFixture() {
  const first = {
    preparedEnvelopeCount: 3,
    inFlightCount: 2,
    legacyInFlightCount: 1,
    uploadedCount: 7
  };
  const second = {
    preparedEnvelopeCount: 0,
    inFlightCount: 0,
    legacyInFlightCount: 0,
    uploadedCount: 8,
    // Payload-like fields must never be copied into the probe report.
    modelNames: ['o000100']
  };
  const events = extractMapLoadRetentionEvents([
    { atMs: 11, text: `${MAP_LOAD_RETENTION_MARKER} ${JSON.stringify(first)}` },
    { atMs: 12, text: `${MAP_LOAD_RETENTION_MARKER} ${JSON.stringify(second)}` },
    { atMs: 13, text: `${MAP_LOAD_RETENTION_MARKER} not-json` },
    { atMs: 14, text: '[MsbScenePanel] unrelated console object' }
  ]);
  const expected = [
    { atMs: 11, ...first },
    {
      atMs: 12,
      preparedEnvelopeCount: 0,
      inFlightCount: 0,
      legacyInFlightCount: 0,
      uploadedCount: 8
    }
  ];
  return {
    events,
    malformedIgnored: events.length === 2,
    countsOnly: JSON.stringify(events) === JSON.stringify(expected),
    pass: JSON.stringify(events) === JSON.stringify(expected)
  };
}

function runMapApiObserverProjectionFixture() {
  const projection = projectMapApiObserverResult({
    ok: false,
    error: { code: 'MAP_RESPONSE_ERROR', message: 'native path and payload must not be copied' },
    diagnostics: Array.from({ length: 20 }, (_, index) => ({
      code: index === 19 ? `MAP_DIAGNOSTIC_${'X'.repeat(100)}` : `MAP_DIAGNOSTIC_${String(index).padStart(2, '0')}`,
      message: `diagnostic message ${index}`,
      sourceUri: 'file:///native/path/that-must-not-be-observed',
      details: { geometryBytes: 'omitted' }
    }))
  });
  const keys = Object.keys(projection).sort();
  return {
    resultErrorCodeLength: projection.resultErrorCode?.length ?? null,
    diagnosticCount: projection.diagnosticCodes.length,
    firstDiagnosticCode: projection.diagnosticCodes[0] ?? null,
    keys,
    pass: projection.resultErrorCode === 'MAP_RESPONSE_ERROR'
      && projection.diagnosticCodes.length === MAP_API_OBSERVER_MAX_DIAGNOSTICS
      && projection.diagnosticCodes.at(-1) === 'MAP_DIAGNOSTIC_15'
      && !projection.diagnosticCodes.some((code) => code.length > 96)
      && JSON.stringify(keys) === JSON.stringify(['diagnosticCodes', 'resultErrorCode'])
  };
}

/**
 * 增量读取 production-main 在真实 IPC handler 外层输出的 main-side MAP
 * marker。不能在 finally 里只解析 stdoutTail：tail 会把早期 installed marker
 * 挤掉，而且 Electron 的 stdout chunk 可能把一行拆开。这里每次收到 chunk 都
 * 按完整行消费，只保留有限的 call/window 变化与汇总。
 */
function createMainMapTelemetryCollector() {
  const marker = '[SF_MAP_MAIN_TELEMETRY]';
  const maxLineChars = MAIN_MAP_TELEMETRY_MAX_LINE_CHARS;
  const diagnosticLimit = 32;
  const state = {
    buffer: '',
    discardingOversizeLine: false,
    droppedOversizeLineCount: 0,
    diagnostics: [],
    markerCount: 0,
    installed: false,
    handlerWrapped: false,
    instrumentationError: null,
    startedAtUTC: null,
    summary: null,
    aggregate: null,
    recentCallMarkers: [],
    topSlowCalls: [],
    timeBuckets: new Map(),
    stateTransitions: [],
    lastWindowState: null,
    callLimit: 64,
    transitionLimit: 128,
    topSlowCallLimit: 16,
    timeBucketLimit: 3600
  };
  const recordOversizeLine = () => {
    state.droppedOversizeLineCount += 1;
    state.diagnostics.push({
      code: 'MAP_MAIN_TELEMETRY_OVERSIZE_LINE_DROPPED',
      maxLineChars,
      count: state.droppedOversizeLineCount
    });
    if (state.diagnostics.length > diagnosticLimit) state.diagnostics.shift();
  };
  const stateShape = (entry) => ({
    visible: entry?.visible ?? null,
    minimized: entry?.minimized ?? null,
    focused: entry?.focused ?? null,
    backgroundThrottling: entry?.backgroundThrottling ?? null,
    backgroundThrottlingSource: entry?.backgroundThrottlingSource ?? null
  });
  const recordSlowCall = (entry) => {
    const slowCalls = state.topSlowCalls;
    if (slowCalls.length < state.topSlowCallLimit) {
      slowCalls.push(entry);
    } else {
      let slowestIndex = 0;
      for (let index = 1; index < slowCalls.length; index += 1) {
        if (slowCalls[index].elapsedMs < slowCalls[slowestIndex].elapsedMs) slowestIndex = index;
      }
      if (entry.elapsedMs > slowCalls[slowestIndex].elapsedMs) slowCalls[slowestIndex] = entry;
    }
    slowCalls.sort((left, right) => right.elapsedMs - left.elapsedMs);
  };
  const recordTimeBucket = (entry) => {
    if (!Number.isFinite(entry?.relativeStartMs) || !Number.isFinite(entry?.elapsedMs)) return;
    const bucketIndex = Math.max(0, Math.floor(entry.relativeStartMs / 1000));
    let bucket = state.timeBuckets.get(bucketIndex);
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
      state.timeBuckets.set(bucketIndex, bucket);
    }
    bucket.calls += 1;
    if (entry.ok) bucket.okCount += 1;
    else bucket.failedCount += 1;
    bucket.totalMs += entry.elapsedMs;
    bucket.maxMs = Math.max(bucket.maxMs, entry.elapsedMs);
    while (state.timeBuckets.size > state.timeBucketLimit) {
      const oldest = state.timeBuckets.keys().next().value;
      if (typeof oldest !== 'number') break;
      state.timeBuckets.delete(oldest);
    }
  };
  const consumeEvent = (event) => {
    if (!event || typeof event !== 'object') return;
    state.markerCount += 1;
    if (event.type === 'installed') {
      state.installed = true;
      state.startedAtUTC ??= typeof event.atUTC === 'string' ? event.atUTC : null;
      return;
    }
    if (event.type === 'call') {
      state.handlerWrapped = true;
      state.aggregate = event.aggregate ?? state.aggregate;
      state.recentCallMarkers.push(event);
      if (state.recentCallMarkers.length > state.callLimit) state.recentCallMarkers.shift();
      recordSlowCall(event);
      recordTimeBucket(event);
      const nextState = stateShape(event);
      if (JSON.stringify(state.lastWindowState) !== JSON.stringify(nextState)) {
        state.stateTransitions.push({
          atUTC: event.completedAtUTC ?? null,
          relativeMs: Number.isFinite(event.relativeCompletedMs) ? event.relativeCompletedMs : null,
          from: state.lastWindowState,
          to: nextState,
          callIndex: event.index ?? null
        });
        if (state.stateTransitions.length > state.transitionLimit) state.stateTransitions.shift();
        state.lastWindowState = nextState;
      }
      return;
    }
    if (event.type === 'summary' && event.summary && typeof event.summary === 'object') {
      state.summary = event.summary;
      state.installed ||= event.summary.installed === true;
      state.handlerWrapped ||= event.summary.handlerWrapped === true;
      state.instrumentationError ??= event.summary.instrumentationError ?? null;
      state.startedAtUTC ??= event.summary.startedAtUTC ?? null;
    }
  };
  const consumeLine = (line) => {
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) return;
    const payload = line.slice(markerIndex + marker.length).trim();
    try {
      consumeEvent(JSON.parse(payload));
    } catch {
      // A malformed/partial line is not evidence; the next complete marker remains usable.
    }
  };
  return {
    ingest(chunk) {
      let remaining = String(chunk ?? '');
      while (remaining.length > 0) {
        if (state.discardingOversizeLine) {
          const newlineIndex = remaining.indexOf('\n');
          if (newlineIndex < 0) return;
          remaining = remaining.slice(newlineIndex + 1);
          state.discardingOversizeLine = false;
          continue;
        }

        const newlineIndex = remaining.indexOf('\n');
        if (newlineIndex < 0) {
          // An unterminated line is retained only while it remains within the
          // fixed bound. Once exceeded, clear it and discard until newline;
          // never keep a tail that could be mistaken for a JSON marker.
          if (state.buffer.length + remaining.length > maxLineChars) {
            state.buffer = '';
            state.discardingOversizeLine = true;
            recordOversizeLine();
          } else {
            state.buffer += remaining;
          }
          return;
        }

        const linePart = remaining.slice(0, newlineIndex);
        if (state.buffer.length + linePart.length > maxLineChars) {
          state.buffer = '';
          recordOversizeLine();
        } else {
          const line = `${state.buffer}${linePart}`;
          state.buffer = '';
          consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        }
        remaining = remaining.slice(newlineIndex + 1);
      }
    },
    snapshot() {
      const lastCall = state.recentCallMarkers.at(-1) ?? null;
      const fallbackAggregate = state.aggregate ?? lastCall?.aggregate ?? null;
      let summary = state.summary ?? (fallbackAggregate
        ? {
            ...fallbackAggregate,
            startedAtUTC: state.startedAtUTC,
            averageMs: fallbackAggregate.calls > 0 ? fallbackAggregate.totalMs / fallbackAggregate.calls : null,
            p50Ms: null,
            p95Ms: null,
            quantileSample: {
              kind: 'recent-call-markers',
              sampleCount: state.recentCallMarkers.length,
              sampleLimit: fallbackAggregate.retainedSampleLimit ?? state.callLimit,
              firstCallIndex: state.recentCallMarkers[0]?.index ?? null,
              lastCallIndex: lastCall?.index ?? null,
              complete: false,
              note: 'final summary marker not observed; quantiles unavailable'
            },
            recentCalls: state.recentCallMarkers.slice(-64),
            topSlowCalls: state.topSlowCalls.slice(),
            timeBuckets: [...state.timeBuckets.values()],
            stateTransitions: state.stateTransitions.slice(-state.transitionLimit)
          }
        : null);
      if (summary) {
        summary = {
          ...summary,
          recentCalls: Array.isArray(summary.recentCalls) ? summary.recentCalls : state.recentCallMarkers.slice(-64),
          topSlowCalls: Array.isArray(summary.topSlowCalls) ? summary.topSlowCalls : state.topSlowCalls.slice(),
          timeBuckets: Array.isArray(summary.timeBuckets) ? summary.timeBuckets : [...state.timeBuckets.values()],
          stateTransitions: Array.isArray(summary.stateTransitions)
            ? summary.stateTransitions
            : state.stateTransitions.slice(-state.transitionLimit)
        };
      }
      return {
        observed: state.markerCount > 0,
        markerCount: state.markerCount,
        droppedOversizeLineCount: state.droppedOversizeLineCount,
        diagnostics: state.diagnostics.slice(),
        pendingLineChars: state.buffer.length,
        discardingOversizeLine: state.discardingOversizeLine,
        installed: state.installed,
        handlerWrapped: state.handlerWrapped,
        instrumentationError: state.instrumentationError,
        startedAtUTC: state.startedAtUTC,
        summary,
        recentCallMarkers: state.recentCallMarkers.slice(-64),
        topSlowCalls: state.topSlowCalls.slice(),
        timeBuckets: [...state.timeBuckets.values()],
        stateTransitions: state.stateTransitions.slice(-state.transitionLimit)
      };
    }
  };
}

function runMainMapTelemetryCollectorFixture() {
  const marker = '[SF_MAP_MAIN_TELEMETRY]';
  const chunkSize = 8_191;
  const timingSummary = {
    schemaVersion: 1,
    unit: 'ms',
    requestCount: 1,
    unavailablePhases: [],
    phases: {
      queueWaitMs: { count: 1, totalMs: 3, minMs: 3, maxMs: 3, topSlowMs: [3] }
    }
  };
  const nativeAccumulator = createMapNativeTimingAccumulator();
  recordMapNativeTimingCall(nativeAccumulator, 'direct', timingSummary);
  recordMapNativeTimingCall(nativeAccumulator, 'ui-load', timingSummary);
  const nativeTimingSummaryByPhase = snapshotMapNativeTimingAccumulator(nativeAccumulator);
  const largeSummary = {
    installed: true,
    handlerWrapped: true,
    calls: 2,
    nativeTimingSummaryByPhase,
    // Real main summaries contain bounded call/time-bucket details. Keep this
    // fixture line above the old 64 KiB tail limit while below the new bound.
    padding: 'x'.repeat(70_000)
  };
  const largeLine = `${marker} ${JSON.stringify({ type: 'summary', summary: largeSummary })}\n`;
  const normalCollector = createMainMapTelemetryCollector();
  for (let offset = 0; offset < largeLine.length; offset += chunkSize) {
    normalCollector.ingest(largeLine.slice(offset, offset + chunkSize));
  }
  const normalSnapshot = normalCollector.snapshot();
  const normalNative = normalSnapshot.summary?.nativeTimingSummaryByPhase;
  const normalPass = largeLine.length > 64 * 1024
    && largeLine.length < MAIN_MAP_TELEMETRY_MAX_LINE_CHARS
    && normalSnapshot.droppedOversizeLineCount === 0
    && normalSnapshot.markerCount === 1
    && normalSnapshot.summary?.padding?.length === 70_000
    && normalNative?.buckets?.direct?.summaryCount === 1
    && normalNative?.buckets?.['ui-load']?.summaryCount === 1;

  const oversizeCollector = createMainMapTelemetryCollector();
  const oversizeBody = `${marker}${'x'.repeat(MAIN_MAP_TELEMETRY_MAX_LINE_CHARS + 1_024)}`;
  for (let offset = 0; offset < oversizeBody.length; offset += chunkSize) {
    oversizeCollector.ingest(oversizeBody.slice(offset, offset + chunkSize));
  }
  const beforeRecovery = oversizeCollector.snapshot();
  const recoverySummary = { recovered: true, nativeTimingSummaryByPhase };
  const recoveryLine = `${marker} ${JSON.stringify({ type: 'summary', summary: recoverySummary })}\n`;
  oversizeCollector.ingest(`\n${recoveryLine}`);
  const recoverySnapshot = oversizeCollector.snapshot();
  const recoveryPass = beforeRecovery.droppedOversizeLineCount === 1
    && beforeRecovery.diagnostics.some((item) => item.code === 'MAP_MAIN_TELEMETRY_OVERSIZE_LINE_DROPPED')
    && beforeRecovery.pendingLineChars === 0
    && beforeRecovery.discardingOversizeLine === true
    && recoverySnapshot.droppedOversizeLineCount === 1
    && recoverySnapshot.markerCount === 1
    && recoverySnapshot.summary?.recovered === true
    && recoverySnapshot.summary?.nativeTimingSummaryByPhase?.buckets?.direct?.summaryCount === 1
    && recoverySnapshot.discardingOversizeLine === false
    && recoverySnapshot.pendingLineChars === 0;

  return {
    maxLineChars: MAIN_MAP_TELEMETRY_MAX_LINE_CHARS,
    chunkSize,
    normal: {
      lineChars: largeLine.length,
      chunkCount: Math.ceil(largeLine.length / chunkSize),
      droppedOversizeLineCount: normalSnapshot.droppedOversizeLineCount,
      markerCount: normalSnapshot.markerCount,
      nativeBuckets: Object.keys(normalNative?.buckets ?? {}),
      pass: normalPass
    },
    oversizeRecovery: {
      bodyChars: oversizeBody.length,
      droppedOversizeLineCount: recoverySnapshot.droppedOversizeLineCount,
      diagnosticCodes: recoverySnapshot.diagnostics.map((item) => item.code),
      markerCount: recoverySnapshot.markerCount,
      recovered: recoverySnapshot.summary?.recovered === true,
      pass: recoveryPass
    },
    pass: normalPass && recoveryPass
  };
}

/**
 * 安装在 probe 所属 Electron main 进程中的只读 BrowserWindow 观测器。
 *
 * main-side IPC marker 只在 native 请求完成时采样，无法证明两个稀疏
 * call marker 之间窗口没有被隐藏/最小化。这里把 listener 直接装到与
 * probe page 对应的 BrowserWindow 上，并用 main 进程自己的 Date.now() 记录
 * 初始状态、show/hide/minimize/restore/closed 事件，以及 MAP total 边界的
 * start/end 快照。事件监听只读，不调用 show/restore，也不改变节流设置。
 */
async function installMapWindowObserver(app) {
  return app.evaluate(({ BrowserWindow }, options) => {
    const key = options?.key;
    const eventLimit = Number.isSafeInteger(options?.eventLimit) ? options.eventLimit : 1_024;
    if (typeof key !== 'string' || key.length === 0) {
      return { installed: false, reason: 'MAP_WINDOW_OBSERVER_KEY_INVALID' };
    }
    const prior = globalThis[key];
    if (prior && typeof prior.removeListeners === 'function') {
      try { prior.removeListeners(); } catch { /* stale probe observer */ }
    }

    const state = {
      installed: false,
      windowId: null,
      windowMissing: false,
      windowAmbiguous: false,
      windowClosed: false,
      unknownState: false,
      clockAnomaly: false,
      eventOverflow: false,
      eventLimit,
      events: [],
      lastClockMs: null,
      observationStart: null,
      observationEnd: null,
      measurement: { start: null, end: null },
      listeners: [],
      target: null,
      listenersRemoved: false
    };

    const readClock = () => {
      const atMs = Date.now();
      let atUTC = null;
      try { atUTC = new Date(atMs).toISOString(); } catch { atUTC = null; }
      if (!Number.isSafeInteger(atMs) || atUTC === null) state.clockAnomaly = true;
      if (Number.isSafeInteger(state.lastClockMs) && Number.isSafeInteger(atMs) && atMs < state.lastClockMs) {
        state.clockAnomaly = true;
      }
      if (Number.isSafeInteger(atMs)) state.lastClockMs = atMs;
      return { atMs: Number.isSafeInteger(atMs) ? atMs : null, atUTC };
    };

    const findTarget = () => {
      if (!Number.isInteger(state.windowId)) return null;
      try {
        const windows = BrowserWindow.getAllWindows?.() ?? [];
        return windows.find((window) => window?.id === state.windowId) ?? null;
      } catch {
        return null;
      }
    };

    const readBoolean = (target, method) => {
      try {
        return typeof target?.[method] === 'function' ? Boolean(target[method]()) : null;
      } catch {
        return null;
      }
    };

    const readWindowState = (eventName = null) => {
      const target = state.target ?? findTarget();
      if (!target || (typeof target.isDestroyed === 'function' && target.isDestroyed())) {
        state.windowMissing = true;
        if (eventName === 'closed') state.windowClosed = true;
        return { visible: null, minimized: null, focused: null };
      }
      let visible = readBoolean(target, 'isVisible');
      let minimized = readBoolean(target, 'isMinimized');
      const focused = readBoolean(target, 'isFocused');
      // Event semantics are conservative fallback evidence when a native query
      // races the transition. The other state field remains unknown if its
      // query cannot be read, so the final verdict still fails closed.
      if (eventName === 'hide' && visible === null) visible = false;
      if (eventName === 'show' && visible === null) visible = true;
      if (eventName === 'minimize' && minimized === null) minimized = true;
      if (eventName === 'restore' && minimized === null) minimized = false;
      // The transition event itself is authoritative evidence of a bad
      // foreground condition. A query racing the event can briefly report
      // the pre-transition state, so do not let it wash out hide/minimize.
      if (eventName === 'hide') visible = false;
      if (eventName === 'minimize') minimized = true;
      if (typeof visible !== 'boolean' || typeof minimized !== 'boolean') state.unknownState = true;
      return { visible, minimized, focused };
    };

    const pushEvent = (eventName, stateSnapshot = null) => {
      const clock = readClock();
      if (eventName === 'closed') state.windowClosed = true;
      if (state.events.length >= state.eventLimit) {
        state.eventOverflow = true;
        return null;
      }
      const entry = {
        event: eventName,
        atMs: clock.atMs,
        atUTC: clock.atUTC,
        state: stateSnapshot ?? readWindowState(eventName)
      };
      state.events.push(entry);
      return entry;
    };

    const removeListeners = () => {
      if (state.listenersRemoved) return true;
      const target = state.target;
      for (const listener of state.listeners) {
        try {
          target?.removeListener?.(listener.event, listener.handler);
        } catch {
          state.unknownState = true;
        }
      }
      state.listeners = [];
      state.listenersRemoved = true;
      return true;
    };

    const readStateSnapshot = (eventName) => {
      const clock = readClock();
      const snapshot = {
        event: eventName,
        atMs: clock.atMs,
        atUTC: clock.atUTC,
        state: readWindowState(eventName)
      };
      if (state.events.length >= state.eventLimit) {
        state.eventOverflow = true;
      } else {
        state.events.push(snapshot);
      }
      return snapshot;
    };

    const snapshot = () => ({
      version: 1,
      installed: state.installed,
      windowId: state.windowId,
      windowMissing: state.windowMissing,
      windowAmbiguous: state.windowAmbiguous,
      windowClosed: state.windowClosed,
      unknownState: state.unknownState,
      clockAnomaly: state.clockAnomaly,
      eventOverflow: state.eventOverflow,
      eventLimit: state.eventLimit,
      observationStart: state.observationStart,
      observationEnd: state.observationEnd,
      initial: state.events.find((entry) => entry.event === 'initial') ?? null,
      events: state.events.slice(),
      measurement: {
        start: state.measurement.start,
        end: state.measurement.end
      },
      complete: state.measurement.start !== null
        && state.measurement.end !== null
        && state.listenersRemoved,
      listenersRemoved: state.listenersRemoved
    });

    const observer = {
      mark(phase) {
        if (phase !== 'start' && phase !== 'end') {
          state.unknownState = true;
          return { ok: false, reason: `MAP_WINDOW_OBSERVER_PHASE_INVALID:${String(phase)}` };
        }
        const entry = readStateSnapshot(`measurement-${phase}`);
        if (phase === 'start') {
          state.measurement.start = entry;
          state.observationStart ??= {
            atMs: entry.atMs,
            atUTC: entry.atUTC
          };
        } else {
          state.measurement.end = entry;
          state.observationEnd = {
            atMs: entry.atMs,
            atUTC: entry.atUTC
          };
        }
        return { ok: true, snapshot: entry, observer: snapshot() };
      },
      finish() {
        if (state.measurement.end === null) {
          const entry = readStateSnapshot('measurement-end');
          state.measurement.end = entry;
          state.observationEnd = { atMs: entry.atMs, atUTC: entry.atUTC };
        }
        // The end snapshot is already stored in measurement.end; remove the
        // listeners only after that snapshot exists, then serialize the final
        // observer flags (including any cleanup error) for the verdict.
        removeListeners();
        const afterRemove = snapshot();
        const result = {
          ...afterRemove,
          complete: afterRemove.measurement.start !== null
            && afterRemove.measurement.end !== null
            && state.listenersRemoved,
          listenersRemoved: state.listenersRemoved
        };
        try { delete globalThis[key]; } catch { /* cleanup is best effort */ }
        return result;
      },
      removeListeners,
      snapshot
    };

    let target = null;
    let windows = [];
    try {
      windows = BrowserWindow.getAllWindows?.() ?? [];
      target = windows.length === 1 ? windows[0] : null;
    } catch {
      target = null;
      windows = [];
    }
    if (!target || !Number.isInteger(target.id)) {
      state.windowMissing = windows.length === 0;
      state.windowAmbiguous = windows.length !== 1 || !Number.isInteger(windows[0]?.id);
      state.observationStart = readClock();
      state.installed = true;
      globalThis[key] = observer;
      return snapshot();
    }
    state.target = target;
    state.windowId = target.id;
    state.observationStart = readClock();
    for (const event of ['show', 'hide', 'minimize', 'restore', 'closed']) {
      const handler = () => { pushEvent(event, readWindowState(event)); };
      try {
        target.on(event, handler);
        state.listeners.push({ event, handler });
      } catch {
        state.unknownState = true;
      }
    }
    state.installed = true;
    globalThis[key] = observer;
    readStateSnapshot('initial');
    return snapshot();
  }, { key: MAP_WINDOW_OBSERVER_KEY, eventLimit: MAP_WINDOW_OBSERVER_EVENT_LIMIT });
}

async function markMapWindowObserver(app, phase) {
  return app.evaluate((_electron, options) => {
    const observer = globalThis[options?.key];
    if (!observer || typeof observer.mark !== 'function') {
      return { ok: false, reason: 'MAP_WINDOW_OBSERVER_UNAVAILABLE' };
    }
    return observer.mark(options.phase);
  }, { key: MAP_WINDOW_OBSERVER_KEY, phase });
}

async function finishMapWindowObserver(app) {
  return app.evaluate((_electron, options) => {
    const observer = globalThis[options?.key];
    if (!observer || typeof observer.finish !== 'function') {
      return { complete: false, listenersRemoved: false, reason: 'MAP_WINDOW_OBSERVER_UNAVAILABLE' };
    }
    return observer.finish();
  }, { key: MAP_WINDOW_OBSERVER_KEY });
}

function isMapWindowStateKnown(state) {
  return Boolean(state)
    && typeof state.visible === 'boolean'
    && typeof state.minimized === 'boolean';
}

function isMapWindowStateBad(state) {
  return state?.visible === false || state?.minimized === true;
}

function evaluateMapForegroundConditions(observedWindow) {
  if (!observedWindow || typeof observedWindow !== 'object') {
    return {
      valid: false,
      verified: false,
      reason: 'OS window observation unavailable during MAP measurement'
    };
  }
  const measurement = observedWindow.measurement;
  const start = measurement?.start;
  const end = measurement?.end;
  const startAt = start?.atMs;
  const endAt = end?.atMs;
  const observationStartAt = observedWindow.observationStart?.atMs;
  const observationEndAt = observedWindow.observationEnd?.atMs;
  const commonInvalid = observedWindow.complete !== true
    || observedWindow.listenersRemoved !== true
    || observedWindow.windowMissing === true
    || observedWindow.windowAmbiguous === true
    || observedWindow.unknownState === true
    || observedWindow.clockAnomaly === true
    || observedWindow.eventOverflow === true
    || !Number.isSafeInteger(observedWindow.windowId)
    || !Number.isSafeInteger(startAt)
    || !Number.isSafeInteger(endAt)
    || !Number.isSafeInteger(observationStartAt)
    || !Number.isSafeInteger(observationEndAt)
    || endAt < startAt
    || observationStartAt > startAt
    || observationEndAt < endAt
    || !isMapWindowStateKnown(start?.state)
    || !isMapWindowStateKnown(end?.state);
  if (commonInvalid) {
    return {
      valid: false,
      verified: false,
      reason: 'OS window observation incomplete or unknown during MAP measurement'
    };
  }

  const events = Array.isArray(observedWindow.events) ? observedWindow.events : [];
  for (const event of events) {
    if (!Number.isSafeInteger(event?.atMs)) {
      return {
        valid: false,
        verified: false,
        reason: 'OS window event clock unavailable during MAP measurement'
      };
    }
  }
  const samples = [start, end, ...events.filter((event) => event.atMs >= startAt && event.atMs <= endAt)];
  if (samples.some((entry) => !isMapWindowStateKnown(entry?.state))) {
    return {
      valid: false,
      verified: false,
      reason: 'OS window state unavailable during open MAP measurement'
    };
  }
  if (observedWindow.windowClosed === true || samples.some((entry) => entry.event === 'closed')) {
    return {
      valid: false,
      verified: false,
      reason: 'OS MAP window closed during observation'
    };
  }
  if (samples.some((entry) => entry.event === 'hide' || entry.event === 'minimize' || isMapWindowStateBad(entry.state))) {
    return {
      valid: false,
      verified: true,
      reason: 'OS window not continuously visible/unminimized during MAP measurement'
    };
  }
  return {
    valid: true,
    verified: true,
    reason: 'OS window continuously visible/unminimized during MAP measurement'
  };
}

function summarizeTelemetrySamplingErrors(errors) {
  const summary = {
    total: 0,
    timeout: 0,
    inFlightSkip: 0,
    failed: 0,
    unknown: 0,
    legacyMessages: []
  };
  const legacyMessages = new Set();
  for (const entry of Array.isArray(errors) ? errors : []) {
    summary.total += 1;
    const status = typeof entry?.status === 'string' ? entry.status : '';
    const message = typeof entry?.message === 'string'
      ? entry.message
      : typeof entry?.reason === 'string' ? entry.reason : '';
    const legacy = status === '';
    if (legacy && message) legacyMessages.add(message);
    if (status === 'timeout' || entry?.timedOut === true || message === 'MAP_UI_TELEMETRY_SAMPLE_TIMEOUT') {
      summary.timeout += 1;
    } else if (
      status === 'pending-deadline'
      && (entry?.pendingCallId !== null && entry?.pendingCallId !== undefined
        || message.includes('IN_FLIGHT'))
    ) {
      summary.inFlightSkip += 1;
    } else if (status === 'failed' || entry?.failed === true) {
      summary.failed += 1;
    } else {
      summary.unknown += 1;
    }
  }
  summary.legacyMessages = [...legacyMessages].slice(0, 8);
  return summary;
}

function formatTelemetrySamplingIncompleteReason(summary) {
  const parts = [];
  if (summary.timeout > 0) parts.push(`${summary.timeout} timeout(s)`);
  if (summary.inFlightSkip > 0) parts.push(`${summary.inFlightSkip} in-flight skip(s)`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.unknown > 0) parts.push(`${summary.unknown} unknown`);
  if (summary.legacyMessages.length > 0) {
    parts.push(`legacy=${summary.legacyMessages.join('|')}`);
  }
  if (parts.length === 0) parts.push(`${summary.total} unknown`);
  return `telemetry sampling incomplete (${parts.join(', ')})`;
}

function finalizeMapStatus(report, mode = MODE) {
  const functionalLoadOk = Boolean(
    report.msb?.ok
    && report.geometry?.ok
    && (mode === 'cancel' ? report.cancellation?.cleanupEvents?.length > 0 : report.uiLoad?.complete)
  );
  const telemetry = report.renderer?.finalTelemetry ?? report.finalTelemetry ?? null;
  // Prefer the explicit MAP-open -> final delta.  This keeps an app-startup
  // long task from deciding the MAP result while still including the whole
  // mapCanvas/mount stage and the subsequent stream load.
  const mapDelta = report.mapTelemetry?.total?.available === true
    ? report.mapTelemetry.total
    : null;
  const raf = mapDelta?.raf ?? telemetry?.raf ?? null;
  const fixture = telemetry?.rafAccountingFixture ?? report.rafAccountingFixture ?? null;
  const maxLongTaskMs = mapDelta?.maxLongTaskMs ?? telemetry?.maxLongTaskMs;
  const maxLongTaskMsKnown = mapDelta ? mapDelta.maxLongTaskMsKnown !== false : true;
  const boundaryErrors = Array.isArray(mapDelta?.boundaryErrors) ? mapDelta.boundaryErrors : null;
  const boundaryCumulativeComplete = Boolean(
    mapDelta?.source === 'boundary-cumulative'
    && mapDelta?.boundaryName === 'total'
    && mapDelta?.closed === true
    && Number.isFinite(mapDelta?.startAt)
    && Number.isFinite(mapDelta?.endAt)
    && mapDelta.endAt >= mapDelta.startAt
    && boundaryErrors?.length === 0
    && Number.isFinite(raf?.frames)
    && raf.frames > 0
    && Number.isFinite(raf?.lastRafAt)
    && Number.isFinite(raf?.maxGapMs)
    && raf?.maxGapMsKnown === true
    && raf?.sampleCoverageComplete === true
    && mapDelta?.longTaskSamplesComplete === true
    && mapDelta?.maxLongTaskMsKnown === true
  );
  const metricsValid = Boolean(
    fixture?.pass === true
    && boundaryCumulativeComplete
    && Number.isFinite(raf?.lastRafAt)
    && Number.isFinite(maxLongTaskMs)
    && maxLongTaskMsKnown
    && typeof telemetry?.visibility?.currentState === 'string'
  );
  const telemetrySamplingSummary = summarizeTelemetrySamplingErrors(report.telemetrySamplingErrors);
  const sampleErrors = telemetrySamplingSummary.total;
  const foregroundLongGaps = Number(raf?.visibleLongGapCount ?? 0);
  const hiddenLongGaps = Number(raf?.hiddenLongGapCount ?? 0);
  const visibleStateKnown = telemetry?.visibility?.currentState === 'visible'
    || telemetry?.visibility?.currentState === 'hidden';
  const foregroundConditions = evaluateMapForegroundConditions(report.foregroundObservation?.observedWindow ?? null);
  report.foregroundObservation ??= {};
  report.foregroundObservation.verdict = foregroundConditions;
  // A zero-long-frame snapshot from an early/error path is not a successful
  // responsiveness verification.  Require the same completed functional load
  // and an error-free normal path that produced the snapshot.
  const responsivenessVerified = mode === 'normal'
    && functionalLoadOk
    && report.error === undefined
    && metricsValid
    && sampleErrors === 0
    && visibleStateKnown
    && foregroundConditions.valid === true
    && foregroundLongGaps === 0
    && maxLongTaskMs < 50;
  let responsivenessReason = 'normal load not completed';
  if (mode === 'cancel') {
    responsivenessReason = 'cancel mode intentionally stops before full-load responsiveness verification';
  } else if (!metricsValid) {
    responsivenessReason = 'telemetry boundary metrics incomplete or RAF accounting fixture failed';
  } else if (sampleErrors > 0) {
    responsivenessReason = formatTelemetrySamplingIncompleteReason(telemetrySamplingSummary);
  } else if (!visibleStateKnown) {
    responsivenessReason = 'document visibility state unavailable';
  } else if (foregroundConditions.valid !== true) {
    responsivenessReason = foregroundConditions.reason;
  } else if (foregroundLongGaps > 0 || maxLongTaskMs >= 50) {
    responsivenessReason = `foreground responsiveness degraded (${foregroundLongGaps} RAF gap(s) >=50ms; maxLongTaskMs=${maxLongTaskMs})`;
  } else if (hiddenLongGaps > 0) {
    responsivenessReason = `only hidden-tab RAF gap(s) observed (${hiddenLongGaps})`;
  } else {
    responsivenessReason = 'foreground RAF and long-task budgets passed';
  }
  report.status = {
    functionalLoadOk,
    metricsValid,
    responsivenessVerified,
    responsivenessPass: responsivenessVerified,
    responsivenessReason,
    documentVisibleLongGaps: foregroundLongGaps,
    foregroundConditionsValid: foregroundConditions.valid === true,
    foregroundConditionsVerified: foregroundConditions.verified === true,
    foregroundConditionsReason: foregroundConditions.reason,
    telemetrySampling: telemetrySamplingSummary,
    nativeCancellation: report.cancellation?.nativeAbortObserved === true ? 'observed' : 'unverified'
  };
  // Legacy process exit remains a functional-load result. Explicit status
  // fields prevent that exit code from being read as a performance PASS.
  report.ok = functionalLoadOk;
}

/**
 * 失败早退的负向 fixture：即便拿到一份零长帧快照，也不能把尚未完成的
 * UI load 误报为 responsiveness PASS。这个 fixture 只验证判定逻辑，不是
 * native/MAP 证据。
 */
function makeMapForegroundFixtureObservation({
  startState = { visible: true, minimized: false, focused: true },
  endState = startState,
  events = [],
  complete = true,
  listenersRemoved = true,
  windowMissing = false,
  windowClosed = false,
  unknownState = false,
  clockAnomaly = false,
  eventOverflow = false,
  startAt = 100,
  endAt = 200
} = {}) {
  const stateFor = (event, atMs, state) => ({
    event,
    atMs,
    atUTC: new Date(atMs).toISOString(),
    state
  });
  return {
    version: 1,
    installed: true,
    windowId: 7,
    windowMissing,
    windowClosed,
    unknownState,
    clockAnomaly,
    eventOverflow,
    eventLimit: MAP_WINDOW_OBSERVER_EVENT_LIMIT,
    observationStart: stateFor('observation-start', 0, { visible: true, minimized: false, focused: true }),
    observationEnd: stateFor('observation-end', 300, endState),
    initial: stateFor('initial', 1, { visible: true, minimized: false, focused: true }),
    events,
    measurement: {
      start: stateFor('measurement-start', startAt, startState),
      end: stateFor('measurement-end', endAt, endState)
    },
    complete,
    listenersRemoved
  };
}

/**
 * 不启动 Electron 的 observer integration fixture。fake app.evaluate 仍执行
 * 上面的真实 install/mark/finish 回调；mock window 只提供 BrowserWindow
 * 事件与查询方法，因此能覆盖 listener 生命周期和事件竞态，而不是只把
 * 一个预制的 observedWindow 对象喂给 judge。
 */
function makeMapWindowFixtureWindow(id) {
  const listeners = new Map();
  return {
    id,
    visible: true,
    minimized: false,
    focused: true,
    destroyed: false,
    on(event, handler) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
      return this;
    },
    removeListener(event, handler) {
      const handlers = listeners.get(event) ?? [];
      listeners.set(event, handlers.filter((candidate) => candidate !== handler));
      return this;
    },
    emit(event) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length;
    },
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    isFocused() { return this.focused; }
  };
}

function makeMapWindowFixtureApp(windows) {
  return {
    evaluate(callback, arg) {
      return callback({
        BrowserWindow: {
          getAllWindows: () => windows
        }
      }, arg);
    }
  };
}

async function runMapWindowObserverFixture() {
  const singleWindow = makeMapWindowFixtureWindow(71);
  const singleApp = makeMapWindowFixtureApp([singleWindow]);
  const installed = await installMapWindowObserver(singleApp);
  const started = await markMapWindowObserver(singleApp, 'start');
  // Keep the mock query at the pre-transition value. The actual event itself
  // must still latch the bad state.
  singleWindow.emit('minimize');
  singleWindow.emit('restore');
  const ended = await markMapWindowObserver(singleApp, 'end');
  const finished = await finishMapWindowObserver(singleApp);
  const frozenResult = JSON.stringify(finished);
  singleWindow.emit('closed');
  const postFinishUnchanged = JSON.stringify(finished) === frozenResult;
  const listenerEvents = ['show', 'hide', 'minimize', 'restore', 'closed'];
  const listenersRemoved = listenerEvents.every((event) => singleWindow.listenerCount(event) === 0);
  const singleVerdict = evaluateMapForegroundConditions(finished);

  const ambiguousWindows = [makeMapWindowFixtureWindow(81), makeMapWindowFixtureWindow(82)];
  const ambiguousApp = makeMapWindowFixtureApp(ambiguousWindows);
  const ambiguousInstalled = await installMapWindowObserver(ambiguousApp);
  const ambiguousStarted = await markMapWindowObserver(ambiguousApp, 'start');
  const ambiguousFinished = await finishMapWindowObserver(ambiguousApp);
  const ambiguousVerdict = evaluateMapForegroundConditions(ambiguousFinished);

  return {
    singleWindow: {
      installed: installed?.installed === true,
      startOk: started?.ok === true,
      endOk: ended?.ok === true,
      complete: finished?.complete === true,
      minimizeEventRecorded: finished?.events?.some((event) => event.event === 'minimize') === true,
      minimizeEventLatched: singleVerdict.valid === false && singleVerdict.verified === true,
      listenersRemoved,
      postFinishUnchanged,
      pass: installed?.installed === true
        && started?.ok === true
        && ended?.ok === true
        && finished?.complete === true
        && finished?.listenersRemoved === true
        && finished?.events?.some((event) => event.event === 'minimize') === true
        && singleVerdict.valid === false
        && singleVerdict.verified === true
        && listenersRemoved
        && postFinishUnchanged
    },
    ambiguousWindows: {
      installed: ambiguousInstalled?.installed === true,
      windowAmbiguous: ambiguousFinished?.windowAmbiguous === true,
      startOk: ambiguousStarted?.ok === true,
      foregroundConditionsValid: ambiguousVerdict.valid,
      foregroundConditionsVerified: ambiguousVerdict.verified,
      pass: ambiguousFinished?.windowAmbiguous === true
        && ambiguousVerdict.valid === false
        && ambiguousVerdict.verified === false
    },
    pass: installed?.installed === true
      && started?.ok === true
      && ended?.ok === true
      && finished?.complete === true
      && finished?.listenersRemoved === true
      && singleVerdict.valid === false
      && singleVerdict.verified === true
      && listenersRemoved
      && postFinishUnchanged
      && ambiguousFinished?.windowAmbiguous === true
      && ambiguousVerdict.valid === false
      && ambiguousVerdict.verified === false
  };
}

function runMapStatusFixture() {
  const completeMapDelta = {
    available: true,
    source: 'boundary-cumulative',
    boundaryName: 'total',
    closed: true,
    startAt: 0,
    endAt: 100,
    boundaryErrors: [],
    maxLongTaskMs: 0,
    maxLongTaskMsKnown: true,
    longTaskSamplesComplete: true,
    raf: {
      frames: 8,
      lastRafAt: 100,
      maxGapMs: 16,
      maxGapMsKnown: true,
      sampleCoverageComplete: true,
      visibleLongGapCount: 0,
      hiddenLongGapCount: 0
    }
  };
  const makeReport = (overrides = {}) => ({
    msb: { ok: true },
    geometry: { ok: true },
    uiLoad: { complete: true },
    renderer: {
      finalTelemetry: {
        raf: {
          lastRafAt: 100,
          maxGapMs: 16,
          visibleLongGapCount: 0,
          hiddenLongGapCount: 0
        },
        rafAccountingFixture: { pass: true },
        maxLongTaskMs: 0,
        visibility: { currentState: 'visible' }
      }
    },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation()
    },
    ...overrides
  });
  const report = makeReport({ uiLoad: { complete: false } });
  finalizeMapStatus(report, 'normal');
  const timeoutSamplingErrors = [
    {
      elapsedMs: 1_000,
      message: 'MAP_UI_TELEMETRY_SAMPLE_TIMEOUT',
      status: 'timeout',
      callId: 57,
      pendingCallId: null,
      timedOut: true,
      lateSettled: false,
      failed: false,
      pendingDeadline: false,
      error: null
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      elapsedMs: 1_015 + index,
      message: 'MAP_UI_TELEMETRY_SAMPLE_IN_FLIGHT',
      status: 'pending-deadline',
      callId: null,
      pendingCallId: 57,
      timedOut: false,
      lateSettled: false,
      failed: false,
      pendingDeadline: true,
      error: null
    })),
    {
      elapsedMs: 2_000,
      message: 'MAP_UI_TELEMETRY_SAMPLE_TIMEOUT',
      status: 'timeout',
      callId: 92,
      pendingCallId: null,
      timedOut: true,
      lateSettled: false,
      failed: false,
      pendingDeadline: false,
      error: null
    }
  ];
  const timeoutReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    telemetrySamplingErrors: timeoutSamplingErrors
  });
  finalizeMapStatus(timeoutReport, 'normal');
  const legacySamplingReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    telemetrySamplingErrors: [{ phase: 'fixture', message: 'LEGACY_SAMPLE_ERROR' }]
  });
  finalizeMapStatus(legacySamplingReport, 'normal');
  // A legacy diff can look clean when only the final 2,000-frame tail was
  // retained. It must never satisfy the new cumulative-boundary gate.
  const legacyTailReport = makeReport({
    mapTelemetry: {
      total: {
        available: true,
        source: 'legacy-ring-debug',
        maxLongTaskMs: 0,
        maxLongTaskMsKnown: true,
        longTaskSamplesComplete: true,
        raf: {
          frames: 2_105,
          lastRafAt: 33_664,
          maxGapMs: 16,
          maxGapMsKnown: false,
          sampleCoverageComplete: false,
          visibleLongGapCount: 0,
          hiddenLongGapCount: 0
        }
      }
    }
  });
  finalizeMapStatus(legacyTailReport, 'normal');
  const completeReport = makeReport({ mapTelemetry: { total: completeMapDelta } });
  finalizeMapStatus(completeReport, 'normal');
  const focusOnlyReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({
        startState: { visible: true, minimized: false, focused: false },
        endState: { visible: true, minimized: false, focused: false }
      })
    }
  });
  finalizeMapStatus(focusOnlyReport, 'normal');
  const hiddenThenRestoredReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({
        events: [
          {
            event: 'hide',
            atMs: 140,
            atUTC: new Date(140).toISOString(),
            state: { visible: false, minimized: false, focused: false }
          },
          {
            event: 'show',
            atMs: 160,
            atUTC: new Date(160).toISOString(),
            state: { visible: true, minimized: false, focused: true }
          }
        ]
      })
    }
  });
  finalizeMapStatus(hiddenThenRestoredReport, 'normal');
  const minimizedThenRestoredReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({
        events: [
          {
            event: 'minimize',
            atMs: 140,
            atUTC: new Date(140).toISOString(),
            state: { visible: true, minimized: true, focused: false }
          },
          {
            event: 'restore',
            atMs: 160,
            atUTC: new Date(160).toISOString(),
            state: { visible: true, minimized: false, focused: true }
          }
        ]
      })
    }
  });
  finalizeMapStatus(minimizedThenRestoredReport, 'normal');
  const openUnknownReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({
        events: [{
          event: 'hide',
          atMs: 140,
          atUTC: new Date(140).toISOString(),
          state: { visible: null, minimized: null, focused: null }
        }]
      })
    }
  });
  finalizeMapStatus(openUnknownReport, 'normal');
  const postCloseUnknownReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({
        events: [{
          event: 'closed',
          atMs: 250,
          atUTC: new Date(250).toISOString(),
          state: { visible: null, minimized: null, focused: null }
        }]
      })
    }
  });
  finalizeMapStatus(postCloseUnknownReport, 'normal');
  const a369LikeReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({
        events: [{
          event: 'hide',
          atMs: 132,
          atUTC: new Date(132).toISOString(),
          state: { visible: false, minimized: true, focused: false }
        }]
      })
    }
  });
  finalizeMapStatus(a369LikeReport, 'normal');
  const insufficientReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({ complete: false, listenersRemoved: false })
    }
  });
  finalizeMapStatus(insufficientReport, 'normal');
  const overflowReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({ eventOverflow: true })
    }
  });
  finalizeMapStatus(overflowReport, 'normal');
  const missingWindowReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({ windowMissing: true })
    }
  });
  finalizeMapStatus(missingWindowReport, 'normal');
  const clockAnomalyReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: {
      observedWindow: makeMapForegroundFixtureObservation({ clockAnomaly: true })
    }
  });
  finalizeMapStatus(clockAnomalyReport, 'normal');
  const noObservationReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    foregroundObservation: { observedWindow: null }
  });
  finalizeMapStatus(noObservationReport, 'normal');
  return {
    incompleteLoad: {
      responsivenessVerified: report.status.responsivenessVerified,
      pass: report.status.responsivenessVerified === false
    },
    timeout: {
      responsivenessVerified: timeoutReport.status.responsivenessVerified,
      responsivenessReason: timeoutReport.status.responsivenessReason,
      samplingSummary: timeoutReport.status.telemetrySampling,
      pass: timeoutReport.status.responsivenessVerified === false
        && timeoutReport.status.responsivenessReason === 'telemetry sampling incomplete (2 timeout(s), 19 in-flight skip(s))'
    },
    legacySampling: {
      responsivenessReason: legacySamplingReport.status.responsivenessReason,
      samplingSummary: legacySamplingReport.status.telemetrySampling,
      pass: legacySamplingReport.status.responsivenessReason.includes('unknown')
        && legacySamplingReport.status.responsivenessReason.includes('legacy=LEGACY_SAMPLE_ERROR')
    },
    legacyTail: {
      responsivenessVerified: legacyTailReport.status.responsivenessVerified,
      metricsValid: legacyTailReport.status.metricsValid,
      pass: legacyTailReport.status.responsivenessVerified === false
        && legacyTailReport.status.metricsValid === false
    },
    completeBoundary: {
      responsivenessVerified: completeReport.status.responsivenessVerified,
      metricsValid: completeReport.status.metricsValid,
      pass: completeReport.status.responsivenessVerified === true
        && completeReport.status.metricsValid === true
    },
    focusOnly: {
      foregroundConditionsValid: focusOnlyReport.status.foregroundConditionsValid,
      responsivenessVerified: focusOnlyReport.status.responsivenessVerified,
      pass: focusOnlyReport.status.foregroundConditionsValid === true
        && focusOnlyReport.status.responsivenessVerified === true
    },
    hiddenThenRestored: {
      foregroundConditionsValid: hiddenThenRestoredReport.status.foregroundConditionsValid,
      metricsValid: hiddenThenRestoredReport.status.metricsValid,
      pass: hiddenThenRestoredReport.status.foregroundConditionsValid === false
        && hiddenThenRestoredReport.status.foregroundConditionsVerified === true
        && hiddenThenRestoredReport.status.metricsValid === true
    },
    minimizedThenRestored: {
      foregroundConditionsValid: minimizedThenRestoredReport.status.foregroundConditionsValid,
      pass: minimizedThenRestoredReport.status.foregroundConditionsValid === false
        && minimizedThenRestoredReport.status.foregroundConditionsVerified === true
    },
    openUnknown: {
      foregroundConditionsValid: openUnknownReport.status.foregroundConditionsValid,
      foregroundConditionsVerified: openUnknownReport.status.foregroundConditionsVerified,
      pass: openUnknownReport.status.foregroundConditionsValid === false
        && openUnknownReport.status.foregroundConditionsVerified === false
    },
    postCloseUnknown: {
      foregroundConditionsValid: postCloseUnknownReport.status.foregroundConditionsValid,
      foregroundConditionsVerified: postCloseUnknownReport.status.foregroundConditionsVerified,
      pass: postCloseUnknownReport.status.foregroundConditionsValid === true
        && postCloseUnknownReport.status.foregroundConditionsVerified === true
    },
    a369Like: {
      foregroundConditionsValid: a369LikeReport.status.foregroundConditionsValid,
      metricsValid: a369LikeReport.status.metricsValid,
      pass: a369LikeReport.status.foregroundConditionsValid === false
        && a369LikeReport.status.foregroundConditionsVerified === true
        && a369LikeReport.status.metricsValid === true
    },
    insufficientWindow: {
      foregroundConditionsValid: insufficientReport.status.foregroundConditionsValid,
      foregroundConditionsVerified: insufficientReport.status.foregroundConditionsVerified,
      pass: insufficientReport.status.foregroundConditionsValid === false
        && insufficientReport.status.foregroundConditionsVerified === false
    },
    observerIntegrity: {
      overflow: {
        foregroundConditionsVerified: overflowReport.status.foregroundConditionsVerified,
        pass: overflowReport.status.foregroundConditionsVerified === false
      },
      windowMissing: {
        foregroundConditionsVerified: missingWindowReport.status.foregroundConditionsVerified,
        pass: missingWindowReport.status.foregroundConditionsVerified === false
      },
      clockAnomaly: {
        foregroundConditionsVerified: clockAnomalyReport.status.foregroundConditionsVerified,
        pass: clockAnomalyReport.status.foregroundConditionsVerified === false
      },
      noObservation: {
        foregroundConditionsVerified: noObservationReport.status.foregroundConditionsVerified,
        pass: noObservationReport.status.foregroundConditionsVerified === false
      },
      pass: overflowReport.status.foregroundConditionsVerified === false
        && missingWindowReport.status.foregroundConditionsVerified === false
        && clockAnomalyReport.status.foregroundConditionsVerified === false
        && noObservationReport.status.foregroundConditionsVerified === false
    },
    pass: report.status.responsivenessVerified === false
      && timeoutReport.status.responsivenessVerified === false
      && timeoutReport.status.responsivenessReason === 'telemetry sampling incomplete (2 timeout(s), 19 in-flight skip(s))'
      && legacySamplingReport.status.responsivenessReason.includes('legacy=LEGACY_SAMPLE_ERROR')
      && legacyTailReport.status.responsivenessVerified === false
      && legacyTailReport.status.metricsValid === false
      && completeReport.status.responsivenessVerified === true
      && focusOnlyReport.status.responsivenessVerified === true
      && hiddenThenRestoredReport.status.foregroundConditionsVerified === true
      && minimizedThenRestoredReport.status.foregroundConditionsVerified === true
      && openUnknownReport.status.foregroundConditionsVerified === false
      && postCloseUnknownReport.status.foregroundConditionsValid === true
      && a369LikeReport.status.foregroundConditionsVerified === true
      && a369LikeReport.status.metricsValid === true
      && insufficientReport.status.foregroundConditionsVerified === false
      && overflowReport.status.foregroundConditionsVerified === false
      && missingWindowReport.status.foregroundConditionsVerified === false
      && clockAnomalyReport.status.foregroundConditionsVerified === false
      && noObservationReport.status.foregroundConditionsVerified === false
  };
}

function runProductionMapTimingSummaryFixture() {
  const moduleUrl = new URL('../apps/desktop/src/main/mapTimingTelemetry.ts', import.meta.url).href;
  const childSource = String.raw`
import {
  MAP_NATIVE_TIMING_CODE,
  beginMapNativeTimingSession,
  clearMapNativeTimingSession,
  recordMapNativeTiming
} from ${JSON.stringify(moduleUrl)};

const diagnostic = (details) => [{ code: MAP_NATIVE_TIMING_CODE, details }];
const key = 'map-streaming-native-fixture';
beginMapNativeTimingSession(key);
let first = null;
let continuation = null;
for (let index = 0; index < 32; index += 1) {
  const queueWaitMs = index < 16 ? 85 + index : 185 + (index - 16);
  const details = {
    schemaVersion: 1,
    unit: 'ms',
    queueWaitMs,
    totalMs: queueWaitMs + 12
  };
  if (index === 0) details.flverReadMs = 12;
  else details.unavailablePhases = ['flverReadMs'];
  const summary = recordMapNativeTiming(key, diagnostic(details));
  if (!summary) throw new Error('production timing summary missing');
  if (index === 0) first = summary.details;
  continuation = summary.details;
}
clearMapNativeTimingSession(key);
console.log(JSON.stringify({ first, continuation }));
`;
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    childSource
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000
  });
  if (result.error || result.status !== 0) {
    return {
      pass: false,
      error: result.error?.message ?? result.stderr?.trim() ?? `child exited with ${result.status}`,
      first: null,
      continuation: null
    };
  }
  const line = result.stdout
    .trim()
    .split(/\r?\n/)
    .findLast((item) => item.trim().startsWith('{'));
  if (!line) {
    return { pass: false, error: 'production timing fixture returned no JSON', first: null, continuation: null };
  }
  try {
    const output = JSON.parse(line);
    const first = output.first ?? null;
    const continuation = output.continuation ?? null;
    return {
      pass: first?.requestCount === 1
        && continuation?.requestCount === 32
        && continuation?.phases?.queueWaitMs?.count === 32
        && continuation?.phases?.queueWaitMs?.totalMs === 4560
        && continuation?.phases?.queueWaitMs?.topSlowMs?.length === 16
        && continuation?.phases?.queueWaitMs?.topSlowMs?.[0] === 200
        && continuation?.phases?.queueWaitMs?.topSlowMs?.at(-1) === 185
        && continuation?.phases?.flverReadMs?.count === 1
        && continuation?.unavailablePhases?.includes('flverReadMs') === true,
      first,
      continuation,
      error: null
    };
  } catch (error) {
    return {
      pass: false,
      error: error instanceof Error ? error.message : String(error),
      first: null,
      continuation: null
    };
  }
}

async function runMapMainTimingPhaseFixture() {
  const hadOriginal = Object.prototype.hasOwnProperty.call(globalThis, MAP_MAIN_TIMING_PHASE_KEY);
  const original = globalThis[MAP_MAIN_TIMING_PHASE_KEY];
  const transitions = [];
  let setterCalls = 0;
  let currentPhase = 'outside';
  const control = {
    setPhase(nextPhase) {
      setterCalls += 1;
      currentPhase = nextPhase;
      transitions.push(nextPhase);
      return { ok: true, phase: nextPhase };
    },
    snapshot() {
      return { phase: currentPhase };
    }
  };
  const app = {
    evaluate(callback, arg) {
      // ElectronApplication.evaluate supplies the Electron module first and
      // the caller argument second. Keeping both positions here catches a
      // probe callback that accidentally reads the module as `options`.
      return callback({ fixtureElectron: true }, arg);
    }
  };
  globalThis[MAP_MAIN_TIMING_PHASE_KEY] = control;
  try {
    const phases = ['direct', 'ui-load', 'done'];
    const results = [];
    for (const phase of phases) results.push(await setMainMapTimingPhase(app, phase));
    return {
      phases,
      results,
      transitions,
      setterCalls,
      finalPhase: currentPhase,
      pass: results.every((result, index) => result?.ok === true && result.phase === phases[index])
        && transitions.join('|') === phases.join('|')
        && setterCalls === phases.length
        && currentPhase === 'done'
    };
  } catch (error) {
    return {
      phases: ['direct', 'ui-load', 'done'],
      results: [],
      transitions,
      setterCalls,
      finalPhase: currentPhase,
      pass: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (hadOriginal) globalThis[MAP_MAIN_TIMING_PHASE_KEY] = original;
    else delete globalThis[MAP_MAIN_TIMING_PHASE_KEY];
  }
}

function runMapNativeTimingAggregationFixture() {
  const productionContract = runProductionMapTimingSummaryFixture();
  const phase = (count, totalMs, minMs, maxMs, topSlowMs) => ({
    count,
    totalMs,
    minMs,
    maxMs,
    topSlowMs
  });
  const makeSummary = ({ requestCount, unavailablePhases = [], phases }) => ({
    schemaVersion: 1,
    unit: 'ms',
    requestCount,
    unavailablePhases,
    phases
  });
  const directSummaryA = makeSummary({
    requestCount: 2,
    phases: {
      queueWaitMs: phase(16, 1480, 85, 100, Array.from({ length: 16 }, (_, index) => 100 - index)),
      flverReadMs: phase(1, 12, 12, 12, [12])
    }
  });
  const directSummaryB = makeSummary({
    requestCount: 3,
    unavailablePhases: ['flverReadMs'],
    phases: {
      queueWaitMs: phase(16, 3080, 185, 200, Array.from({ length: 16 }, (_, index) => 200 - index)),
      // Production main keeps the phase aggregate from earlier pages while
      // the session-wide unavailable union also contains this phase.
      flverReadMs: phase(1, 12, 12, 12, [12])
    }
  });
  const uiSummary = makeSummary({
    requestCount: 4,
    phases: {
      queueWaitMs: phase(1, 4, 4, 4, [4]),
      totalMs: phase(1, 20, 20, 20, [20])
    }
  });

  const aggregate = createMapNativeTimingAccumulator();
  // Capture the phase at request start.  The simulated current phase changes
  // before the in-flight request resolves; recording still uses direct.
  const requestStartPhase = 'direct';
  let currentPhase = requestStartPhase;
  const directA = recordMapNativeTimingCall(aggregate, requestStartPhase, directSummaryA);
  currentPhase = 'ui-load';
  const directInFlight = recordMapNativeTimingCall(aggregate, requestStartPhase, directSummaryB);
  const ui = recordMapNativeTimingCall(aggregate, currentPhase, uiSummary);

  const invalidSchema = recordMapNativeTimingCall(
    aggregate,
    'ui-load',
    { ...uiSummary, schemaVersion: 2 }
  );
  const invalidUnit = recordMapNativeTimingCall(
    aggregate,
    'ui-load',
    { ...uiSummary, unit: 'seconds' }
  );
  const invalidPhase = recordMapNativeTimingCall(
    aggregate,
    'ui-load',
    { ...uiSummary, phases: { unknownMs: phase(1, 1, 1, 1, [1]) } }
  );
  const invalidNumber = recordMapNativeTimingCall(
    aggregate,
    'ui-load',
    { ...uiSummary, phases: { queueWaitMs: phase(1, Number.POSITIVE_INFINITY, 1, 1, [1]) } }
  );
  const noSummary = recordMapNativeTimingCall(aggregate, 'ui-load', null);
  const snapshot = snapshotMapNativeTimingAccumulator(aggregate);
  const direct = snapshot.buckets.direct;
  const uiBucket = snapshot.buckets['ui-load'];
  const queue = direct.phases.queueWaitMs;
  const flverCoverage = direct.coverage.phaseCoverage.flverReadMs;
  const invalidReasons = [
    invalidSchema.reason,
    invalidUnit.reason,
    invalidPhase.reason,
    invalidNumber.reason
  ];
  const pass = directA.accepted === true
    && directInFlight.accepted === true
    && ui.accepted === true
    && direct.callCount === 2
    && direct.summaryCount === 2
    && direct.requestCount === 5
    && uiBucket.callCount === 6
    && uiBucket.summaryCount === 1
    && uiBucket.requestCount === 4
    && uiBucket.callsWithoutSummary === 1
    && uiBucket.invalidSummaryCount === 4
    && invalidReasons.every((reason) => typeof reason === 'string')
    && queue.count === 32
    && queue.totalMs === 4560
    && queue.minMs === 85
    && queue.maxMs === 200
    && queue.topSlowMs.length === 16
    && queue.topSlowMs[0] === 200
    && queue.topSlowMs.at(-1) === 185
    && flverCoverage.coverage === 'partial-coverage'
    && flverCoverage.observedSummaryCount === 2
    && flverCoverage.unavailableSummaryCount === 1
    && direct.coverage.partialUnavailablePhases.includes('flverReadMs')
    && !direct.coverage.unavailablePhases.includes('flverReadMs')
    && uiBucket.coverage.status === 'partial-coverage';

  const noObservationAccumulator = createMapNativeTimingAccumulator();
  recordMapNativeTimingCall(noObservationAccumulator, 'ui-load', null);
  const noObservation = snapshotMapNativeTimingAccumulator(noObservationAccumulator).buckets['ui-load'];
  const noObservationPass = noObservation.summaryCount === 0
    && noObservation.callCount === 1
    && noObservation.callsWithoutSummary === 1
    && noObservation.coverage.status === 'no-observations'
    && noObservation.coverage.unavailablePhases.length === 0
    && noObservation.coverage.phaseCoverage.queueWaitMs.coverage === 'no-observations';

  const productionAccumulator = createMapNativeTimingAccumulator();
  const productionRecord = recordMapNativeTimingCall(
    productionAccumulator,
    'direct',
    productionContract.continuation
  );
  const productionBucket = snapshotMapNativeTimingAccumulator(productionAccumulator).buckets.direct;
  const productionFlverCoverage = productionBucket.coverage.phaseCoverage.flverReadMs;
  const productionPass = productionContract.pass
    && productionRecord.accepted === true
    && productionBucket.requestCount === 32
    && productionBucket.phases.queueWaitMs.count === 32
    && productionBucket.phases.queueWaitMs.totalMs === 4560
    && productionBucket.phases.queueWaitMs.topSlowMs.length === 16
    && productionFlverCoverage.observedSummaryCount === 1
    && productionFlverCoverage.unavailableSummaryCount === 1
    && productionFlverCoverage.coverage === 'partial-coverage';

  return {
    directUiIsolation: {
      directCallCount: direct.callCount,
      directSummaryCount: direct.summaryCount,
      directRequestCount: direct.requestCount,
      uiCallCount: uiBucket.callCount,
      uiSummaryCount: uiBucket.summaryCount,
      uiRequestCount: uiBucket.requestCount,
      inFlightResolvedTo: requestStartPhase,
      pass: direct.callCount === 2 && uiBucket.summaryCount === 1 && requestStartPhase === 'direct'
    },
    validation: {
      invalidReasons,
      invalidSummaryCount: uiBucket.invalidSummaryCount,
      pass: invalidReasons.every((reason) => typeof reason === 'string') && uiBucket.invalidSummaryCount === 4
    },
    aggregation: {
      queue,
      flverCoverage,
      topSlowBound: queue.topSlowMs.length <= 16,
      pass: pass
    },
    noObservations: {
      bucket: noObservation,
      pass: noObservationPass
    },
    productionContract: {
      firstRequestCount: productionContract.first?.requestCount ?? null,
      continuationRequestCount: productionContract.continuation?.requestCount ?? null,
      continuationUnavailablePhases: productionContract.continuation?.unavailablePhases ?? [],
      continuationFlverCount: productionContract.continuation?.phases?.flverReadMs?.count ?? null,
      helperFlverCoverage: productionFlverCoverage,
      error: productionContract.error ?? null,
      pass: productionPass
    },
    pass: pass && noObservationPass && productionPass
  };
}

function runCharacterNativeTimingAggregationFixture() {
  const phase = (totalMs, scopeCount = 1) => ({
    count: 1,
    scopeCount,
    totalMs,
    minMs: totalMs,
    maxMs: totalMs,
    topSlowMs: [totalMs]
  });
  const summary = {
    schemaVersion: 1,
    unit: 'ms',
    requestCount: 1,
    unavailablePhases: [],
    phases: {
      queueWaitMs: phase(2),
      resolveFlverLeavesMs: phase(8),
      flverReadMs: phase(4),
      texturePackageResolveMs: phase(12),
      texturePreviewMs: phase(31, 2),
      materialResolveMs: phase(17, 2),
      buildOutputMs: phase(9, 2),
      totalMs: phase(85)
    }
  };
  const accumulator = createCharacterNativeTimingAccumulator();
  const first = recordCharacterNativeTimingCall(accumulator, 'ui-load', summary, 143);
  // Cached continuation and repeated first-page replay are IPC calls, but
  // neither carries the first native summary and therefore must not add a
  // second native request or main-wall sample.
  const continuation = recordCharacterNativeTimingCall(accumulator, 'ui-load', null, 7);
  const repeatedFirstPage = recordCharacterNativeTimingCall(accumulator, 'ui-load', null, 11);
  const bucket = snapshotCharacterNativeTimingAccumulator(accumulator).buckets['ui-load'];
  const malformed = [
    { ...summary, requestCount: 0 },
    { ...summary, phases: {} },
    { ...summary, phases: { ...summary.phases, totalMs: undefined } },
    { ...summary, unavailablePhases: ['texturePreviewMs'] },
    { ...summary, unavailablePhases: ['queueWaitMs'] },
    { ...summary, phases: { ...summary.phases, texturePreviewMs: { ...summary.phases.texturePreviewMs, count: 2 } } }
  ].map((candidate) => validateCharacterNativeTimingSummary(candidate));
  const pass = first.accepted === true
    && continuation.accepted === false
    && repeatedFirstPage.accepted === false
    && bucket.ipcCallCount === 3
    && bucket.nativeRequestCount === 1
    && bucket.nativeTotalMs === 85
    && bucket.mainWallMs.requestCount === 1
    && bucket.mainWallMs.totalMs === 143
    && bucket.phases.texturePreviewMs.count === 1
    && bucket.phases.texturePreviewMs.scopeCount === 2
    && bucket.phases.materialResolveMs.count === 1
    && bucket.phases.materialResolveMs.scopeCount === 2
    && bucket.phases.buildOutputMs.count === 1
    && bucket.phases.buildOutputMs.scopeCount === 2
    && bucket.callsWithoutSummary === 2
    && malformed.every((result) => result.ok === false);
  return {
    firstRequestCount: bucket.nativeRequestCount,
    ipcCallCount: bucket.ipcCallCount,
    nativeTotalMs: bucket.nativeTotalMs,
    mainWallMs: bucket.mainWallMs,
    phases: {
      texturePreviewMs: bucket.phases.texturePreviewMs,
      materialResolveMs: bucket.phases.materialResolveMs,
      buildOutputMs: bucket.phases.buildOutputMs
    },
    malformedReasons: malformed.map((result) => result.reason),
    pass
  };
}

function runCharacterMainTimingAggregationFixture() {
  const phases = [
    'optionsPrepareMs',
    'bridgeAwaitMs',
    'bundleValidateMs',
    'compatibilityMs',
    'chunkBuildMs',
    'pageFirstMs',
    'totalMs'
  ];
  const measured = (totalMs) => ({
    count: 1,
    totalMs,
    minMs: totalMs,
    maxMs: totalMs,
    topSlowMs: [totalMs]
  });
  const empty = () => ({ count: 0, totalMs: 0, minMs: null, maxMs: null, topSlowMs: [] });
  const makeSummary = ({ outcome = 'ok', compatibilityStatus = 'skipped' } = {}) => ({
    schemaVersion: 1,
    unit: 'ms',
    requestCount: 1,
    outcome,
    phaseOrder: phases,
    unavailablePhases: outcome === 'failed'
      ? ['compatibilityMs', 'chunkBuildMs', 'pageFirstMs']
      : [],
    skippedPhases: outcome === 'failed'
      ? []
      : compatibilityStatus === 'skipped' ? ['compatibilityMs'] : [],
    phaseStatus: {
      optionsPrepareMs: outcome === 'failed' ? 'measured' : 'measured',
      bridgeAwaitMs: 'measured',
      bundleValidateMs: 'measured',
      compatibilityMs: outcome === 'failed' ? 'unavailable' : compatibilityStatus,
      chunkBuildMs: outcome === 'failed' ? 'unavailable' : 'measured',
      pageFirstMs: outcome === 'failed' ? 'unavailable' : 'measured',
      totalMs: 'measured'
    },
    phases: {
      optionsPrepareMs: measured(2),
      bridgeAwaitMs: measured(85),
      bundleValidateMs: measured(1),
      compatibilityMs: compatibilityStatus === 'measured' ? measured(14) : empty(),
      chunkBuildMs: outcome === 'failed' ? empty() : measured(10),
      pageFirstMs: outcome === 'failed' ? empty() : measured(3),
      totalMs: measured(outcome === 'failed' ? 90 : 118)
    }
  });
  const accumulator = createCharacterMainTimingAccumulator();
  const first = recordCharacterMainTimingCall(accumulator, 'ui-load', makeSummary(), 143);
  const failed = recordCharacterMainTimingCall(
    accumulator,
    'ui-load',
    makeSummary({ outcome: 'failed' }),
    97
  );
  const continuation = recordCharacterMainTimingCall(accumulator, 'ui-load', null, 7);
  const bucket = snapshotCharacterMainTimingAccumulator(accumulator).buckets['ui-load'];
  const malformed = [
    { ...makeSummary(), schemaVersion: 2 },
    { ...makeSummary(), phaseStatus: { ...makeSummary().phaseStatus, compatibilityMs: 'measured' } },
    { ...makeSummary(), phases: { ...makeSummary().phases, totalMs: empty() } },
    { ...makeSummary(), unavailablePhases: ['compatibilityMs'], skippedPhases: ['compatibilityMs'] }
  ].map((candidate) => validateCharacterMainTimingSummary(candidate));
  const pass = first.accepted === true
    && failed.accepted === true
    && continuation.accepted === false
    && bucket.ipcCallCount === 3
    && bucket.requestCount === 2
    && bucket.summarySeenCount === 2
    && bucket.callsWithoutSummary === 1
    && bucket.totalMs === 208
    && bucket.mainWallMs.requestCount === 2
    && bucket.mainWallMs.totalMs === 240
    && bucket.mainWallMs.minMs === 97
    && bucket.mainWallMs.maxMs === 143
    && bucket.phases.bridgeAwaitMs.count === 2
    && bucket.phases.compatibilityMs.count === 0
    && bucket.phaseCoverage.compatibilityMs.skippedSummaryCount === 1
    && bucket.phaseCoverage.compatibilityMs.unavailableSummaryCount === 1
    && malformed.every((result) => result.ok === false);
  return {
    requestCount: bucket.requestCount,
    ipcCallCount: bucket.ipcCallCount,
    callsWithoutSummary: bucket.callsWithoutSummary,
    mainWallMs: bucket.mainWallMs,
    compatibilityCoverage: bucket.phaseCoverage.compatibilityMs,
    malformedReasons: malformed.map((result) => result.reason),
    pass
  };
}

async function runMapTelemetrySingleFlightFixture() {
  let active = 0;
  let maxActive = 0;
  let startedTasks = 0;
  const track = async (task) => {
    active += 1;
    startedTasks += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await task();
    } finally {
      active -= 1;
    }
  };
  const sampler = createSingleFlightBounded('map-telemetry-fixture');
  const normalTiming = {
    pageStartedAtUTC: 10_000,
    pageCompletedAtUTC: 10_006,
    pageStartedAt: 100,
    pageCompletedAt: 106,
    pageDurationMs: 6
  };
  const lateFulfilledTiming = {
    pageStartedAtUTC: 20_000,
    pageCompletedAtUTC: 20_012,
    pageStartedAt: 200,
    pageCompletedAt: 212,
    pageDurationMs: 12
  };
  const invalidTiming = {
    pageStartedAtUTC: 30_000,
    pageCompletedAtUTC: 30_010,
    pageStartedAt: 300,
    pageCompletedAt: 310,
    pageDurationMs: 999
  };
  let resolveLateTask;
  const lateTask = new Promise((resolve) => { resolveLateTask = resolve; });
  const first = await sampler.run(
    () => track(() => lateTask),
    {
    timeoutMs: 10,
    timeoutCode: 'MAP_UI_TELEMETRY_SAMPLE_TIMEOUT',
    slowMs: 1
    }
  );
  const blockedWhilePending = await sampler.run(
    () => ({ shouldNotStart: true }),
    { timeoutMs: 10, deadlineAt: Date.now() + 100 }
  );
  resolveLateTask({ telemetry: 'late-settlement', timing: lateFulfilledTiming });
  await sleep(0);
  const slow = await sampler.run(
    () => track(async () => {
      await sleep(8);
      return { telemetry: 'slow-success', timing: normalTiming };
    }),
    { timeoutMs: 100, slowMs: 1 }
  );
  const invalid = await sampler.run(
    () => track(() => ({ telemetry: 'invalid-timing', timing: invalidTiming })),
    { timeoutMs: 100, slowMs: 1 }
  );
  const failed = await sampler.run(
    () => track(() => Promise.reject(new Error('fixture failure'))),
    { timeoutMs: 100, slowMs: 1 }
  );
  let resolveNearDeadline;
  const nearDeadlineTask = new Promise((resolve) => { resolveNearDeadline = resolve; });
  const nearDeadlineAt = Date.now() + 10;
  const nearDeadline = await sampler.run(
    () => track(() => nearDeadlineTask),
    { timeoutMs: 100, deadlineAt: nearDeadlineAt, slowMs: 1 }
  );
  resolveNearDeadline({ telemetry: 'near-deadline-late-settlement' });
  await sleep(0);
  let rejectLateTask;
  const lateRejectTask = new Promise((_, reject) => { rejectLateTask = reject; });
  const lateReject = await sampler.run(
    () => track(() => lateRejectTask),
    { timeoutMs: 10, timeoutCode: 'MAP_UI_TELEMETRY_SAMPLE_TIMEOUT', slowMs: 1 }
  );
  rejectLateTask(new Error('fixture late rejection'));
  await sleep(0);
  const deadline = await sampler.run(
    () => ({ shouldNotStart: true }),
    { timeoutMs: 100, deadlineAt: Date.now() - 1 }
  );
  await sleep(0);
  const summary = sampler.snapshot();
  const pass = first.record.status === 'timeout'
    && first.record.complete === false
    && first.record.timedOut === true
    && first.record.lateSettled === true
    && first.record.lateOutcome === 'fulfilled'
    && first.record.taskTiming?.pageDurationMs === lateFulfilledTiming.pageDurationMs
    && Number.isFinite(first.record.receivedAt)
    && blockedWhilePending.record.status === 'pending-deadline'
    && blockedWhilePending.record.reason === 'SINGLE_FLIGHT_IN_FLIGHT'
    && blockedWhilePending.record.pendingCallId === first.record.callId
    && slow.record.status === 'slow'
    && slow.record.complete === true
    && slow.record.taskTiming?.pageDurationMs === normalTiming.pageDurationMs
    && Number.isFinite(slow.record.receivedAt)
    && invalid.record.status === 'completed'
    && invalid.record.taskTiming === null
    && Number.isFinite(invalid.record.receivedAt)
    && failed.record.status === 'failed'
    && failed.record.failed === true
    && failed.record.taskTiming === null
    && nearDeadline.record.status === 'timeout'
    && nearDeadline.record.effectiveTimeoutMs <= 15
    && nearDeadline.record.timedOut === true
    && nearDeadline.record.lateSettled === true
    && lateReject.record.status === 'timeout'
    && lateReject.record.lateSettled === true
    && lateReject.record.lateOutcome === 'failed'
    && lateReject.record.failed === true
    && deadline.record.status === 'pending-deadline'
    && deadline.record.reason === 'deadline-reached'
    && startedTasks === 6
    && active === 0
    && maxActive === 1
    && summary.counts.started === 6
    && summary.counts.timedOut === 3
    && summary.counts.lateSettled === 3
    && summary.counts.lateFailed === 1
    && summary.counts.slow === 1
    && summary.counts.failed === 1
    && summary.counts.pendingDeadline === 2
    && summary.pending === null;
  return {
    statuses: {
      timeout: first.record.status,
      lateSettled: first.record.lateSettled,
      lateOutcome: first.record.lateOutcome,
      pendingDeadlineWhileInFlight: blockedWhilePending.record.status,
      pendingCallId: blockedWhilePending.record.pendingCallId,
      ownerCallId: first.record.callId,
      slow: slow.record.status,
      failed: failed.record.status,
      invalidTiming: invalid.record.taskTiming,
      nearDeadline: nearDeadline.record.status,
      nearDeadlineEffectiveTimeoutMs: nearDeadline.record.effectiveTimeoutMs,
      lateReject: lateReject.record.lateOutcome,
      deadline: deadline.record.status
    },
    timing: {
      normal: slow.record.taskTiming,
      lateFulfilled: first.record.taskTiming,
      failed: failed.record.taskTiming,
      invalid: invalid.record.taskTiming,
      lateReceivedAt: first.record.receivedAt,
      normalReceivedAt: slow.record.receivedAt
    },
    concurrency: { active, maxActive, startedTasks },
    counts: summary.counts,
    pass
  };
}

async function runMapTelemetryFixtures() {
  const raf = runRafAccountingFixture();
  const boundaries = runRafBoundaryFixture();
  const status = runMapStatusFixture();
  const offlineCrashpadEntry = runOfflineCrashpadEntryFixture();
  const nativeTimingAggregation = runMapNativeTimingAggregationFixture();
  const nativeTimingPhaseControl = await runMapMainTimingPhaseFixture();
  const nativeTiming = {
    ...nativeTimingAggregation,
    mainPhaseControl: nativeTimingPhaseControl,
    pass: nativeTimingAggregation.pass === true && nativeTimingPhaseControl.pass === true
  };
  const characterNativeTiming = runCharacterNativeTimingAggregationFixture();
  const characterMainTiming = runCharacterMainTimingAggregationFixture();
  const mainTelemetryCollector = runMainMapTelemetryCollectorFixture();
  const cancellationTelemetry = runMapCancellationTelemetryFixture();
  const unavailableModelTelemetry = runMapModelUnavailableTelemetryFixture();
  const loadRetentionTelemetry = runMapLoadRetentionTelemetryFixture();
  const mapApiObserverProjection = runMapApiObserverProjectionFixture();
  const windowObserver = await runMapWindowObserverFixture();
  const singleFlight = await runMapTelemetrySingleFlightFixture();
  return {
    mode: 'fixture',
    raf,
    boundaries,
    status,
    offlineCrashpadEntry,
    nativeTiming,
    characterNativeTiming,
    characterMainTiming,
    mainTelemetryCollector,
    cancellationTelemetry,
    unavailableModelTelemetry,
    loadRetentionTelemetry,
    mapApiObserverProjection,
    windowObserver,
    singleFlight,
    pass: raf.pass === true
      && boundaries.pass === true
      && status.pass === true
      && offlineCrashpadEntry.pass === true
      && nativeTiming.pass === true
      && characterNativeTiming.pass === true
      && characterMainTiming.pass === true
      && mainTelemetryCollector.pass === true
      && cancellationTelemetry.pass === true
      && unavailableModelTelemetry.pass === true
      && loadRetentionTelemetry.pass === true
      && mapApiObserverProjection.pass === true
      && windowObserver.pass === true
      && singleFlight.pass === true
  };
}

function summarizeCpuProfile(profile, samplingIntervalUs) {
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const buckets = new Map();
  for (let index = 0; index < samples.length; index += 1) {
    const node = nodeById.get(samples[index]);
    if (!node) continue;
    const frame = node.callFrame ?? {};
    const key = [frame.functionName || '(anonymous)', frame.url || '', frame.lineNumber ?? 0, frame.columnNumber ?? 0].join('|');
    const current = buckets.get(key) ?? {
      functionName: frame.functionName || '(anonymous)',
      url: frame.url || '',
      lineNumber: frame.lineNumber ?? 0,
      columnNumber: frame.columnNumber ?? 0,
      sampleCount: 0,
      sampledMs: 0
    };
    current.sampleCount += 1;
    current.sampledMs += (Number(deltas[index]) || samplingIntervalUs) / 1_000;
    buckets.set(key, current);
  }
  const allFunctions = [...buckets.values()]
    .sort((left, right) => right.sampledMs - left.sampledMs)
  const topFunctions = allFunctions.slice(0, 40);
  const categorized = {
    geometryDecodeMerge: allFunctions.filter((entry) => /decode|merge|base64|typedarray|uint8|geometry|normal|position|index/i.test(`${entry.functionName} ${entry.url}`)).slice(0, 15),
    resourceQueueUpload: allFunctions.filter((entry) => /queue|upload|updateModel|frameTask|scheduler|render/i.test(`${entry.functionName} ${entry.url}`)).slice(0, 15),
    nativeWait: allFunctions.filter((entry) => /readMapStaticGeometry|ipcRenderer|invoke|electron|bridge/i.test(`${entry.functionName} ${entry.url}`)).slice(0, 15)
  };
  return {
    nodeCount: nodes.length,
    sampleCount: samples.length,
    sampledMs: allFunctions.reduce((sum, entry) => sum + entry.sampledMs, 0),
    topFunctions,
    categorized
  };
}

async function startRendererCpuProfiler(page) {
  const client = await bounded(
    page.context().newCDPSession(page),
    RENDERER_PROFILE_COMMAND_TIMEOUT_MS,
    'CPU_PROFILE_SESSION_TIMEOUT'
  );
  const samplingIntervalUs = 1_000;
  try {
    await bounded(
      client.send('Profiler.enable'),
      RENDERER_PROFILE_COMMAND_TIMEOUT_MS,
      'CPU_PROFILE_ENABLE_TIMEOUT'
    );
    await bounded(
      client.send('Profiler.start', { samplingInterval: samplingIntervalUs }),
      RENDERER_PROFILE_COMMAND_TIMEOUT_MS,
      'CPU_PROFILE_START_TIMEOUT'
    );
  } catch (error) {
    // A timed-out start may have enabled the profiler.  Best-effort cleanup is
    // itself bounded so a failed profiler cannot strand the probe.
    await bounded(
      client.send('Profiler.disable'),
      RENDERER_PROFILE_CLEANUP_TIMEOUT_MS,
      'CPU_PROFILE_START_DISABLE_TIMEOUT'
    ).catch(() => undefined);
    await bounded(
      client.detach(),
      RENDERER_PROFILE_CLEANUP_TIMEOUT_MS,
      'CPU_PROFILE_START_DETACH_TIMEOUT'
    ).catch(() => undefined);
    throw error;
  }
  return { client, samplingIntervalUs, startedAt: Date.now(), stopped: false };
}

async function stopRendererCpuProfiler(profiler, reportDir, phase = 'main') {
  if (!profiler || profiler.stopped) return null;
  profiler.stopped = true;
  let result = null;
  let stopError = null;
  const cleanupErrors = [];
  try {
    result = await bounded(
      profiler.client.send('Profiler.stop'),
      RENDERER_PROFILE_STOP_TIMEOUT_MS,
      `CPU_PROFILE_STOP_TIMEOUT: ${phase}`
    );
  } catch (error) {
    stopError = error;
  }
  for (const [operation, action] of [
    ['disable', () => profiler.client.send('Profiler.disable')],
    ['detach', () => profiler.client.detach()]
  ]) {
    try {
      await bounded(
        action(),
        RENDERER_PROFILE_CLEANUP_TIMEOUT_MS,
        `CPU_PROFILE_${operation.toUpperCase()}_TIMEOUT: ${phase}`
      );
    } catch (error) {
      cleanupErrors.push({
        operation,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (stopError) {
    const error = stopError instanceof Error ? stopError : new Error(String(stopError));
    if (cleanupErrors.length > 0) {
      error.message = `${error.message}; cleanup=${JSON.stringify(cleanupErrors)}`;
    }
    throw error;
  }
  const profile = result?.profile ?? null;
  if (!profile) {
    return {
      target: 'renderer-page-cdp',
      phase,
      error: 'CPU_PROFILE_EMPTY',
      cleanupErrors
    };
  }
  const profilePath = join(reportDir, `renderer-${phase}.cpuprofile`);
  await bounded(
    writeFile(profilePath, JSON.stringify(profile), 'utf8'),
    RENDERER_PROFILE_WRITE_TIMEOUT_MS,
    `CPU_PROFILE_WRITE_TIMEOUT: ${phase}`
  );
  return {
    target: 'renderer-page-cdp',
    phase,
    samplingIntervalUs: profiler.samplingIntervalUs,
    elapsedMs: Date.now() - profiler.startedAt,
    profilePath,
    cleanupErrors,
    summary: summarizeCpuProfile(profile, profiler.samplingIntervalUs)
  };
}

async function main() {
  const overlayMsb = join(OVERLAY_ROOT, MAP_RELATIVE_PATH.replaceAll('/', '\\'));
  const baseMsb = join(GAME_ROOT, MAP_RELATIVE_PATH.replaceAll('/', '\\'));
  const crashEvidencePaths = createMapCrashEvidencePaths(reportDir);
  const crashDumpsPath = crashEvidencePaths.crashDumps;
  const crashReporterReceiptPath = crashEvidencePaths.receipt;
  const electronEntryExitInfoPath = crashEvidencePaths.entryExit;
  const electronExitInfoPath = crashEvidencePaths.parentExit;

  const report = {
    ok: false,
    mode: MODE,
    mapId: MAP_ID,
    requestedModel: REQUESTED_MODEL,
    mapRelativePath: MAP_RELATIVE_PATH,
    gameRoot: GAME_ROOT,
    overlayRoot: OVERLAY_ROOT,
    sourceModWrites: false,
    crashReporter: {
      mode: 'offline-crashpad',
      crashDumpsPath,
      receiptPath: crashReporterReceiptPath,
      entryExitInfoPath: electronEntryExitInfoPath,
      exitInfoPath: electronExitInfoPath,
      entryPath: null,
      productionMain: null
    },
    loadCondition: {
      agentConcurrent: AGENT_CONCURRENT_LOAD === 'true'
        ? true
        : AGENT_CONCURRENT_LOAD === 'false'
          ? false
          : null,
      agentSession: AGENT_SESSION,
      artifactLabel: ARTIFACT_LABEL,
      productionMain: LIVE_PRODUCTION_MAIN
    },
    boundaries: {
      publicApi: ['readMsbDocument', 'readMapStaticGeometry'],
      rendererHotReplacement: 'real MAP workbench; console loader events plus context hooks',
      drawCallHook: 'WebGL methods and best-effort WebGPU render-pass methods',
      longFrame: 'renderer RAF gap >= 50ms and PerformanceObserver longtask',
      rafWindows: {
        names: [...MAP_TELEMETRY_BOUNDARY_NAMES],
        accounting: 'cumulative per-window counters; 2000-sample ring is debug-only'
      },
      cancellation: 'renderer cleanup plus main structured Bridge terminal receipts; command cancellation is native evidence, artifact-only remains unverified'
    },
    rafAccountingFixture: runRafAccountingFixture(),
    statusFixture: runMapStatusFixture(),
    status: {
      functionalLoadOk: false,
      metricsValid: false,
      responsivenessVerified: false,
      responsivenessPass: false,
      responsivenessReason: 'not evaluated',
      documentVisibleLongGaps: null,
      foregroundConditionsValid: false,
      foregroundConditionsVerified: false,
      foregroundConditionsReason: 'OS window observation not started',
      nativeCancellation: 'unverified'
    },
    foregroundObservation: {
      observerInstalled: false,
      observedWindow: null,
      installError: null,
      finishError: null
    },
    nativeTimingSummaryByPhase: null,
    characterNativeTimingSummaryByPhase: null,
    characterMainTimingSummaryByPhase: null,
    timings: {},
    errors: []
  };

  let app;
  let page;
  let productionMain = LIVE_PRODUCTION_MAIN;
  let productionSnapshotRoot = null;
  let rendererProfiler = null;
  let suppressPostLoadTelemetry = false;
  let normalTelemetryPoll = null;
  let mapWindowObserverFinished = false;
  const consoleEvents = [];
  const pageErrors = [];
  const processDiagnostics = { pid: null, exitCode: null, signal: null, stdoutTail: '', stderrTail: [] };
  const mainTelemetryCollector = createMainMapTelemetryCollector();
  const cancellationTelemetryCollector = createMapCancellationTelemetryCollector();
  const unavailableModelTelemetryCollector = createMapModelUnavailableTelemetryCollector();
  const writeElectronExitInfo = (source) => {
    const settled = Number.isInteger(processDiagnostics.exitCode)
      || typeof processDiagnostics.signal === 'string';
    try {
      writeFileSync(electronExitInfoPath, `${JSON.stringify({
        schemaVersion: 1,
        source,
        atUTC: new Date().toISOString(),
        pid: processDiagnostics.pid,
        exitCode: processDiagnostics.exitCode,
        signal: processDiagnostics.signal,
        settled,
        crashDumpsPath,
        receiptPath: crashReporterReceiptPath,
        artifactId: report.artifactSnapshot?.artifactId ?? null
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      report.crashReporter.exitInfoWriteError = error instanceof Error ? error.message : String(error);
    }
  };
  const startedAt = Date.now();
  const deadlineAt = startedAt + TOTAL_TIMEOUT_MS;
  report.deadline = {
    timeoutMs: TOTAL_TIMEOUT_MS,
    at: new Date(deadlineAt).toISOString()
  };
  const captureScreenshot = async (name) => {
    if (skipRendererObservationIfBlocked(`screenshot:${name}`)) return null;
    if (!page) return null;
    const target = join(reportDir, `${name}.png`);
    try {
      await bounded(page.screenshot({ path: target, fullPage: true }), 15_000, `MAP_SCREENSHOT_TIMEOUT: ${name}`);
      report.screenshots ??= {};
      report.screenshots[name] = target;
      return target;
    } catch (error) {
      report.screenshotErrors ??= [];
      report.screenshotErrors.push({
        name,
        message: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };
  const recordBoundedObservationError = (bucket, phase, error) => {
    report[bucket] ??= [];
    report[bucket].push({
      phase,
      message: error instanceof Error ? error.message : String(error)
    });
  };
  const syncNativeTimingSummary = () => {
    report.nativeTimingSummaryByPhase = report.mainTelemetry?.summary?.nativeTimingSummaryByPhase ?? null;
    report.characterNativeTimingSummaryByPhase = report.mainTelemetry?.summary?.characterNativeTimingSummaryByPhase ?? null;
    report.characterMainTimingSummaryByPhase = report.mainTelemetry?.summary?.characterMainTimingSummaryByPhase ?? null;
  };
  const syncUnavailableModelTelemetry = () => {
    report.mapModelUnavailableTelemetry = unavailableModelTelemetryCollector.snapshot();
  };
  const syncNormalTelemetryPoll = () => {
    if (normalTelemetryPoll) report.telemetrySamplingSingleFlight = normalTelemetryPoll.snapshot();
  };
  const skipRendererObservationIfBlocked = (phase) => {
    if (MODE !== 'normal') return null;
    const pending = normalTelemetryPoll?.snapshot()?.pending ?? null;
    if (!suppressPostLoadTelemetry && !pending) return null;
    const reason = suppressPostLoadTelemetry
      ? 'MAP_UI_TELEMETRY_PENDING_DEADLINE'
      : 'MAP_UI_TELEMETRY_SAMPLE_IN_FLIGHT';
    const skip = {
      phase,
      reason,
      pendingCallId: pending?.callId ?? null
    };
    report.telemetryObservationSkips ??= [];
    report.telemetryObservationSkips.push(skip);
    return skip;
  };
  const snapshotTelemetryBounded = async (phase, options = {}) => {
    if (skipRendererObservationIfBlocked(phase)) return null;
    if (!page) return null;
    try {
      return await bounded(
        snapshotTelemetry(page, options),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        `MAP_TELEMETRY_SNAPSHOT_TIMEOUT: ${phase}`
      );
    } catch (error) {
      // A renderer main-thread stall is evidence of incomplete observation;
      // retain it in the report and let finalizeMapStatus keep responsiveness
      // unverified rather than treating the missing sample as a pass.
      recordBoundedObservationError('telemetrySamplingErrors', phase, error);
      return null;
    }
  };
  const transitionMapBoundariesBounded = async (phase, transition) => {
    if (skipRendererObservationIfBlocked(phase)) return null;
    if (!page) return null;
    try {
      const result = await bounded(
        transitionMapTelemetryBoundaries(page, transition),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        `MAP_TELEMETRY_BOUNDARY_TIMEOUT: ${phase}`
      );
      if (result?.ok !== true) {
        throw new Error(result?.reason || `MAP_TELEMETRY_BOUNDARY_FAILED: ${phase}`);
      }
      return result;
    } catch (error) {
      recordBoundedObservationError('telemetrySamplingErrors', phase, error);
      return null;
    }
  };
  const closeOpenMapBoundariesBounded = async (phase) => {
    if (skipRendererObservationIfBlocked(phase)) return null;
    if (!page) return null;
    try {
      return await bounded(
        closeOpenMapTelemetryBoundaries(page),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        `MAP_TELEMETRY_BOUNDARY_CLOSE_TIMEOUT: ${phase}`
      );
    } catch (error) {
      recordBoundedObservationError('telemetrySamplingErrors', phase, error);
      return null;
    }
  };
  const snapshotMapApiTimingBounded = async (phase) => {
    if (skipRendererObservationIfBlocked(phase)) return null;
    if (!page) return null;
    try {
      return await bounded(
        snapshotMapApiTiming(page),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        `MAP_API_TIMING_SNAPSHOT_TIMEOUT: ${phase}`
      );
    } catch (error) {
      recordBoundedObservationError('nativeTelemetrySamplingErrors', phase, error);
      return null;
    }
  };
  const setMapApiTimingPhaseBounded = async (phase) => {
    if (skipRendererObservationIfBlocked(`api-phase:${phase}`)) return null;
    if (!page) return null;
    try {
      return await bounded(
        setMapApiTimingPhase(page, phase),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        `MAP_API_TIMING_PHASE_TIMEOUT: ${phase}`
      );
    } catch (error) {
      recordBoundedObservationError('nativeTelemetrySamplingErrors', `set-phase:${phase}`, error);
      return null;
    }
  };
  const setMainMapTimingPhaseBounded = async (phase) => {
    if (!app) return null;
    try {
      const result = await bounded(
        setMainMapTimingPhase(app, phase),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        `MAP_MAIN_TIMING_PHASE_TIMEOUT: ${phase}`
      );
      report.mainNativeTimingPhaseControl ??= {
        key: MAP_MAIN_TIMING_PHASE_KEY,
        transitions: [],
        errors: []
      };
      report.mainNativeTimingPhaseControl.transitions.push({ phase, result });
      if (result?.ok !== true) {
        report.mainNativeTimingPhaseControl.errors.push({
          phase,
          reason: result?.reason ?? 'MAP_MAIN_TIMING_PHASE_FAILED'
        });
      }
      return result;
    } catch (error) {
      recordBoundedObservationError('nativeTelemetrySamplingErrors', `main-phase:${phase}`, error);
      report.mainNativeTimingPhaseControl ??= {
        key: MAP_MAIN_TIMING_PHASE_KEY,
        transitions: [],
        errors: []
      };
      report.mainNativeTimingPhaseControl.errors.push({
        phase,
        reason: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };
  const stopAndRecordRendererProfiler = async (phase) => {
    if (!rendererProfiler) return;
    const active = rendererProfiler;
    rendererProfiler = null;
    try {
      const profileResult = await bounded(
        stopRendererCpuProfiler(active, reportDir, phase),
        RENDERER_PROFILE_PHASE_TIMEOUT_MS,
        `CPU_PROFILE_PHASE_TIMEOUT: ${phase}`
      );
      report.rendererProfiler ??= { target: 'renderer-page-cdp', profiles: [] };
      report.rendererProfiler.profiles ??= [];
      if (profileResult) report.rendererProfiler.profiles.push(profileResult);
    } catch (error) {
      report.rendererProfiler ??= { target: 'renderer-page-cdp', profiles: [] };
      report.rendererProfiler.profileErrors ??= [];
      report.rendererProfiler.profileErrors.push({
        phase,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };
  const installAndRecordMapWindowObserver = async () => {
    if (!app) return null;
    try {
      const initial = await bounded(
        installMapWindowObserver(app),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        'MAP_WINDOW_OBSERVER_INSTALL_TIMEOUT'
      );
      report.foregroundObservation.observerInstalled = initial?.installed === true;
      report.foregroundObservation.initial = initial ?? null;
      if (initial?.installed !== true) {
        report.foregroundObservation.installError = initial?.reason ?? 'MAP_WINDOW_OBSERVER_INSTALL_FAILED';
      }
      return initial;
    } catch (error) {
      report.foregroundObservation.installError = error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  const markMapWindowObservation = async (phase) => {
    if (!app || report.foregroundObservation.observerInstalled !== true) {
      report.foregroundObservation.finishError ??= 'MAP_WINDOW_OBSERVER_NOT_INSTALLED';
      return null;
    }
    try {
      const result = await bounded(
        markMapWindowObserver(app, phase),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        `MAP_WINDOW_OBSERVER_MARK_TIMEOUT:${phase}`
      );
      if (result?.ok !== true) {
        report.foregroundObservation.finishError ??= result?.reason ?? `MAP_WINDOW_OBSERVER_MARK_FAILED:${phase}`;
      }
      return result;
    } catch (error) {
      report.foregroundObservation.finishError ??= error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  const finishAndRecordMapWindowObserver = async (phase = 'final') => {
    if (mapWindowObserverFinished) return report.foregroundObservation.observedWindow;
    mapWindowObserverFinished = true;
    if (!app || report.foregroundObservation.observerInstalled !== true) {
      report.foregroundObservation.observedWindow = null;
      report.foregroundObservation.finishError ??= `MAP_WINDOW_OBSERVER_FINISH_UNAVAILABLE:${phase}`;
      return null;
    }
    try {
      const observedWindow = await bounded(
        finishMapWindowObserver(app),
        MAP_PAGE_SNAPSHOT_TIMEOUT_MS,
        `MAP_WINDOW_OBSERVER_FINISH_TIMEOUT:${phase}`
      );
      report.foregroundObservation.observedWindow = observedWindow ?? null;
      if (observedWindow?.complete !== true || observedWindow?.listenersRemoved !== true) {
        report.foregroundObservation.finishError ??= 'MAP_WINDOW_OBSERVER_FINISH_INCOMPLETE';
      }
      return observedWindow;
    } catch (error) {
      report.foregroundObservation.observedWindow = null;
      report.foregroundObservation.finishError ??= error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  try {
    if (!existsSync(overlayMsb) && !existsSync(baseMsb)) {
      throw new Error(`MAP_RESOURCE_MISSING: ${overlayMsb} / ${baseMsb}`);
    }
    const artifactSnapshot = await runPhase(
      report,
      'production-artifact-snapshot',
      60_000,
      deadlineAt,
      startedAt,
      async () => {
        const configuredSnapshotRoot = process.env.SF_PRODUCTION_ARTIFACT_SNAPSHOT_ROOT?.trim();
        return configuredSnapshotRoot
          ? assertAgentProductionArtifactSnapshotFresh(configuredSnapshotRoot)
          : createAgentProductionArtifactSnapshot(ROOT, {
              label: ARTIFACT_LABEL || `map-${MODE}`
            });
      }
    );
    productionSnapshotRoot = artifactSnapshot.snapshotRoot;
    productionMain = join(productionSnapshotRoot, 'apps/desktop/e2e/playwright/production-main.mjs');
    const snapshotLiveBuild = artifactSnapshot.manifest.liveBuild ?? null;
    report.build = artifactSnapshot.liveBuild?.manifest ?? (snapshotLiveBuild
      ? {
          schemaVersion: 1,
          generatedAt: snapshotLiveBuild.generatedAt,
          source: { sha256: snapshotLiveBuild.sourceSha256 },
          output: { sha256: snapshotLiveBuild.outputSha256 }
        }
      : null);
    report.artifactSnapshot = {
      root: productionSnapshotRoot,
      manifestPath: artifactSnapshot.manifestPath,
      artifactId: artifactSnapshot.manifest.artifactId,
      label: artifactSnapshot.manifest.label ?? null,
      sourceRevision: artifactSnapshot.manifest.sourceRevision ?? null,
      sourceBranch: artifactSnapshot.manifest.sourceBranch ?? null,
      liveBuild: artifactSnapshot.manifest.liveBuild ?? null
    };
    report.loadCondition.productionMain = productionMain;
    if (!existsSync(productionMain)) throw new Error(`PRODUCTION_MAIN_MISSING: ${productionMain}`);
    await mkdir(crashDumpsPath, { recursive: true });
    const offlineCrashpadEntryPath = join(scratchRoot, 'electron-offline-crashpad-entry.mjs');
    await writeFile(
      offlineCrashpadEntryPath,
      createOfflineCrashpadEntrySource({
        productionMain,
        artifactId: artifactSnapshot.manifest.artifactId,
        crashDumpsPath,
        receiptPath: crashReporterReceiptPath,
        entryExitInfoPath: electronEntryExitInfoPath
      }),
      'utf8'
    );
    report.crashReporter.entryPath = offlineCrashpadEntryPath;
    report.crashReporter.productionMain = productionMain;
    app = await runPhase(
      report,
      'electron-launch',
      60_000,
      deadlineAt,
      startedAt,
      () => electron.launch({
        cwd: productionSnapshotRoot,
        args: [offlineCrashpadEntryPath, `--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          SF_PRODUCTION_ARTIFACT_SNAPSHOT_ROOT: productionSnapshotRoot,
          SF_PRODUCTION_OUT_ROOT: join(productionSnapshotRoot, 'apps/desktop/out'),
          SF_PRODUCTION_ARTIFACT_ID: artifactSnapshot.manifest.artifactId,
          SF_E2E_OVERLAY_ROOT: OVERLAY_ROOT,
          SF_E2E_BASE_ROOT: GAME_ROOT,
          SF_E2E_WORKSPACE_STORAGE_ROOT: join(scratchRoot, 'workspace-storage'),
          SF_MAP_MAIN_TELEMETRY: '1',
          SF_MAP_NATIVE_TIMING: '1'
        }
      })
    );
    const child = app.process();
    processDiagnostics.pid = child.pid;
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      mainTelemetryCollector.ingest(text);
      cancellationTelemetryCollector.ingest(text);
      processDiagnostics.stdoutTail = (processDiagnostics.stdoutTail + text).slice(-32_768);
    });
    child.stderr?.on('data', (chunk) => {
      processDiagnostics.stderrTail.push(String(chunk));
      if (processDiagnostics.stderrTail.length > 200) processDiagnostics.stderrTail.shift();
    });
    child.on('exit', (code, signal) => {
      processDiagnostics.exitCode = code;
      processDiagnostics.signal = signal;
      writeElectronExitInfo('child-exit');
    });
    page = await runPhase(report, 'electron-first-window', 60_000, deadlineAt, startedAt, () => app.firstWindow());
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('crash', () => pageErrors.push('RENDERER_CRASH'));
    page.on('console', (message) => {
      const text = message.text();
      unavailableModelTelemetryCollector.ingest(text);
      if (text.includes('MAP') || text.includes('MsbScenePanel') || /nativeAbortObserved/i.test(text)) {
        consoleEvents.push({ atMs: Date.now() - startedAt, type: message.type(), text: text.slice(0, 4000) });
        if (consoleEvents.length > 5000) consoleEvents.shift();
      }
    });
    await runPhase(report, 'domcontentloaded', 45_000, deadlineAt, startedAt, () => page.waitForLoadState('domcontentloaded'));
    await runPhase(
      report,
      'preload-ready',
      45_000,
      deadlineAt,
      startedAt,
      () => page.waitForFunction(() => Boolean(globalThis.soulforge), undefined, { timeout: 30_000 })
    );
    report.timings.shellReadyMs = Date.now() - startedAt;
    report.telemetryInstall = await runPhase(report, 'telemetry-install', 15_000, deadlineAt, startedAt, () => page.evaluate(installMapTelemetry));
    report.nativeApiTelemetryInstall = await runPhase(
      report,
      'native-api-timing-install',
      15_000,
      deadlineAt,
      startedAt,
      () => installMapApiTimingTelemetry(page)
    );

    const workspaceStarted = Date.now();
    const workspace = await runPhase(report, 'workspace-scan-and-resource-search', 180_000, deadlineAt, startedAt, () => getWorkspaceAndMap(page));
    report.timings.workspaceScanMs = Date.now() - workspaceStarted;
    report.workspace = workspace;
    if (!workspace.map?.sourceUri) throw new Error(`MAP_NOT_INDEXED: ${MAP_RELATIVE_PATH}`);
    const sourceUri = workspace.map.sourceUri;

    await setMapApiTimingPhaseBounded('native-msb');
    const msbStarted = Date.now();
    report.msb = await runPhase(report, 'native-msb-read', DIRECT_TIMEOUT_MS, deadlineAt, startedAt, () => summarizeMsb(page, sourceUri));
    report.timings.msbWallMs = Date.now() - msbStarted;
    if (!report.msb.ok) throw new Error(`MSB_READ_FAILED: ${JSON.stringify(report.msb.diagnostics)}`);

    const modelSelection = chooseModel(Array.isArray(report.msb.modelNames) ? report.msb.modelNames : []);
    report.modelSelection = modelSelection;
    await setMainMapTimingPhaseBounded('direct');
    if (modelSelection.selectedModel) {
      await setMapApiTimingPhaseBounded('native-geometry');
      const geometryStarted = Date.now();
      report.geometry = await runPhase(
        report,
        'native-map-static-geometry-pages',
        DIRECT_TIMEOUT_MS,
        deadlineAt,
        startedAt,
        () => readGeometryPages(page, sourceUri, modelSelection.selectedModel)
      );
      report.timings.geometryWallMs = Date.now() - geometryStarted;
    } else {
      report.geometry = { ok: false, reason: 'MSB_MODEL_TABLE_EMPTY' };
    }

    await setMapApiTimingPhaseBounded('ui-load');
    await setMainMapTimingPhaseBounded('ui-load');
    try {
      rendererProfiler = await runPhase(
        report,
        'renderer-cpu-profiler-start',
        15_000,
        deadlineAt,
        startedAt,
        () => startRendererCpuProfiler(page)
      );
      report.rendererProfiler = {
        target: 'renderer-page-cdp',
        samplingIntervalUs: rendererProfiler.samplingIntervalUs,
        startedAt: new Date(rendererProfiler.startedAt).toISOString(),
        profiles: [],
        stages: {
          nativeMsbReadMs: report.timings.msbWallMs,
          nativeGeometryReadMs: report.timings.geometryWallMs,
          mapCanvasMs: report.timings.mapCanvasMs ?? null,
          uiLoadMs: null
        }
      };
    } catch (error) {
      report.rendererProfiler = {
        target: 'renderer-page-cdp',
        unavailable: error instanceof Error ? error.message : String(error)
      };
    }

    // The MAP responsiveness window starts immediately before the user-facing
    // open operation.  This excludes app startup/native single-model reads,
    // while the eventual total still includes mount/canvas work plus stream
    // loading. Boundary snapshots retain samples only at these phase edges;
    // ordinary 1 Hz samples stay compact.
    const mapBoundarySnapshotOptions = { includeLongTasks: true, includeSamples: true };
    // Install the main-side observer before taking the renderer baseline and
    // before opening the total boundary. Its own start/end markers are recorded
    // by the same BrowserWindow/main-clock observer, not inferred from sparse
    // IPC completion samples.
    await installAndRecordMapWindowObserver();
    const mapOpenBaselineTelemetry = await snapshotTelemetryBounded('map-open-baseline', mapBoundarySnapshotOptions);
    // Start the actual windows after the baseline snapshot so probe-side
    // serialization time is not mistaken for MAP mount work. The next RAF
    // still carries the complete gap from the prior frame.
    await markMapWindowObservation('start');
    await transitionMapBoundariesBounded('map-open-start', {
      begin: ['total', 'mapCanvas']
    });
    report.mapTelemetry = {
      baselineBeforeMapOpen: mapOpenBaselineTelemetry,
      mapCanvas: null,
      streamLoad: null,
      total: null
    };
    const targetOpenStarted = Date.now();
    await runPhase(report, 'map-workbench-open', 180_000, deadlineAt, startedAt, async () => {
      await openResource(page, MAP_RELATIVE_PATH);
      await page.getByLabel('MSB 地图工作台').waitFor({ state: 'visible', timeout: 120_000 });
      await page.locator('.msb-viewport canvas').waitFor({ state: 'visible', timeout: 120_000 });
    });
    report.timings.mapCanvasMs = Date.now() - targetOpenStarted;
    if (report.rendererProfiler?.stages) report.rendererProfiler.stages.mapCanvasMs = report.timings.mapCanvasMs;
    await transitionMapBoundariesBounded('map-canvas-end', {
      end: ['mapCanvas'],
      begin: ['streamLoad']
    });
    const mapCanvasEndTelemetry = await snapshotTelemetryBounded('map-canvas-end', mapBoundarySnapshotOptions);
    report.mapTelemetry.mapCanvas = {
      end: mapCanvasEndTelemetry,
      delta: diffMapTelemetry(mapOpenBaselineTelemetry, mapCanvasEndTelemetry, 'mapCanvas')
    };
    await captureScreenshot('workbench-open');
    // Separate initial scene/proxy setup from the long streaming phase so the
    // renderer CPU evidence cannot hide queue/decode work inside one aggregate.
    await stopAndRecordRendererProfiler('canvas');
    try {
      rendererProfiler = await runPhase(
        report,
        'renderer-cpu-profiler-ui-start',
        15_000,
        deadlineAt,
        startedAt,
        () => startRendererCpuProfiler(page)
      );
      report.rendererProfiler ??= { target: 'renderer-page-cdp', profiles: [] };
      report.rendererProfiler.profiles ??= [];
      report.rendererProfiler.uiLoadStartedAt = new Date(rendererProfiler.startedAt).toISOString();
    } catch (error) {
      report.rendererProfiler ??= { target: 'renderer-page-cdp', profiles: [] };
      report.rendererProfiler.profileErrors ??= [];
      report.rendererProfiler.profileErrors.push({
        phase: 'ui-load',
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (MODE === 'cancel') {
      await runPhase(report, 'cancel-delay-before-switch', CANCEL_DELAY_MS + 5_000, deadlineAt, startedAt, () => page.waitForTimeout(CANCEL_DELAY_MS));
      const switchStarted = Date.now();
      const otherQuery = process.env.SF_MAP_CANCEL_TARGET?.trim() || 'map/mapstudio/m10_00_00_00.msb.dcx';
      const beforeSwitchCount = consoleEvents.length;
      const cancellationReceiptStart = cancellationTelemetryCollector.snapshot().receiptCount;
      const cancellationRequestStart = cancellationTelemetryCollector.snapshot().cancelRequestCount;
      const cancelTargetCandidates = await runPhase(
        report,
        'cancel-target-search',
        30_000,
        deadlineAt,
        startedAt,
        () => page.evaluate(async (query) => {
          const files = await globalThis.soulforge.searchResources(query);
          return Array.isArray(files) ? files.map((file) => file?.relativePath).filter(Boolean) : [];
        }, otherQuery)
      );
      report.cancelTarget = { query: otherQuery, candidates: cancelTargetCandidates };
      if (cancelTargetCandidates.length > 0) {
        await runPhase(report, 'cancel-switch-workbench', 180_000, deadlineAt, startedAt, async () => {
          await openResource(page, otherQuery);
          await page.getByLabel('MSB 地图工作台').waitFor({ state: 'visible', timeout: 120_000 });
        });
        report.timings.cancelSwitchMs = Date.now() - switchStarted;
        const cancellationObservationStartedAt = Date.now();
        let cancellationObservationCompleted = false;
        await runPhase(
          report,
          'cancel-cleanup-observation-window',
          CANCEL_OBSERVATION_MAX_MS + 5_000,
          deadlineAt,
          startedAt,
          async () => {
            while (true) {
              const elapsedMs = Date.now() - cancellationObservationStartedAt;
              const snapshot = cancellationTelemetryCollector.snapshot();
              const terminalReady = cancellationObservationHasTerminalForEveryAcceptedRequest(
                snapshot,
                cancellationRequestStart,
                cancellationReceiptStart
              );
              // Keep the original cleanup observation floor, then stop as soon
              // as every accepted cancel request has a real terminal receipt.
              if (elapsedMs >= CANCEL_OBSERVATION_MIN_MS && terminalReady) {
                cancellationObservationCompleted = true;
                break;
              }
              if (elapsedMs >= CANCEL_OBSERVATION_MAX_MS || Date.now() >= deadlineAt) break;
              await sleep(Math.min(250, CANCEL_OBSERVATION_MAX_MS - elapsedMs));
            }
          }
        );
        report.cancellationObservation = {
          elapsedMs: Date.now() - cancellationObservationStartedAt,
          maxMs: CANCEL_OBSERVATION_MAX_MS,
          terminalCompletedEarly: cancellationObservationCompleted
        };
        await captureScreenshot('cancel-after-switch');
      } else {
        report.cancelTarget.skipped = 'CANCEL_TARGET_NOT_INDEXED';
      }
      const cancellationTelemetry = cancellationTelemetryCollector.snapshot();
      const terminalReceipts = cancellationTelemetry.receipts.slice(cancellationReceiptStart);
      const cancelRequests = cancellationTelemetry.cancelRequests.slice(cancellationRequestStart);
      const switchFinishedAtMs = Date.now();
      const nativeCancellationEvidence = extractStructuredNativeCancellationEvidence({
        receipts: terminalReceipts,
        cancelRequests,
        eventsBeforeSwitch: consoleEvents.slice(0, beforeSwitchCount),
        eventsAfterSwitch: consoleEvents.slice(beforeSwitchCount),
        switchStartedAtMs: switchStarted,
        switchFinishedAtMs,
        collectorIntegrity: cancellationTelemetry
      });
      report.cancellation = {
        delayMs: CANCEL_DELAY_MS,
        eventsBeforeSwitch: consoleEvents.slice(0, beforeSwitchCount).length,
        cleanupEvents: extractLoaderEvent(consoleEvents.slice(beforeSwitchCount), 'MAP mesh effect cleanup'),
        loaderCompleteEvents: extractLoaderEvent(consoleEvents.slice(beforeSwitchCount), 'MAP mesh loader complete'),
        loadRetentionEvents: extractMapLoadRetentionEvents(consoleEvents.slice(beforeSwitchCount)),
        nativeAbortObserved: nativeCancellationEvidence.nativeAbortObserved,
        nativeAbortEvidence: nativeCancellationEvidence.commandCancelled,
        terminalReceipts,
        cancelRequests,
        artifactCancellationReceipts: nativeCancellationEvidence.artifactCancelled,
        unmatchedTerminalReceipts: nativeCancellationEvidence.unmatched,
        duplicateTerminalGroups: nativeCancellationEvidence.duplicateTerminalGroups,
        contradictoryTerminalGroups: nativeCancellationEvidence.contradictoryTerminalGroups,
        receiptCollector: {
          malformedCount: cancellationTelemetry.malformedCount,
          invalidIdentityCount: cancellationTelemetry.invalidIdentityCount,
          invalidTimestampCount: cancellationTelemetry.invalidTimestampCount,
          droppedOversizeLineCount: cancellationTelemetry.droppedOversizeLineCount,
          overflow: cancellationTelemetry.overflow
        },
        correlation: {
          startedRequestIds: nativeCancellationEvidence.startedRequestIds,
          cleanupRequestIds: nativeCancellationEvidence.cleanupRequestIds,
          correlatedRequestIds: nativeCancellationEvidence.correlatedRequestIds,
          acceptedRequestCoverage: nativeCancellationEvidence.acceptedRequestCoverage,
          verification: nativeCancellationEvidence.verification,
          nativeCommandCancellationObserved: nativeCancellationEvidence.nativeCommandCancellationObserved
        },
        note: '仅本次时间窗内 main 接受的 cancel owner/request 与真实 terminal receipt 完整对应，且 outcome=cancelled、requestPhase=command 的终态才计入 nativeAbortObserved；单个终态被观察不等于全部 native active work 已停止，artifact 或缺失/未匹配终态保持 unverified。'
      };
    } else {
      const loadStarted = Date.now();
      const snapshots = [];
      const telemetryPoll = createSingleFlightBounded('map-ui-telemetry', {
        inFlightCode: 'MAP_UI_TELEMETRY_SAMPLE_IN_FLIGHT'
      });
      normalTelemetryPoll = telemetryPoll;
      let complete = false;
      const uiBudgetMs = Math.min(UI_TIMEOUT_MS, Math.max(0, deadlineAt - Date.now()));
      while (Date.now() - loadStarted < uiBudgetMs) {
        if (Date.now() >= deadlineAt) throw new Error('MAP_PROBE_DEADLINE_EXCEEDED: ui-map-load');
        const sampleBudgetMs = Math.min(5_000, Math.max(1_000, deadlineAt - Date.now()));
        const sample = await telemetryPoll.run(
          () => snapshotTelemetryWithProgress(page),
          {
            timeoutMs: sampleBudgetMs,
            timeoutCode: 'MAP_UI_TELEMETRY_SAMPLE_TIMEOUT',
            deadlineAt,
            slowMs: 1_000
          }
        );
        const snapshot = sample.value?.telemetry ?? null;
        const progress = sample.value?.progress ?? null;
        const max = sample.value?.max ?? null;
        if (sample.record.complete !== true) {
          // 大地图上传/解码会暂时占满 renderer 主线程；观察快照超时、
          // underlying evaluate 的晚到终态、失败和 single-flight 等待都
          // 必须保留，最终报告明确标记 telemetry 采样不完整。
          report.telemetrySamplingErrors ??= [];
          report.telemetrySamplingErrors.push({
            elapsedMs: Date.now() - loadStarted,
            message: sample.record.reason ?? sample.record.status,
            status: sample.record.status,
            callId: sample.record.callId,
            pendingCallId: sample.record.pendingCallId,
            timedOut: sample.record.timedOut,
            lateSettled: sample.record.lateSettled,
            failed: sample.record.failed,
            pendingDeadline: sample.record.status === 'pending-deadline',
            error: sample.record.error
          });
        }
        snapshots.push({
          elapsedMs: Date.now() - loadStarted,
          progress: progress === null ? null : Number(progress),
          max: max === null ? null : Number(max),
          telemetry: snapshot,
          sampling: sample.record
        });
        report.telemetrySamplingSingleFlight = telemetryPoll.snapshot();
        if (snapshots.length % 15 === 0) {
          console.log(JSON.stringify({
            type: 'map-probe-progress',
            phase: 'ui-map-load',
            status: 'running',
            elapsedMs: Date.now() - loadStarted,
            totalElapsedMs: Date.now() - startedAt,
            progress: progress === null ? null : Number(progress),
            max: max === null ? null : Number(max)
          }));
        }
        complete = extractLoaderEvent(consoleEvents, 'MAP mesh loader complete').some((event) => !event.text.includes('cancelled: true'))
          || (progress !== null && max !== null && Number(max) > 0 && Number(progress) >= Number(max));
        if (complete) break;
        await sleep(1_000);
      }
      if (!complete && Date.now() >= deadlineAt) throw new Error('MAP_PROBE_DEADLINE_EXCEEDED: ui-map-load');
      let postLoadTelemetry = {
        ready: true,
        wait: null,
        skipped: false,
        reason: null
      };
      if (telemetryPoll.snapshot().pending) {
        const pendingSettlement = await telemetryPoll.waitForPending(5_000, deadlineAt);
        report.telemetrySamplingSingleFlight = telemetryPoll.snapshot();
        postLoadTelemetry.wait = pendingSettlement;
        if (pendingSettlement.settled !== true) {
          postLoadTelemetry = {
            ...postLoadTelemetry,
            ready: false,
            skipped: true,
            reason: 'MAP_UI_TELEMETRY_PENDING_DEADLINE'
          };
          suppressPostLoadTelemetry = true;
          report.telemetrySamplingErrors ??= [];
          report.telemetrySamplingErrors.push({
            elapsedMs: Date.now() - loadStarted,
            message: postLoadTelemetry.reason,
            status: 'pending-deadline',
            pendingCallId: pendingSettlement.record?.pendingCallId ?? telemetryPoll.snapshot().pending?.callId ?? null,
            timedOut: true,
            lateSettled: false,
            failed: false,
            pendingDeadline: true,
            error: null
          });
        }
      }
      let streamLoadEndTelemetry = null;
      if (postLoadTelemetry.ready) {
        await transitionMapBoundariesBounded('stream-load-end', {
          end: ['streamLoad', 'total']
        });
        streamLoadEndTelemetry = await snapshotTelemetryBounded('ui-load-complete', mapBoundarySnapshotOptions);
      }
      report.uiLoad = {
        complete,
        elapsedMs: Date.now() - loadStarted,
        snapshots,
        telemetrySamplingSingleFlight: telemetryPoll.snapshot(),
        postLoadTelemetry,
        loaderPlanEvents: extractLoaderEvent(consoleEvents, 'MAP mesh loader plan'),
        loaderStartCount: extractLoaderEvent(consoleEvents, 'MAP mesh loader start').length,
        loaderCompleteEvents: extractLoaderEvent(consoleEvents, 'MAP mesh loader complete'),
        loadRetentionEvents: extractMapLoadRetentionEvents(consoleEvents),
        telemetryDelta: diffMapTelemetry(mapCanvasEndTelemetry, streamLoadEndTelemetry, 'streamLoad')
      };
      report.mapTelemetry.streamLoad = {
        end: streamLoadEndTelemetry,
        delta: report.uiLoad.telemetryDelta
      };
      report.mapTelemetry.total = diffMapTelemetry(mapOpenBaselineTelemetry, streamLoadEndTelemetry, 'total');
      const planEvents = report.uiLoad.loaderPlanEvents;
      const completeEvents = report.uiLoad.loaderCompleteEvents;
      report.uiLoad.loaderPlanAtMs = planEvents[0]?.atMs ?? null;
      report.uiLoad.loaderCompleteAtMs = completeEvents.at(-1)?.atMs ?? null;
      report.uiLoad.loaderWindowMs = report.uiLoad.loaderPlanAtMs !== null
        && report.uiLoad.loaderCompleteAtMs !== null
        ? Math.max(0, report.uiLoad.loaderCompleteAtMs - report.uiLoad.loaderPlanAtMs)
        : null;
      report.timings.uiLoadMs = report.uiLoad.elapsedMs;
      if (report.rendererProfiler?.stages) {
        report.rendererProfiler.stages.uiLoadMs = report.timings.uiLoadMs;
        report.rendererProfiler.stages.uiLoaderWindowMs = report.uiLoad.loaderWindowMs;
        report.rendererProfiler.stages.loaderPlanAtMs = report.uiLoad.loaderPlanAtMs;
        report.rendererProfiler.stages.loaderCompleteAtMs = report.uiLoad.loaderCompleteAtMs;
      }
      if (postLoadTelemetry.ready) await captureScreenshot('normal-final');
      else report.screenshotSkipped = 'MAP_UI_TELEMETRY_PENDING_DEADLINE';
    }

    await setMainMapTimingPhaseBounded('done');
    // Normal mode closes streamLoad/total at loader completion. Cancel mode
    // has no full-load completion edge, so close only whatever remains open at
    // the final observation point; already-closed windows are untouched.
    await closeOpenMapBoundariesBounded('final-boundary-close');
    // The main-clock end marker is deliberately after renderer total closes,
    // while the BrowserWindow listeners are still attached. This makes the
    // observed interval conservatively contain the complete MAP window.
    await markMapWindowObservation('end');
    await finishAndRecordMapWindowObserver('normal-complete');
    await stopAndRecordRendererProfiler(MODE === 'cancel' ? 'cancel' : 'ui-load');
    report.renderer = {
      finalTelemetry: suppressPostLoadTelemetry
        ? null
        : await runPhase(
          report,
          'telemetry-final',
          15_000,
          deadlineAt,
          startedAt,
          () => snapshotTelemetryBounded('telemetry-final', mapBoundarySnapshotOptions)
        ),
      finalTelemetrySkipped: suppressPostLoadTelemetry
        ? 'MAP_UI_TELEMETRY_PENDING_DEADLINE'
        : null,
      renderPlanEvents: extractLoaderEvent(consoleEvents, 'MAP mesh render plan'),
      mapConsoleEventCount: consoleEvents.length
    };
    if (report.mapTelemetry && report.mapTelemetry.total?.available !== true) {
      const finalBoundary = report.renderer.finalTelemetry;
      report.mapTelemetry.total = diffMapTelemetry(report.mapTelemetry.baselineBeforeMapOpen, finalBoundary, 'total');
      if (report.mapTelemetry.mapCanvas?.end) {
        report.mapTelemetry.streamLoad = {
          end: finalBoundary,
          delta: diffMapTelemetry(report.mapTelemetry.mapCanvas.end, finalBoundary, 'streamLoad')
        };
      }
    }
    report.nativeRequestTelemetry = await snapshotMapApiTimingBounded('native-api-final');
    report.pageErrors = pageErrors.slice(0, 100);
    report.process = processDiagnostics;
    report.consoleTail = consoleEvents.slice(-200);
    report.mainTelemetry = mainTelemetryCollector.snapshot();
    syncNativeTimingSummary();
    syncUnavailableModelTelemetry();
    syncNormalTelemetryPoll();
    finalizeMapStatus(report);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.pageErrors = pageErrors.slice(0, 100);
    report.process = processDiagnostics;
    report.consoleTail = consoleEvents.slice(-200);
    await closeOpenMapBoundariesBounded('failure-boundary-close');
    await markMapWindowObservation('end');
    await finishAndRecordMapWindowObserver('failure');
    report.finalTelemetry = await snapshotTelemetryBounded('failure-final', { includeLongTasks: true, includeSamples: true });
    if (report.mapTelemetry) {
      report.mapTelemetry.total = diffMapTelemetry(report.mapTelemetry.baselineBeforeMapOpen, report.finalTelemetry, 'total');
      if (report.mapTelemetry.mapCanvas?.end) {
        report.mapTelemetry.streamLoad = {
          end: report.finalTelemetry,
          delta: diffMapTelemetry(report.mapTelemetry.mapCanvas.end, report.finalTelemetry, 'streamLoad')
        };
      }
    }
    report.nativeRequestTelemetry = await snapshotMapApiTimingBounded('failure-native-api');
    report.mainTelemetry = mainTelemetryCollector.snapshot();
    syncNativeTimingSummary();
    syncUnavailableModelTelemetry();
    syncNormalTelemetryPoll();
    finalizeMapStatus(report);
    await captureScreenshot('failure');
  } finally {
    await stopAndRecordRendererProfiler(report.error ? 'error' : 'final');
    // If an earlier phase failed before its normal/catch observation edge,
    // still attempt one bounded end snapshot before app.close(). Any failure
    // remains an explicit unverified foreground observation.
    if (!mapWindowObserverFinished && report.foregroundObservation.observerInstalled === true) {
      await markMapWindowObservation('end');
      await finishAndRecordMapWindowObserver('finally');
    }
    // Keep this status in sync even if a late telemetry/profile step fails.
    finalizeMapStatus(report);
    report.elapsedMs = Date.now() - startedAt;
    report.reportPath = join(reportDir, 'report.json');
    // Write a first report before app.close(): if Electron hangs during quit,
    // the functional/renderer evidence and every marker consumed so far remain
    // recoverable on disk.
    report.mainTelemetry = mainTelemetryCollector.snapshot();
    syncNativeTimingSummary();
    syncUnavailableModelTelemetry();
    syncNormalTelemetryPoll();
    writeElectronExitInfo('before-app-close');
    await writeFile(report.reportPath, JSON.stringify(safeJson(report), null, 2), 'utf8');
    if (app) {
      await bounded(app.close().catch(() => undefined), 10_000, 'ELECTRON_CLOSE_TIMEOUT').catch(() => undefined);
      // production-main emits its final main-side marker from before-quit;
      // allow the child stdout pipe to deliver that line before persisting the
      // report, while keeping the wait short and bounded.
      await sleep(100);
    }
    writeElectronExitInfo('after-app-close');
    report.mainTelemetry = mainTelemetryCollector.snapshot();
    syncNativeTimingSummary();
    syncUnavailableModelTelemetry();
    syncNormalTelemetryPoll();
    report.elapsedMs = Date.now() - startedAt;
    await writeFile(report.reportPath, JSON.stringify(safeJson(report), null, 2), 'utf8');
    const safeScratch = resolve(scratchRoot);
    if (!safeScratch.startsWith(resolve(tmpdir()) + sep) || !safeScratch.includes('soulforge-map-streaming-native-')) {
      throw new Error(`Unsafe scratch path: ${safeScratch}`);
    }
    await rm(safeScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch((error) => {
      console.error(`MAP probe scratch cleanup failed: ${error.code ?? error}`);
    });
    const latestRendererProfile = report.rendererProfiler?.profiles?.at(-1) ?? null;
    console.log(JSON.stringify({
      ok: report.ok,
      status: report.status,
      mode: report.mode,
      mapId: report.mapId,
      artifactId: report.artifactSnapshot?.artifactId ?? null,
      crashReporter: report.crashReporter ? {
        mode: report.crashReporter.mode,
        crashDumpsPath: report.crashReporter.crashDumpsPath,
        receiptPath: report.crashReporter.receiptPath,
        entryExitPath: report.crashReporter.entryExitInfoPath,
        exitInfoPath: report.crashReporter.exitInfoPath,
        receiptWritten: existsSync(report.crashReporter.receiptPath),
        entryExitWritten: existsSync(report.crashReporter.entryExitInfoPath),
        exitInfoWritten: existsSync(report.crashReporter.exitInfoPath)
      } : null,
      msb: report.msb ? { ok: report.msb.ok, elapsedMs: report.msb.elapsedMs, modelCount: report.msb.modelCount, partCount: report.msb.partCount } : null,
      geometry: report.geometry ? { ok: report.geometry.ok, pageCount: report.geometry.pageCount, chunkCount: report.geometry.chunkCount, vertexCount: report.geometry.vertexCount } : null,
      uiLoad: report.uiLoad ? { complete: report.uiLoad.complete, elapsedMs: report.uiLoad.elapsedMs, loaderStartCount: report.uiLoad.loaderStartCount } : null,
      mapModelUnavailableTelemetry: report.mapModelUnavailableTelemetry
        ? {
            recordCount: report.mapModelUnavailableTelemetry.recordCount,
            overflow: report.mapModelUnavailableTelemetry.overflow,
            malformedCount: report.mapModelUnavailableTelemetry.malformedCount
          }
        : null,
      cancellation: report.cancellation ? { cleanupEvents: report.cancellation.cleanupEvents.length, loaderCompleteEvents: report.cancellation.loaderCompleteEvents.length, nativeAbortObserved: report.cancellation.nativeAbortObserved } : null,
      nativeRequestTelemetry: report.nativeRequestTelemetry ? {
        installed: report.nativeRequestTelemetry.installed,
        calls: report.nativeRequestTelemetry.calls,
        p95Ms: report.nativeRequestTelemetry.p95Ms,
        maxMs: report.nativeRequestTelemetry.maxMs,
        phaseStats: report.nativeRequestTelemetry.phaseStats
      } : null,
      mainTelemetry: report.mainTelemetry ? {
        observed: report.mainTelemetry.observed,
        installed: report.mainTelemetry.installed,
        handlerWrapped: report.mainTelemetry.handlerWrapped,
        markerCount: report.mainTelemetry.markerCount,
        droppedOversizeLineCount: report.mainTelemetry.droppedOversizeLineCount,
        diagnostics: report.mainTelemetry.diagnostics,
        summary: report.mainTelemetry.summary
          ? {
              calls: report.mainTelemetry.summary.calls,
              okCount: report.mainTelemetry.summary.okCount,
              failedCount: report.mainTelemetry.summary.failedCount,
              averageMs: report.mainTelemetry.summary.averageMs ?? null,
              p50Ms: report.mainTelemetry.summary.p50Ms ?? null,
              p95Ms: report.mainTelemetry.summary.p95Ms ?? null,
              maxMs: report.mainTelemetry.summary.maxMs,
              quantileSample: report.mainTelemetry.summary.quantileSample ?? null,
              powerEvents: report.mainTelemetry.summary.powerEvents ?? null,
              backgroundThrottlingValues: [...new Set((report.mainTelemetry.summary.recentCalls ?? [])
                .map((entry) => entry.backgroundThrottling)
                .filter((value) => typeof value === 'boolean'))],
              backgroundThrottlingSources: [...new Set((report.mainTelemetry.summary.recentCalls ?? [])
                .map((entry) => entry.backgroundThrottlingSource)
                .filter((value) => typeof value === 'string'))],
              stateTransitions: (report.mainTelemetry.summary.stateTransitions ?? []).slice(-16),
              characterNativeTimingSummaryByPhase: report.mainTelemetry.summary.characterNativeTimingSummaryByPhase ?? null,
              characterMainTimingSummaryByPhase: report.mainTelemetry.summary.characterMainTimingSummaryByPhase ?? null
            }
          : null
      } : null,
      nativeTimingSummaryByPhase: report.nativeTimingSummaryByPhase,
      characterNativeTimingSummaryByPhase: report.characterNativeTimingSummaryByPhase,
      characterMainTimingSummaryByPhase: report.characterMainTimingSummaryByPhase,
      rendererProfiler: report.rendererProfiler ? {
        target: report.rendererProfiler.target,
        profiles: report.rendererProfiler.profiles?.map((profile) => ({
          phase: profile.phase,
          profilePath: profile.profilePath ?? null,
          sampleCount: profile.summary?.sampleCount ?? null,
          topFunction: profile.summary?.topFunctions?.[0] ?? null
        })) ?? [],
        latestProfilePath: latestRendererProfile?.profilePath ?? null
      } : null,
      screenshots: report.screenshots ?? null,
      reportPath: report.reportPath,
      error: report.error
    }));
    process.exitCode = report.ok ? 0 : 1;
  }
}

if (FIXTURE_ONLY) {
  const fixtureReport = await runMapTelemetryFixtures();
  console.log(JSON.stringify(fixtureReport, null, 2));
  process.exitCode = fixtureReport.pass ? 0 : 1;
} else {
  await main();
}
