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
 * 默认运行 normal；传 --cancel 可运行切图取消观测。真实 native 请求没有
 * AbortSignal 公共入口，因此报告会把 renderer cleanup 与 native IPC 取消严格分开。
 * 传 --fixture 只运行本文件内的累计窗口/状态夹具，不启动 Electron 或读取资源。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import {
  assertAgentProductionArtifactSnapshotFresh,
  createAgentProductionArtifactSnapshot
} from './agent-production-build-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
          error: thrown ? String(thrown?.message ?? thrown) : null
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

function extractNativeAbortEvidence(events, stdoutTail) {
  const explicit = events.filter((entry) => /nativeAbortObserved\s*[:=]\s*true/i.test(entry.text));
  if (/nativeAbortObserved\s*[:=]\s*true/i.test(stdoutTail)) {
    explicit.push({ source: 'main-stdout', text: 'nativeAbortObserved: true' });
  }
  return explicit;
}

/**
 * 增量读取 production-main 在真实 IPC handler 外层输出的 main-side MAP
 * marker。不能在 finally 里只解析 stdoutTail：tail 会把早期 installed marker
 * 挤掉，而且 Electron 的 stdout chunk 可能把一行拆开。这里每次收到 chunk 都
 * 按完整行消费，只保留有限的 call/window 变化与汇总。
 */
function createMainMapTelemetryCollector() {
  const marker = '[SF_MAP_MAIN_TELEMETRY]';
  const state = {
    buffer: '',
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
      state.buffer += String(chunk ?? '');
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
      // A renderer/native failure must not let an unterminated child line grow
      // without bound while the probe is waiting for its phase timeout.
      if (state.buffer.length > 64_000) state.buffer = state.buffer.slice(-64_000);
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
  const sampleErrors = Array.isArray(report.telemetrySamplingErrors) ? report.telemetrySamplingErrors.length : 0;
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
    responsivenessReason = `telemetry sampling incomplete (${sampleErrors} timeout(s))`;
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
  const timeoutReport = makeReport({
    mapTelemetry: { total: completeMapDelta },
    telemetrySamplingErrors: [{ phase: 'fixture', message: 'MAP_UI_TELEMETRY_SAMPLE_TIMEOUT' }]
  });
  finalizeMapStatus(timeoutReport, 'normal');
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
      pass: timeoutReport.status.responsivenessVerified === false
        && timeoutReport.status.responsivenessReason.includes('sampling incomplete')
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
      && timeoutReport.status.responsivenessReason.includes('sampling incomplete')
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

async function runMapTelemetryFixtures() {
  const raf = runRafAccountingFixture();
  const boundaries = runRafBoundaryFixture();
  const status = runMapStatusFixture();
  const windowObserver = await runMapWindowObserverFixture();
  return {
    mode: 'fixture',
    raf,
    boundaries,
    status,
    windowObserver,
    pass: raf.pass === true
      && boundaries.pass === true
      && status.pass === true
      && windowObserver.pass === true
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

  const report = {
    ok: false,
    mode: MODE,
    mapId: MAP_ID,
    requestedModel: REQUESTED_MODEL,
    mapRelativePath: MAP_RELATIVE_PATH,
    gameRoot: GAME_ROOT,
    overlayRoot: OVERLAY_ROOT,
    sourceModWrites: false,
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
      cancellation: 'renderer effect cleanup/queue result only; public API has no AbortSignal'
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
    timings: {},
    errors: []
  };

  let app;
  let page;
  let productionMain = LIVE_PRODUCTION_MAIN;
  let productionSnapshotRoot = null;
  let rendererProfiler = null;
  let mapWindowObserverFinished = false;
  const consoleEvents = [];
  const pageErrors = [];
  const processDiagnostics = { pid: null, exitCode: null, signal: null, stdoutTail: '', stderrTail: [] };
  const mainTelemetryCollector = createMainMapTelemetryCollector();
  const startedAt = Date.now();
  const deadlineAt = startedAt + TOTAL_TIMEOUT_MS;
  report.deadline = {
    timeoutMs: TOTAL_TIMEOUT_MS,
    at: new Date(deadlineAt).toISOString()
  };
  const captureScreenshot = async (name) => {
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
  const snapshotTelemetryBounded = async (phase, options = {}) => {
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
    app = await runPhase(
      report,
      'electron-launch',
      60_000,
      deadlineAt,
      startedAt,
      () => electron.launch({
        cwd: productionSnapshotRoot,
        args: [productionMain, `--user-data-dir=${userDataDir}`],
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
      processDiagnostics.stdoutTail = (processDiagnostics.stdoutTail + text).slice(-32_768);
    });
    child.stderr?.on('data', (chunk) => {
      processDiagnostics.stderrTail.push(String(chunk));
      if (processDiagnostics.stderrTail.length > 200) processDiagnostics.stderrTail.shift();
    });
    child.on('exit', (code, signal) => {
      processDiagnostics.exitCode = code;
      processDiagnostics.signal = signal;
    });
    page = await runPhase(report, 'electron-first-window', 60_000, deadlineAt, startedAt, () => app.firstWindow());
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('crash', () => pageErrors.push('RENDERER_CRASH'));
    page.on('console', (message) => {
      const text = message.text();
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
        await runPhase(report, 'cancel-cleanup-observation-window', 15_000, deadlineAt, startedAt, () => page.waitForTimeout(5_000));
        await captureScreenshot('cancel-after-switch');
      } else {
        report.cancelTarget.skipped = 'CANCEL_TARGET_NOT_INDEXED';
      }
      const nativeAbortEvidence = extractNativeAbortEvidence(consoleEvents.slice(beforeSwitchCount), processDiagnostics.stdoutTail);
      report.cancellation = {
        delayMs: CANCEL_DELAY_MS,
        eventsBeforeSwitch: consoleEvents.slice(0, beforeSwitchCount).length,
        cleanupEvents: extractLoaderEvent(consoleEvents.slice(beforeSwitchCount), 'MAP mesh effect cleanup'),
        loaderCompleteEvents: extractLoaderEvent(consoleEvents.slice(beforeSwitchCount), 'MAP mesh loader complete'),
        nativeAbortObserved: nativeAbortEvidence.length > 0,
        nativeAbortEvidence,
        note: '只有明确的 nativeAbortObserved:true 证据才会置 true；renderer cleanup/loader cancelled 不会被当作 native IPC abort。当前 readMapStaticGeometry 公共 API 不接收 AbortSignal。'
      };
    } else {
      const loadStarted = Date.now();
      const snapshots = [];
      let complete = false;
      const uiBudgetMs = Math.min(UI_TIMEOUT_MS, Math.max(0, deadlineAt - Date.now()));
      while (Date.now() - loadStarted < uiBudgetMs) {
        if (Date.now() >= deadlineAt) throw new Error('MAP_PROBE_DEADLINE_EXCEEDED: ui-map-load');
        const sampleBudgetMs = Math.min(5_000, Math.max(1_000, deadlineAt - Date.now()));
        let snapshot = null;
        try {
          snapshot = await bounded(snapshotTelemetry(page), sampleBudgetMs, 'MAP_UI_TELEMETRY_SAMPLE_TIMEOUT');
        } catch (error) {
          // 大地图上传/解码会暂时占满 renderer 主线程；观察快照超时本身是
          // 长帧证据，但不应让探针在 UI 仍可继续完成时提前终止。保留每次
          // 超时及时间点，最终报告明确标记 telemetry 采样不完整。
          report.telemetrySamplingErrors ??= [];
          report.telemetrySamplingErrors.push({
            elapsedMs: Date.now() - loadStarted,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        const progress = await page.locator('progress[aria-label="地图模型加载进度"]').getAttribute('value', { timeout: 2_000 }).catch(() => null);
        const max = await page.locator('progress[aria-label="地图模型加载进度"]').getAttribute('max', { timeout: 2_000 }).catch(() => null);
        snapshots.push({ elapsedMs: Date.now() - loadStarted, progress: progress === null ? null : Number(progress), max: max === null ? null : Number(max), telemetry: snapshot });
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
      await transitionMapBoundariesBounded('stream-load-end', {
        end: ['streamLoad', 'total']
      });
      const streamLoadEndTelemetry = await snapshotTelemetryBounded('ui-load-complete', mapBoundarySnapshotOptions);
      report.uiLoad = {
        complete,
        elapsedMs: Date.now() - loadStarted,
        snapshots,
        loaderPlanEvents: extractLoaderEvent(consoleEvents, 'MAP mesh loader plan'),
        loaderStartCount: extractLoaderEvent(consoleEvents, 'MAP mesh loader start').length,
        loaderCompleteEvents: extractLoaderEvent(consoleEvents, 'MAP mesh loader complete'),
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
      await captureScreenshot('normal-final');
    }

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
      finalTelemetry: await runPhase(
        report,
        'telemetry-final',
        15_000,
        deadlineAt,
        startedAt,
        () => snapshotTelemetryBounded('telemetry-final', mapBoundarySnapshotOptions)
      ),
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
    await writeFile(report.reportPath, JSON.stringify(safeJson(report), null, 2), 'utf8');
    if (app) {
      await bounded(app.close().catch(() => undefined), 10_000, 'ELECTRON_CLOSE_TIMEOUT').catch(() => undefined);
      // production-main emits its final main-side marker from before-quit;
      // allow the child stdout pipe to deliver that line before persisting the
      // report, while keeping the wait short and bounded.
      await sleep(100);
    }
    report.mainTelemetry = mainTelemetryCollector.snapshot();
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
      msb: report.msb ? { ok: report.msb.ok, elapsedMs: report.msb.elapsedMs, modelCount: report.msb.modelCount, partCount: report.msb.partCount } : null,
      geometry: report.geometry ? { ok: report.geometry.ok, pageCount: report.geometry.pageCount, chunkCount: report.geometry.chunkCount, vertexCount: report.geometry.vertexCount } : null,
      uiLoad: report.uiLoad ? { complete: report.uiLoad.complete, elapsedMs: report.uiLoad.elapsedMs, loaderStartCount: report.uiLoad.loaderStartCount } : null,
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
              stateTransitions: (report.mainTelemetry.summary.stateTransitions ?? []).slice(-16)
            }
          : null
      } : null,
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
