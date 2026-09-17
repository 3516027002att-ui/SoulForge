/**
 * 真实 Agent 链路模拟。
 *
 * 本文件只负责隔离语料、驱动 Electron、收集证据与判定结果。Agent、工具、
 * Patch Engine、Bridge、SQLite、rollout 和 Evidence 台账全部由生产 main/preload
 * 提供；这里禁止直接导入 core 或 desktop 源码重建第二套宿主。
 */

import { createHash } from 'node:crypto';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

import {
  assertAgentProductionArtifactSnapshotFresh,
  assertAgentProductionBuildFresh
} from './agent-production-build-lib.mjs';
import {
  decideScratchCleanup,
  evaluateGoalCoverage,
  evaluateRollbackVerification,
  planSemanticCorpus,
  rollbackCommittedOperations,
  safeHarnessFileLabel,
  SEMANTIC_CORPUS_KINDS,
  waitForSemanticReadiness
} from './real-agent-harness-lib.mjs';
import { loadTestAgentProvider } from './testing/test-agent-provider.mjs';
import { parseGoalContract, matchesAssertion, readAssertionPath } from './real-agent-goal-contract.mjs';
import { getFourTask } from './testing/real-agent-four-task-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const CONFIGURED_SNAPSHOT_ROOT_VALUE = process.env.SF_PRODUCTION_ARTIFACT_SNAPSHOT_ROOT?.trim() || null;
const CONFIGURED_SNAPSHOT_ROOT = CONFIGURED_SNAPSHOT_ROOT_VALUE
  ? resolve(REPO_ROOT, CONFIGURED_SNAPSHOT_ROOT_VALUE)
  : null;
const PRODUCTION_MAIN = CONFIGURED_SNAPSHOT_ROOT
  ? resolve(CONFIGURED_SNAPSHOT_ROOT, 'apps/desktop/e2e/playwright/production-main.mjs')
  : resolve(REPO_ROOT, 'apps/desktop/e2e/playwright/production-main.mjs');
const GAME_ROOT = process.env.SOULFORGE_SEKIRO_ROOT
  ?? 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
const MOD_ROOT = process.env.SOULFORGE_SEKIRO_MOD_ROOT
  ?? join(GAME_ROOT, 'mods');
const DEFAULT_TASK_QUERY = '把鬼刑部改为精英怪，血条改为2，死亡后掉落靛蓝星陨';
const DEFAULT_GOALS = Object.freeze([
  Object.freeze({
    goalId: 'gyoubu-elite-health-bars',
    kind: 'param-field',
    table: 'NpcParam',
    rowId: 50800000,
    fieldId: 'ninsatuNum',
    expectedValue: 2,
    required: true
  }),
  Object.freeze({
    goalId: 'gyoubu-indigo-meteor-drop',
    kind: 'param-field',
    table: 'NpcParam',
    rowId: 50800000,
    fieldId: 'itemLotId_1',
    expectedValue: 90017000,
    required: true
  })
]);

const CLI_OPTIONS = parseCliOptions(process.argv.slice(2));
const AGENT_PROVIDER = CLI_OPTIONS.provider ?? process.env.SOULFORGE_AGENT_PROVIDER?.trim() ?? null;
const AGENT_CONFIG_ID = CLI_OPTIONS.configId ?? process.env.SOULFORGE_AGENT_CONFIG_ID?.trim() ?? null;
const AGENT_TEST_CONFIG_PATH = CLI_OPTIONS.testConfig ?? process.env.SOULFORGE_AGENT_TEST_CONFIG_PATH?.trim() ?? null;
const AGENT_RUNTIME = CLI_OPTIONS.runtime ?? process.env.SOULFORGE_AGENT_RUNTIME?.trim() ?? 'unpacked';
const AGENT_EXE_PATH = CLI_OPTIONS.exe ?? process.env.SOULFORGE_AGENT_EXE?.trim() ?? null;
const WRITE_MODE = CLI_OPTIONS.write === true || CLI_OPTIONS.observationOnly !== true;
const SELECTED_TEST_TASK = CLI_OPTIONS.testset ? getFourTask(CLI_OPTIONS.testset) : null;
const TASK_QUERY = CLI_OPTIONS.query ?? SELECTED_TEST_TASK?.query ?? DEFAULT_TASK_QUERY;
const SAFE_TIMESTAMP = new Date().toISOString().replace(/[:.]/gu, '-');
const REPORT_LABEL = safeFileLabel(CLI_OPTIONS.label ?? 'real-agent');
const MAX_STEPS = positiveInteger(
  CLI_OPTIONS.maxSteps ?? process.env.SOULFORGE_REAL_AGENT_MAX_STEPS,
  200
);
const REQUEST_TIMEOUT_MS = positiveInteger(
  CLI_OPTIONS.timeoutMs ?? process.env.SOULFORGE_REAL_AGENT_TIMEOUT_MS,
  180_000
);
const MAX_OUTPUT_TOKENS = positiveInteger(
  CLI_OPTIONS.maxOutputTokens ?? process.env.SOULFORGE_REAL_AGENT_MAX_OUTPUT_TOKENS,
  60_000
);
const SESSION_TIMEOUT_MS = positiveInteger(
  CLI_OPTIONS.sessionTimeoutMs ?? process.env.SOULFORGE_REAL_AGENT_SESSION_TIMEOUT_MS,
  45 * 60_000
);
const AGENT_STOP_FILE = process.env.SOULFORGE_AGENT_STOP_FILE?.trim() || null;
const AGENT_STOP_POLL_MS = positiveInteger(process.env.SOULFORGE_AGENT_STOP_POLL_MS, 500);
const WORKSPACE_PREP_TIMEOUT_MS = positiveInteger(
  CLI_OPTIONS.workspaceTimeoutMs ?? process.env.SOULFORGE_REAL_AGENT_WORKSPACE_TIMEOUT_MS,
  5 * 60_000
);
const SEMANTIC_PREFLIGHT_TIMEOUT_MS = positiveInteger(CLI_OPTIONS.semanticTimeoutMs, 5 * 60_000);
const EXEC_FILE = promisify(execFileCallback);
const RUNNER_POLICY_PATH = fileURLToPath(import.meta.url);
const RUNNER_POLICY_SHA256 = await sha256FileOrNull(RUNNER_POLICY_PATH);
const SUPERVISOR_POLICY_PATH = process.env.SOULFORGE_AGENT_SUPERVISOR_PATH?.trim() || null;
const SUPERVISOR_POLICY_SHA256 = process.env.SOULFORGE_AGENT_SUPERVISOR_SHA256?.trim() || null;
const EXPECTED_RUNNER_POLICY_SHA256 = process.env.SOULFORGE_AGENT_RUNNER_SHA256?.trim() || null;
const SUPERVISOR_PID = positiveInteger(process.env.SOULFORGE_AGENT_SUPERVISOR_PID, null);
const SUPERVISOR_GENERATION = process.env.SOULFORGE_AGENT_SUPERVISOR_GENERATION?.trim() || null;
const SUPERVISOR_RUN_LABEL = process.env.SOULFORGE_AGENT_SUPERVISOR_RUN_LABEL?.trim() || null;
const CLEANUP_EVALUATE_TIMEOUT_MS = positiveInteger(process.env.SOULFORGE_REAL_AGENT_CLEANUP_EVALUATE_TIMEOUT_MS, 2_000);
const ELECTRON_CLOSE_TIMEOUT_MS = positiveInteger(process.env.SOULFORGE_REAL_AGENT_ELECTRON_CLOSE_TIMEOUT_MS, 5_000);
const PROCESS_QUERY_TIMEOUT_MS = positiveInteger(process.env.SOULFORGE_REAL_AGENT_PROCESS_QUERY_TIMEOUT_MS, 5_000);
const PROCESS_TREE_KILL_GRACE_MS = positiveInteger(process.env.SOULFORGE_REAL_AGENT_PROCESS_TREE_KILL_GRACE_MS, 5_000);

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function sha256FileOrNull(filePath) {
  try {
    const bytes = await readFile(filePath);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

function parseCliOptions(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--observe') {
      options.observationOnly = true;
      continue;
    }
    if (arg === '--write' || arg === '--apply-overlay') {
      options.write = true;
      continue;
    }
    const next = args[index + 1];
    if (arg === '--query' && typeof next === 'string' && next.trim() !== '') {
      options.query = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--goals' && typeof next === 'string' && next.trim() !== '') {
      options.goals = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--testset' && typeof next === 'string' && next.trim() !== '') {
      options.testset = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--label' && typeof next === 'string' && next.trim() !== '') {
      options.label = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--provider' && typeof next === 'string' && next.trim() !== '') {
      options.provider = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--config-id' && typeof next === 'string' && next.trim() !== '') {
      options.configId = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--test-config' && typeof next === 'string' && next.trim() !== '') {
      options.testConfig = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--runtime' && typeof next === 'string' && next.trim() !== '') {
      options.runtime = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--exe' && typeof next === 'string' && next.trim() !== '') {
      options.exe = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--max-steps' && typeof next === 'string') {
      options.maxSteps = next;
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms' && typeof next === 'string') {
      options.timeoutMs = next;
      index += 1;
      continue;
    }
    if (arg === '--session-timeout-ms' && typeof next === 'string') {
      options.sessionTimeoutMs = next;
      index += 1;
      continue;
    }
    if (arg === '--workspace-timeout-ms' && typeof next === 'string') {
      options.workspaceTimeoutMs = next;
      index += 1;
      continue;
    }
    if (arg === '--semantic-timeout-ms' && typeof next === 'string') {
      options.semanticTimeoutMs = next;
      index += 1;
      continue;
    }
    if (arg === '--max-output-tokens' && typeof next === 'string') {
      options.maxOutputTokens = next;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && !arg.startsWith('-')) positional.push(arg);
  }
  if (options.query === undefined && positional.length > 0) {
    options.query = positional.join(' ').trim();
  }
  return options;
}

function safeFileLabel(value) {
  // Supervisor labels include the per-start generation. Keep enough of the
  // label to preserve that identity; the supervisor itself still bounds the
  // run count and query suffix, so this stays well below Windows path limits.
  return safeHarnessFileLabel(value, 128);
}

function printHelp() {
  console.log([
    'SoulForge 真实生产 Agent 链路模拟',
    '',
    '默认任务检查内置的两个 PARAM 字段；四题 --testset 会额外执行独立的 native 语义目标验收。',
    '其它任务传 --goals JSON 检查指定字段，或 --observe 仅观察原文任务执行。',
    '四题只有在写回、Bridge 重读、语义证据和回滚均通过时才会报告 verified；字段命中本身不等于整题完成。',
    '',
    '用法：',
    '  npm run agent:simulate',
    '  npm run agent:simulate -- "你的原始修改指令" --goals "[...]"',
    '  npm run agent:simulate -- --query "你的修改任务" --goals "[...]" --label "任务名"',
    '  npm run agent:simulate -- "你的原始修改指令" --observe --label "观察任务"',
    '  npm run agent:simulate -- --provider test --test-config "D:/.../test"',
    '  npm run agent:simulate -- --provider vault --config-id "<vault-config-id>"',
    '',
    'PARAM goal 格式：',
    '  [{"goalId":"g1","kind":"param-field","table":"NpcParam","rowId":50800000,"fieldId":"ninsatuNum","expectedValue":2,"required":true}]',
    '',
    '可选参数：',
    '  --query <文本>                 覆盖默认任务',
    '  --goals <JSON>                冻结的机器可验证终态目标',
    '  --observe                     观察模式，可省略 goals；不作任务通过声明',
    '  --write                       显式启用隔离 overlay 写回闭环',
    '  --apply-overlay               --write 的兼容别名',
    '  --testset <名称>              使用机器可验证测试清单（four-1 到 four-4；four 由批处理入口展开）',
    '  --label <名称>                报告文件名前缀',
    '  --provider test|vault          显式选择测试 provider 或隔离 vault provider',
    '  --config-id <id>              vault provider 的模型服务 ID',
    '  --test-config <路径>          加密 test provider 配置路径',
    '  --runtime unpacked|installed  默认 unpacked；installed 需要 --exe',
    '  --exe <路径>                  已安装 SoulForge.exe 路径',
    '  --max-steps <整数>            默认 200',
    '  --timeout-ms <整数>           单次模型请求超时，默认 180000',
    '  --workspace-timeout-ms <整数> 工作区打开/轻量扫描超时，默认 300000',
    '  --semantic-timeout-ms <整数>  首批 PARAM/MSG 语义预热等待，默认 300000',
    '  --session-timeout-ms <整数>   整个会话超时，默认 2700000',
    '  --max-output-tokens <整数>    总输出预算，默认 60000'
  ].join('\n'));
}

function harnessError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function parseGoals(raw) {
  try {
    const selectedGoals = raw === undefined && SELECTED_TEST_TASK
      ? JSON.stringify(SELECTED_TEST_TASK.goals)
      : raw;
    return parseGoalContract(selectedGoals, {
      observationOnly: CLI_OPTIONS.observationOnly === true,
      taskQuery: TASK_QUERY,
      defaultTaskQuery: DEFAULT_TASK_QUERY,
      defaultGoals: SELECTED_TEST_TASK?.goals ?? DEFAULT_GOALS
    });
  } catch (error) {
    throw harnessError(
      error?.code ?? 'GOAL_CONTRACT_INVALID',
      error instanceof Error ? error.message : String(error),
      error?.details
    );
  }
}

function log(message) {
  process.stderr.write(`[real-agent] ${message}\n`);
}

function redactString(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|password|secret|authorization|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu, '$1[REDACTED]')
    // Reports and durable test evidence are portable artifacts.  Keep logical
    // file://param/... identities, but never persist the host's drive path or
    // the temporary user-data/scratch path.
    .replace(/file:\/\/\/(?:[A-Za-z]:[\\/]|\/)[^"'\s}]+/gu, 'file://[LOCAL_PATH]')
    .replace(/\b[A-Za-z]:[\\/][^"'{}\r\n]+/gu, '[LOCAL_PATH]')
    .replace(/\\\\[^"'{}\r\n\s]+/gu, '[LOCAL_PATH]');
}

function sanitizeForReport(value, key = '') {
  if (/^(?:apiKey|password|secret|authorization|token)$/iu.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((child) => sanitizeForReport(child));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => (
      [childKey, sanitizeForReport(child, childKey)]
    )));
  }
  return value;
}

async function assertDirectory(directory, label) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw harnessError('CORPUS_DIRECTORY_INVALID', `${label} 不是目录：${directory}`);
}

async function copySemanticWorkspace(overlayRoot) {
  await assertDirectory(MOD_ROOT, '真实 Mod 根目录');
  await assertDirectory(GAME_ROOT, '真实游戏根目录');
  await mkdir(overlayRoot, { recursive: true });
  const entries = await readdir(MOD_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (SEMANTIC_CORPUS_KINDS.includes(entry.name) && !entry.isDirectory()) {
      throw harnessError('CORPUS_DIRECTORY_INVALID', `${entry.name} 必须是实际目录，不能是文件或符号链接。`);
    }
  }
  const manifest = planSemanticCorpus(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  // Existing baseline directories remain mandatory; missing optional action/chr
  // are explicitly diagnosed and never represented as copied coverage.
  for (const kind of ['param', 'msg', 'event', 'map', 'script']) {
    await assertDirectory(join(MOD_ROOT, kind), `真实 ${kind} 语料`);
  }
  for (const kind of manifest.copiedKinds) {
    const source = join(MOD_ROOT, kind);
    await assertDirectory(source, `真实 ${kind} 语料`);
    await cp(source, join(overlayRoot, kind), { recursive: true });
    log(`已复制真实 ${kind} 语料到隔离 overlay。`);
  }
  for (const diagnostic of manifest.diagnostics) log(`${diagnostic.code}: ${diagnostic.message}`);
  return manifest;
}

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

function livePolicyIdentity() {
  return {
    runnerPath: portablePath(RUNNER_POLICY_PATH),
    runnerSha256: RUNNER_POLICY_SHA256,
    runnerSha256Expected: EXPECTED_RUNNER_POLICY_SHA256,
    supervisorPath: SUPERVISOR_POLICY_PATH ? portablePath(SUPERVISOR_POLICY_PATH) : null,
    supervisorSha256: SUPERVISOR_POLICY_SHA256,
    supervisorPid: SUPERVISOR_PID,
    supervisorGeneration: SUPERVISOR_GENERATION,
    supervisorRunLabel: SUPERVISOR_RUN_LABEL
  };
}

async function snapshotTree(root) {
  const entries = [];
  const visit = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const path = portablePath(relative(root, absolute));
      if (child.isDirectory()) {
        entries.push({ type: 'directory', path });
        await visit(absolute);
      } else if (child.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({
          type: 'file',
          path,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        });
      } else if (child.isSymbolicLink()) {
        entries.push({ type: 'symlink', path, target: await readlink(absolute) });
      }
    }
  };
  await visit(root);
  const encoded = entries.map((entry) => JSON.stringify(entry)).join('\n');
  return {
    sha256: createHash('sha256').update(encoded, 'utf8').digest('hex'),
    entries,
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.bytes : 0), 0)
  };
}

function diffTrees(before, after) {
  const left = new Map(before.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
  const right = new Map(after.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a.localeCompare(b, 'en'));
  return paths.filter((path) => left.get(path) !== right.get(path)).slice(0, 100);
}

function summarizeTree(tree) {
  if (!tree) return null;
  return {
    sha256: tree.sha256,
    fileCount: tree.fileCount,
    totalBytes: tree.totalBytes
  };
}

function isWithin(base, target) {
  const root = resolve(base);
  const candidate = resolve(target);
  return candidate === root || candidate.startsWith(root + sep);
}

function resolveWithin(base, relativePath, code) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw harnessError(code, '生产终态没有提供可用的相对产物路径。');
  }
  const absolute = resolve(base, relativePath.replace(/^[\\/]+/u, ''));
  if (!isWithin(base, absolute)) throw harnessError(code, '生产终态产物路径越过隔离目录。');
  return absolute;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout(promise, timeoutMs, code, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(harnessError(code, message, { timeoutMs })), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function eventKey(envelope) {
  return `${envelope.sessionId}:${envelope.seq}`;
}

function mergeEvents(target, additions, sessionId) {
  for (const envelope of additions ?? []) {
    if (!envelope || envelope.sessionId !== sessionId || !Number.isSafeInteger(envelope.seq) || envelope.seq < 1) continue;
    const key = eventKey(envelope);
    if (!target.has(key)) target.set(key, envelope);
  }
}

function orderedEvents(map) {
  return [...map.values()].sort((left, right) => left.seq - right.seq);
}

function contiguousSequence(events) {
  let expected = 1;
  for (const envelope of events) {
    if (envelope.seq < expected) continue;
    if (envelope.seq !== expected) break;
    expected += 1;
  }
  return expected - 1;
}

function sequenceGaps(events) {
  if (events.length === 0) return [];
  const present = new Set(events.map((event) => event.seq));
  const gaps = [];
  for (let seq = 1; seq <= events.at(-1).seq; seq += 1) {
    if (!present.has(seq)) gaps.push(seq);
    if (gaps.length >= 100) break;
  }
  return gaps;
}

async function collectPushedEvents(window) {
  return window.evaluate(() => {
    const queued = Array.isArray(globalThis.__sfAgentHarnessEvents)
      ? globalThis.__sfAgentHarnessEvents.splice(0)
      : [];
    return queued;
  });
}

async function waitForAgentTerminal(window, sessionId) {
  const collected = new Map();
  const loggedToolEnds = new Set();
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  let cancelledForTimeout = false;
  let cancelledForStop = false;
  let stopFileRequested = false;
  let timeoutGraceDeadline = null;
  let cancellationGraceDeadline = null;
  while (true) {
    mergeEvents(collected, await collectPushedEvents(window), sessionId);
    const replayAfter = contiguousSequence(orderedEvents(collected));
    const replay = await window.evaluate(
      async ({ id, afterSeq }) => globalThis.soulforge.getAiAgentEvents(id, afterSeq),
      { id: sessionId, afterSeq: replayAfter }
    );
    if (!replay?.ok) {
      throw harnessError('AGENT_EVENT_REPLAY_FAILED', replay?.error?.message ?? 'Agent 事件回放失败。', replay);
    }
    mergeEvents(collected, replay.events, sessionId);
    const events = orderedEvents(collected);
    for (const envelope of events) {
      const event = envelope.event;
      if (event?.type !== 'tool-call-end' || loggedToolEnds.has(envelope.seq)) continue;
      loggedToolEnds.add(envelope.seq);
      log(`step=${event.step} tool=${event.name} ok=${event.ok}${event.code ? ` code=${event.code}` : ''}`);
    }
    const terminal = [...events].reverse().find((envelope) => (
      envelope.event?.type === 'session-done' || envelope.event?.type === 'session-error'
    ));
    if (terminal) return {
      events,
      terminal,
      cancelledForTimeout,
      cancelledForStop,
      stopFileRequested
    };

    if (!cancelledForStop && AGENT_STOP_FILE && await fileExists(AGENT_STOP_FILE)) {
      cancelledForStop = true;
      stopFileRequested = true;
      cancellationGraceDeadline = Date.now() + 30_000;
      log(`检测到单次 Agent 停止文件，已请求生产宿主优雅取消：${portablePath(AGENT_STOP_FILE)}。`);
      await window.evaluate((id) => globalThis.soulforge.cancelAiAgent(id), sessionId).catch(() => undefined);
    } else if (!cancelledForTimeout && Date.now() >= deadline) {
      cancelledForTimeout = true;
      timeoutGraceDeadline = Date.now() + 30_000;
      log(`整个 Agent 会话超过 ${SESSION_TIMEOUT_MS} ms，已请求生产宿主取消。`);
      await window.evaluate((id) => globalThis.soulforge.cancelAiAgent(id), sessionId).catch(() => undefined);
    } else if (cancelledForStop && Date.now() >= cancellationGraceDeadline) {
      throw harnessError('AGENT_SESSION_TERMINAL_TIMEOUT', '停止文件触发取消后 30 秒仍未收到生产终态。');
    } else if (cancelledForTimeout && Date.now() >= timeoutGraceDeadline) {
      throw harnessError('AGENT_SESSION_TERMINAL_TIMEOUT', '取消后 30 秒仍未收到生产终态。');
    }
    await sleep(AGENT_STOP_POLL_MS);
  }
}

function eventSummary(events) {
  const toolEvents = events
    .filter((envelope) => envelope.event?.type === 'tool-call-begin' || envelope.event?.type === 'tool-call-end')
    .map((envelope) => {
      const event = envelope.event;
      return {
        seq: envelope.seq,
        type: event.type,
        step: event.step,
        callId: event.callId,
        name: event.name,
        ...(event.type === 'tool-call-begin' && typeof event.argumentsJson === 'string'
          ? { argumentsJson: event.argumentsJson }
          : {}),
        ...(event.type === 'tool-call-end'
          ? { ok: event.ok, ...(event.code ? { code: event.code } : {}) }
          : {})
      };
    });
  return {
    count: events.length,
    lastSeq: events.at(-1)?.seq ?? 0,
    seqGaps: sequenceGaps(events),
    lifecycle: events
      .filter((envelope) => /^session-|^turn-complete$/u.test(envelope.event?.type ?? ''))
      .map((envelope) => ({ seq: envelope.seq, event: envelope.event })),
    toolEvents,
    thinkingDeltaCount: events.filter((envelope) => envelope.event?.type === 'agent-thinking-delta').length,
    assistantDeltaCount: events.filter((envelope) => envelope.event?.type === 'agent-message-delta').length
  };
}

function sameValue(observed, expected) {
  if (typeof expected === 'number' && typeof observed === 'string' && observed.trim() !== '') {
    return /^-?(?:0|[1-9]\d*)$/u.test(observed.trim())
      && Number.isSafeInteger(Number(observed))
      && Number(observed) === expected;
  }
  if (typeof expected === 'boolean' && typeof observed === 'number') return Boolean(observed) === expected;
  return Object.is(observed, expected);
}

function collectNativeSourceFacts(value, facts = { hashes: [], revisions: [], uris: [] }, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return facts;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) collectNativeSourceFacts(item, facts, depth + 1);
    return facts;
  }
  if (typeof value !== 'object') return facts;
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLocaleLowerCase();
    if (typeof child === 'string' && lower === 'sourcehash' && child.length > 0) facts.hashes.push(child);
    if ((lower === 'sourcerevision' || lower === 'revision')
      && (typeof child === 'number' || typeof child === 'string')) facts.revisions.push(child);
    if (typeof child === 'string' && lower === 'sourceuri' && child.length > 0) facts.uris.push(child);
    collectNativeSourceFacts(child, facts, depth + 1);
  }
  return facts;
}

function compactNativeToolResult(value, depth = 0) {
  if (depth > 4) return '[depth-limited]';
  if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => compactNativeToolResult(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    // Complete Lua source and DarkScript are used for the in-process
    // assertion, but must not be copied into a rollout/report.
    if (key === 'sourceText' || key === 'darkScript' || key === 'argsBase64' || key === 'contentBase64') continue;
    output[key] = compactNativeToolResult(child, depth + 1);
  }
  return output;
}

async function runReadOnlyGoalTool(window, goal) {
  const result = await window.evaluate(
    async ({ tool, input }) => globalThis.soulforge.runAiTool(tool, input),
    { tool: goal.tool, input: goal.input }
  );
  return {
    tool: goal.tool,
    input: goal.input,
    result,
    compactResult: compactNativeToolResult(result)
  };
}

function evaluateParamGoal(goal, result) {
  const fields = result?.ok && Array.isArray(result?.data?.fields)
    ? result.data.fields
    : [];
  const field = fields.find((candidate) => (
    Number(candidate?.rowId) === goal.rowId
    && String(candidate?.fieldId ?? '').toLocaleLowerCase() === goal.fieldId.toLocaleLowerCase()
  ));
  const sourceHashPresent = typeof field?.sourceHash === 'string' && field.sourceHash.length > 0;
  return {
    ...goal,
    nativeReadOk: result?.ok === true,
    observedValue: field?.value ?? null,
    sourceHashPresent,
    sourceRevisionPresent: field?.sourceRevision !== undefined && field?.sourceRevision !== null,
    verified: Boolean(result?.ok === true && field && sourceHashPresent && sameValue(field.value, goal.expectedValue)),
    verificationEvidence: result?.ok === true && sourceHashPresent
      ? [{ tool: 'read_param_fields', sourceHashes: [field.sourceHash], sourceRevisions: field.sourceRevision === undefined ? [] : [field.sourceRevision], sourceUris: field.sourceUri ? [field.sourceUri] : [] }]
      : [],
    diagnostics: result?.ok === false ? result?.error ?? null : null,
    read: compactNativeToolResult(result ?? null)
  };
}

function goalChangedInOverlay(goal, treeEvidence) {
  if (!goal.changedPath || !treeEvidence?.before || !treeEvidence?.after) return true;
  const before = treeEvidence.before.entries.find((entry) => entry.path === goal.changedPath);
  const after = treeEvidence.after.entries.find((entry) => entry.path === goal.changedPath);
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

async function verifyGoalThroughNativeTool(window, goal, paramReads = new Map(), treeEvidence = undefined) {
  if (goal.kind === 'param-field') {
    const key = `${goal.table}\0${goal.rowId}`;
    let result = paramReads.get(key);
    if (!result) {
      result = await window.evaluate(
        async (input) => globalThis.soulforge.runAiTool('read_param_fields', input),
        { table: goal.table, rowIds: [goal.rowId], fieldIds: [goal.fieldId] }
      );
      paramReads.set(key, result);
    }
    const evaluation = evaluateParamGoal(goal, result);
    if (evaluation.verified && !goalChangedInOverlay(goal, treeEvidence)) {
      evaluation.verified = false;
      evaluation.diagnostics = [{ code: 'GOAL_RESOURCE_UNCHANGED', message: `目标 ${goal.goalId} 指定资源在 Agent 写回后没有变化。` }];
      evaluation.verificationEvidence = [];
    }
    return evaluation;
  }
  if (goal.kind === 'composite' || goal.kind === 'semantic') {
    const children = [];
    for (const child of goal.checks) {
      children.push(await verifyGoalThroughNativeTool(window, child, paramReads, treeEvidence));
    }
    const requiredChildren = children.filter((child) => child?.required !== false);
    const verified = requiredChildren.length > 0 && requiredChildren.every((child) => child.verified === true);
    const changed = goalChangedInOverlay(goal, treeEvidence);
    return {
      ...goal,
      verified: verified && changed,
      nativeReadOk: requiredChildren.every((child) => child.nativeReadOk === true),
      observedValue: verified,
      verificationEvidence: verified && changed ? children.flatMap((child) => child?.verificationEvidence ?? []) : [],
      checks: children,
      diagnostics: verified && changed
        ? []
        : [{ code: changed ? 'SEMANTIC_ASSERTION_FAILED' : 'GOAL_RESOURCE_UNCHANGED', message: changed ? `复合目标 ${goal.goalId} 的至少一个检查未通过。` : `目标 ${goal.goalId} 指定资源在 Agent 写回后没有变化。` }]
    };
  }
  const execution = await runReadOnlyGoalTool(window, goal);
  const result = execution.result;
  const facts = collectNativeSourceFacts(result);
  const nativeReadOk = result?.ok === true;
  const sourceHashPresent = facts.hashes.length > 0;
  const assertionOk = nativeReadOk && matchesAssertion(result, goal.assertion);
  const proofOk = !goal.requireSourceHash || sourceHashPresent;
  const observed = goal.assertion?.path === undefined
    ? null
    : readAssertionPath(result, goal.assertion.path).value ?? null;
  const changed = goalChangedInOverlay(goal, treeEvidence);
  const diagnostics = [];
  if (!nativeReadOk) diagnostics.push(result?.error ?? { code: 'NATIVE_READ_FAILED', message: `${goal.tool} 读取失败。` });
  if (nativeReadOk && !assertionOk) diagnostics.push({ code: 'SEMANTIC_ASSERTION_FAILED', message: `目标 ${goal.goalId} 的原生结果未满足断言。` });
  if (nativeReadOk && !proofOk) diagnostics.push({ code: 'NATIVE_SOURCE_HASH_MISSING', message: `目标 ${goal.goalId} 缺少 sourceHash，不能作为原生验证证据。` });
  if (nativeReadOk && !changed) diagnostics.push({ code: 'GOAL_RESOURCE_UNCHANGED', message: `目标 ${goal.goalId} 指定资源在 Agent 写回后没有变化。` });
  return {
    ...goal,
    nativeReadOk,
    observedValue: compactNativeToolResult(observed),
    sourceHashPresent,
    sourceRevisionPresent: facts.revisions.length > 0,
    verified: nativeReadOk && assertionOk && proofOk && changed,
    verificationEvidence: nativeReadOk && assertionOk && proofOk && changed
      ? [{ tool: goal.tool, sourceHashes: [...new Set(facts.hashes)].slice(0, 4), sourceRevisions: [...new Set(facts.revisions)].slice(0, 4), sourceUris: [...new Set(facts.uris)].slice(0, 4) }]
      : [],
    diagnostics,
    read: execution.compactResult
  };
}

async function verifyGoalsThroughNativeTool(window, goals, treeEvidence = undefined) {
  const grouped = new Map();
  for (const goal of goals) {
    if (goal.kind !== 'param-field') continue;
    const key = `${goal.table}\0${goal.rowId}`;
    const current = grouped.get(key) ?? { table: goal.table, rowId: goal.rowId, fieldIds: [] };
    if (!current.fieldIds.includes(goal.fieldId)) current.fieldIds.push(goal.fieldId);
    grouped.set(key, current);
  }
  const reads = [];
  for (const query of grouped.values()) {
    const result = await window.evaluate(
      async (input) => globalThis.soulforge.runAiTool('read_param_fields', input),
      { table: query.table, rowIds: [query.rowId], fieldIds: query.fieldIds }
    );
    reads.push({ query, result });
  }
  const paramReads = new Map(reads.map((entry) => [`${entry.query.table}\0${entry.query.rowId}`, entry.result]));
  const evaluations = goals.map((goal) => {
    const read = reads.find((item) => item.query.table === goal.table && item.query.rowId === goal.rowId);
    return evaluateParamGoal(goal, read?.result ?? null);
  });
  const semanticEvaluations = [];
  for (const goal of goals) {
    if (goal.kind === 'param-field') continue;
    semanticEvaluations.push(await verifyGoalThroughNativeTool(window, goal, paramReads, treeEvidence));
  }
  return { reads: reads.map((entry) => ({ ...entry, result: compactNativeToolResult(entry.result) })), evaluations: [...evaluations, ...semanticEvaluations] };
}

function parseDurableTerminal(raw) {
  const terminals = [];
  let parseErrors = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      const item = JSON.parse(line);
      if (item?.type === 'turn-complete') terminals.push(item);
    } catch {
      parseErrors += 1;
    }
  }
  return { terminal: terminals.at(-1) ?? null, terminalCount: terminals.length, parseErrors };
}

function classifyStopTelemetry({ diagnostics, stopFileRequested = false, errorCode = null }) {
  const events = Array.isArray(diagnostics?.events) ? diagnostics.events : [];
  const pageClose = events.find((event) => event.type === 'page-close') ?? null;
  const rendererCrash = events.find((event) => event.type === 'renderer-crash') ?? null;
  const processExit = events.find((event) => event.type === 'process-exit') ?? null;
  let classification = 'none';
  let reason = null;
  if (stopFileRequested) {
    classification = 'operator';
    reason = 'stop-file';
  } else if (rendererCrash) {
    classification = 'internal';
    reason = 'renderer-crash';
  } else if (pageClose) {
    // A page close alone does not identify an operator action.  Preserve the
    // observed window-close fact, but keep its cause unknown unless the
    // run-specific stop file was actually observed.
    classification = 'unknown';
    reason = 'window-close';
  } else if (processExit) {
    classification = 'internal';
    reason = 'process-exit';
  } else if (errorCode) {
    classification = 'internal';
    reason = 'harness-error';
  }
  return {
    classification,
    reason,
    stopFileConfigured: AGENT_STOP_FILE !== null,
    stopFileRequested: stopFileRequested === true,
    pageClose: pageClose ? { at: pageClose.at } : null,
    rendererCrash: rendererCrash ? { at: rendererCrash.at } : null,
    processExit: processExit
      ? { at: processExit.at, code: processExit.code, signal: processExit.signal }
      : null
  };
}

function normalizeProcessEntry(value) {
  const pid = Number(value?.ProcessId ?? value?.pid);
  const parentPid = Number(value?.ParentProcessId ?? value?.parentPid);
  const creationValue = value?.CreationDate ?? value?.creationTime ?? null;
  const creationDate = creationValue ? new Date(creationValue) : null;
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    parentPid: Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : null,
    name: String(value?.Name ?? value?.name ?? ''),
    creationTime: creationDate && !Number.isNaN(creationDate.getTime())
      ? creationDate.toISOString()
      : (creationValue ? String(creationValue) : null),
    executablePath: String(value?.ExecutablePath ?? value?.executablePath ?? ''),
    commandLine: String(value?.CommandLine ?? value?.commandLine ?? '')
  };
}

async function queryWindowsProcesses() {
  if (process.platform !== 'win32') {
    return { processes: [], error: { code: 'PROCESS_QUERY_UNSUPPORTED', message: '仅 Windows 支持进程树身份核验。' } };
  }
  const command = '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  try {
    const { stdout } = await EXEC_FILE(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: PROCESS_QUERY_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
    );
    const parsed = JSON.parse(String(stdout ?? '').trim() || '[]');
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return { processes: values.map(normalizeProcessEntry).filter((entry) => entry.pid !== null), error: null };
  } catch (error) {
    return {
      processes: [],
      error: {
        code: error?.code ?? 'PROCESS_QUERY_FAILED',
        message: error?.message ?? String(error)
      }
    };
  }
}

function collectProcessDescendants(processes, rootPid) {
  const byParent = new Map();
  for (const process of processes) {
    const children = byParent.get(process.parentPid) ?? [];
    children.push(process);
    byParent.set(process.parentPid, children);
  }
  const result = [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift();
    for (const process of byParent.get(parentPid) ?? []) {
      if (seen.has(process.pid)) continue;
      seen.add(process.pid);
      result.push(process);
      queue.push(process.pid);
    }
  }
  const root = processes.find((process) => process.pid === rootPid);
  if (root) result.unshift(root);
  return result;
}

function processCommandContains(process, value) {
  if (!value) return false;
  const raw = String(value);
  const portable = portablePath(raw);
  return process.commandLine.includes(raw) || process.commandLine.includes(portable);
}

function processIsWithinRun(process, startedAt) {
  if (!startedAt || !process.creationTime) return true;
  const startedMs = Date.parse(startedAt);
  const createdMs = Date.parse(process.creationTime);
  if (!Number.isFinite(startedMs) || !Number.isFinite(createdMs)) return true;
  return createdMs >= startedMs - 10_000 && createdMs <= Date.now() + 10_000;
}

async function captureOwnedElectronTree({ rootPid, scratchRoot, startedAt }) {
  const queried = await queryWindowsProcesses();
  if (queried.error) return { rootPid, capturedAt: new Date().toISOString(), processes: [], rootProcess: null, error: queried.error };
  const descendants = collectProcessDescendants(queried.processes, rootPid);
  // Some production Bridge children can be re-parented while Electron is
  // shutting down.  Keep them in the owned set when their command line still
  // carries this run's private user-data/scratch root; otherwise a root-only
  // capture would leave them behind after app.close().
  const commandLineCandidates = queried.processes.filter((process) => (
    processCommandContains(process, scratchRoot)
    && processIsWithinRun(process, startedAt)
    && /(?:electron|soulforge\.bridge)\.exe$/iu.test(process.executablePath || process.name)
  ));
  const byPid = new Map();
  for (const process of [...descendants, ...commandLineCandidates]) byPid.set(process.pid, process);
  const processes = [...byPid.values()].sort((left, right) => left.pid - right.pid);
  return {
    rootPid,
    capturedAt: new Date().toISOString(),
    processes,
    rootProcess: queried.processes.find((process) => process.pid === rootPid) ?? null,
    error: null
  };
}

function mergeOwnedElectronTrees(...trees) {
  const first = trees.find((tree) => tree) ?? null;
  const errors = trees.map((tree) => tree?.error).filter(Boolean);
  const byIdentity = new Map();
  for (const tree of trees) {
    for (const process of tree?.processes ?? []) {
      const key = `${process.pid}:${process.creationTime ?? ''}:${process.executablePath ?? ''}`;
      byIdentity.set(key, process);
    }
  }
  return {
    rootPid: first?.rootPid ?? null,
    capturedAt: new Date().toISOString(),
    processes: [...byIdentity.values()].sort((left, right) => left.pid - right.pid),
    rootProcess: trees.find((tree) => tree?.rootProcess)?.rootProcess ?? null,
    error: errors[0] ?? null
  };
}

function withRootIdentityCheck(initial, latest) {
  const expectedRoot = initial?.rootProcess
    ?? initial?.processes?.find((process) => process.pid === initial?.rootPid)
    ?? null;
  const currentRoot = latest?.rootProcess ?? null;
  if (expectedRoot && currentRoot && !sameOwnedProcess(currentRoot, expectedRoot)) {
    return {
      ...latest,
      error: {
        code: 'ROOT_PROCESS_IDENTITY_CHANGED',
        message: `Electron root PID ${expectedRoot.pid} 的创建时间或可执行路径已变化。`
      }
    };
  }
  return latest;
}

function sameOwnedProcess(current, expected) {
  if (!current || !expected || current.pid !== expected.pid) return false;
  if (!expected.creationTime || !current.creationTime || current.creationTime !== expected.creationTime) return false;
  if (!expected.executablePath || !current.executablePath) return false;
  return current.executablePath.toLocaleLowerCase() === expected.executablePath.toLocaleLowerCase();
}

async function terminateOwnedElectronTree(ownership) {
  if (!ownership || ownership.error) {
    return {
      status: 'failed',
      reason: ownership?.error?.code ?? 'PROCESS_TREE_IDENTITY_UNAVAILABLE',
      observed: ownership?.processes ?? [],
      remaining: []
    };
  }
  if (process.platform !== 'win32') {
    return { status: 'failed', reason: 'PROCESS_TREE_KILL_UNSUPPORTED', observed: ownership.processes, remaining: ownership.processes };
  }
  const attempts = [];
  for (let pass = 0; pass < 2; pass += 1) {
    const queried = await queryWindowsProcesses();
    if (queried.error) {
      return { status: 'failed', reason: queried.error.code, observed: ownership.processes, remaining: [], attempts };
    }
    const remaining = ownership.processes.filter((expected) => (
      queried.processes.some((current) => sameOwnedProcess(current, expected))
    ));
    if (remaining.length === 0) {
      return { status: 'succeeded', observed: ownership.processes, remaining: [], attempts };
    }
    const remainingPids = new Set(remaining.map((process) => process.pid));
    const roots = remaining.filter((process) => !remainingPids.has(process.parentPid));
    for (const expected of roots) {
      const current = queried.processes.find((process) => sameOwnedProcess(process, expected));
      if (!current) continue;
      try {
        const result = await EXEC_FILE(
          'taskkill',
          ['/PID', String(current.pid), '/T', '/F'],
          { windowsHide: true, timeout: PROCESS_TREE_KILL_GRACE_MS, maxBuffer: 1 * 1024 * 1024 }
        );
        attempts.push({ pid: current.pid, creationTime: current.creationTime, executablePath: current.executablePath, ok: true, stdout: redactString(result.stdout ?? '') });
      } catch (error) {
        attempts.push({ pid: current.pid, creationTime: current.creationTime, executablePath: current.executablePath, ok: false, code: error?.code ?? 'TASKKILL_FAILED', message: error?.message ?? String(error) });
      }
    }
    await sleep(PROCESS_TREE_KILL_GRACE_MS);
  }
  const finalQuery = await queryWindowsProcesses();
  const remaining = finalQuery.error
    ? ownership.processes
    : ownership.processes.filter((expected) => finalQuery.processes.some((current) => sameOwnedProcess(current, expected)));
  return {
    status: remaining.length === 0 && !finalQuery.error ? 'succeeded' : 'failed',
    reason: remaining.length === 0 ? null : (finalQuery.error?.code ?? 'OWNED_PROCESS_TREE_REMAINS'),
    observed: ownership.processes,
    remaining,
    attempts
  };
}

async function verifyOwnedElectronTreeExited(ownership) {
  if (!ownership || ownership.error) {
    return {
      status: 'failed',
      reason: ownership?.error?.code ?? 'PROCESS_TREE_IDENTITY_UNAVAILABLE',
      observed: ownership?.processes ?? [],
      remaining: ownership?.processes ?? []
    };
  }
  if (process.platform !== 'win32') {
    return {
      status: 'failed',
      reason: 'PROCESS_TREE_QUERY_UNSUPPORTED',
      observed: ownership.processes,
      remaining: ownership.processes
    };
  }
  const queried = await queryWindowsProcesses();
  if (queried.error) {
    return {
      status: 'failed',
      reason: queried.error.code,
      observed: ownership.processes,
      remaining: ownership.processes
    };
  }
  const remaining = ownership.processes.filter((expected) => (
    queried.processes.some((current) => sameOwnedProcess(current, expected))
  ));
  return {
    status: remaining.length === 0 ? 'succeeded' : 'skipped',
    reason: remaining.length === 0 ? null : 'OWNED_PROCESS_TREE_REMAINS',
    observed: ownership.processes,
    remaining
  };
}

async function removeScratchRoot(scratchRoot) {
  const tempBase = resolve(tmpdir());
  const target = resolve(scratchRoot);
  if (!target.startsWith(tempBase + sep) || !target.includes('soulforge-real-agent-')) {
    log(`拒绝清理未通过边界校验的临时目录：${target}`);
    return { status: 'failed', path: portablePath(target), reason: 'SCRATCH_PATH_REJECTED' };
  }
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
      return { status: 'succeeded', path: portablePath(target), attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) break;
      await sleep(250);
    }
  }
  log(`临时目录清理延迟：${target}（${lastError?.code ?? 'unknown'}）`);
  return {
    status: 'failed',
    path: portablePath(target),
    attempts: 20,
    reason: lastError?.code ?? 'SCRATCH_CLEANUP_FAILED',
    message: lastError?.message ?? null
  };
}

async function closeElectron(app, { scratchRoot, startedAt, ownership = null, allowOwnedTreeKill = false } = {}) {
  if (!app) return { status: 'not-started', ownedTree: null, childPid: null };
  let child;
  try {
    child = app.process();
  } catch {
    child = undefined;
  }
  const rootPid = child?.pid ?? ownership?.rootPid ?? 0;
  const initialTree = ownership ?? await captureOwnedElectronTree({ rootPid, scratchRoot, startedAt });
  // Refresh immediately before app.close(): analysis and Agent startup can
  // create Bridge descendants after the initial launch snapshot.  A changed
  // PID must never be silently re-bound to a new root process.
  const latestBeforeClose = await captureOwnedElectronTree({ rootPid, scratchRoot, startedAt });
  const checkedBeforeClose = withRootIdentityCheck(initialTree, latestBeforeClose);
  let tree = mergeOwnedElectronTrees(initialTree, checkedBeforeClose);
  let appCloseTimedOut = false;
  let appCloseError = null;
  const closePromise = Promise.resolve()
    .then(() => app.close())
    .catch((error) => {
      appCloseError = { code: error?.code ?? 'ELECTRON_CLOSE_FAILED', message: error?.message ?? String(error) };
      return undefined;
    });
  const closeResult = await Promise.race([
    closePromise.then(() => 'closed'),
    sleep(ELECTRON_CLOSE_TIMEOUT_MS).then(() => 'timeout')
  ]);
  appCloseTimedOut = closeResult === 'timeout';
  let childExitObserved = child ? child.exitCode !== null : true;
  if (child && child.exitCode === null && allowOwnedTreeKill && !tree.error) {
    try {
      child.kill();
    } catch {
      // 关闭与兜底 kill 可能竞争；进程已退出时无需再处理。
    }
    const deadline = Date.now() + 5_000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(100);
    childExitObserved = child.exitCode !== null;
  }
  // One bounded post-close query catches re-parented/late Bridge processes
  // carrying this run's scratch path.  A query failure or root identity change
  // keeps cleanup failed and preserves the scratch evidence.
  const latestAfterClose = await captureOwnedElectronTree({ rootPid, scratchRoot, startedAt });
  const checkedAfterClose = withRootIdentityCheck(initialTree, latestAfterClose);
  tree = mergeOwnedElectronTrees(tree, checkedAfterClose);
  const ownedTree = allowOwnedTreeKill
    ? await terminateOwnedElectronTree(tree)
    : await verifyOwnedElectronTreeExited(tree);
  return {
    status: ownedTree.status === 'succeeded' || (ownedTree.status === 'not-started' && childExitObserved)
      ? 'succeeded'
      : ownedTree.status,
    childPid: child?.pid ?? null,
    childExitObserved,
    appCloseTimedOut,
    appCloseError,
    ownership: tree,
    ownedTree
  };
}

async function run() {
  if (CLI_OPTIONS.help) {
    printHelp();
    return { ok: true, help: true };
  }
  if (CLI_OPTIONS.observationOnly === true && CLI_OPTIONS.write === true) {
    throw harnessError('REAL_AGENT_MODE_INVALID', '--observe 与 --write/--apply-overlay 不能同时使用。');
  }
  if (CLI_OPTIONS.testset && !SELECTED_TEST_TASK) {
    throw harnessError('REAL_AGENT_TESTSET_INVALID', `未知四题测试清单：${CLI_OPTIONS.testset}`);
  }
  if (AGENT_RUNTIME !== 'unpacked' && AGENT_RUNTIME !== 'installed') {
    throw harnessError('REAL_AGENT_RUNTIME_INVALID', '--runtime 只能是 unpacked 或 installed。');
  }
  if (AGENT_RUNTIME === 'installed') {
    const exeInfo = AGENT_EXE_PATH ? await stat(AGENT_EXE_PATH).catch(() => null) : null;
    if (!AGENT_EXE_PATH || !exeInfo?.isFile()) {
      const reportDir = resolve(REPO_ROOT, 'output/agent-real');
      const reportStem = `${REPORT_LABEL}-${SAFE_TIMESTAMP}`;
      const reportPath = join(reportDir, `${reportStem}.json`);
      await mkdir(reportDir, { recursive: true });
      const notAttempted = {
        ok: false,
        status: 'not-attempted',
        verificationMode: 'installed-exe',
        runtime: 'installed',
        task: TASK_QUERY,
        diagnostic: {
          code: 'REAL_AGENT_INSTALLED_RUNTIME_NOT_ATTEMPTED',
          message: '没有提供可执行的安装版 EXE；本次不把 unpacked 结果冒充 installed smoke。'
        },
        reportPath: `output/agent-real/${reportStem}.json`
      };
      await writeFile(reportPath, `${JSON.stringify(notAttempted, null, 2)}\n`, 'utf8');
      console.log(JSON.stringify(notAttempted, null, 2));
      process.exitCode = 1;
      return notAttempted;
    }
  }
  const goals = parseGoals(CLI_OPTIONS.goals);
  // A supplied immutable artifact is the complete production receipt for this
  // run.  Validate every snapshot byte, but do not compare it with the live
  // checkout: a later source/build update must not silently mix into a pinned
  // Electron/Bridge run.
  const configuredSnapshotRoot = CONFIGURED_SNAPSHOT_ROOT;
  const build = AGENT_RUNTIME === 'installed'
    ? null
    : configuredSnapshotRoot
      ? await assertAgentProductionArtifactSnapshotFresh(configuredSnapshotRoot)
      : await assertAgentProductionBuildFresh(REPO_ROOT);
  const productionMainSha256 = await sha256FileOrNull(AGENT_RUNTIME === 'installed' ? AGENT_EXE_PATH : PRODUCTION_MAIN);
  if (!productionMainSha256) {
    throw harnessError(
      AGENT_RUNTIME === 'installed' ? 'REAL_AGENT_INSTALLED_EXE_UNREADABLE' : 'PRODUCTION_MAIN_MISSING',
      AGENT_RUNTIME === 'installed' ? '安装版 EXE 不可读，未启动测试。' : `生产 main 入口不存在或不可读：${PRODUCTION_MAIN}`
    );
  }
  const productionMainManifestEntry = AGENT_RUNTIME !== 'installed' && configuredSnapshotRoot
    ? build.manifest.files?.entries?.find((entry) => entry.path === 'apps/desktop/e2e/playwright/production-main.mjs') ?? null
    : null;
  if (AGENT_RUNTIME !== 'installed' && configuredSnapshotRoot && (!productionMainManifestEntry
    || productionMainManifestEntry.sha256 !== productionMainSha256)) {
    throw harnessError(
      'PRODUCTION_MAIN_SNAPSHOT_MISMATCH',
      `生产 main 入口与 snapshot 清单不一致：${PRODUCTION_MAIN}`,
      {
        productionMain: portablePath(PRODUCTION_MAIN),
        actualSha256: productionMainSha256,
        manifestSha256: productionMainManifestEntry?.sha256 ?? null,
        artifactId: build.manifest.artifactId ?? null
      }
    );
  }
  const buildSummary = AGENT_RUNTIME === 'installed'
    ? {
        manifestPath: null,
        sourceHash: null,
        outputHash: productionMainSha256,
        sourceFiles: null,
        outputFiles: null,
        runtime: 'installed-exe',
        productionMain: {
          path: portablePath(AGENT_EXE_PATH),
          sha256: productionMainSha256,
          manifestSha256: null
        }
      }
    : configuredSnapshotRoot
      ? {
          manifestPath: relative(REPO_ROOT, build.manifestPath),
          sourceHash: build.manifest.liveBuild.sourceSha256,
          outputHash: build.manifest.liveBuild.outputSha256,
          sourceFiles: null,
          outputFiles: build.manifest.files.fileCount,
          artifactId: build.manifest.artifactId,
          productionMain: {
            path: portablePath(PRODUCTION_MAIN),
            sha256: productionMainSha256,
            manifestSha256: productionMainManifestEntry?.sha256 ?? null
          }
        }
      : {
          manifestPath: relative(REPO_ROOT, build.manifestPath),
          sourceHash: build.manifest.source.sha256,
          outputHash: build.manifest.output.sha256,
          sourceFiles: build.manifest.source.fileCount,
          outputFiles: build.manifest.output.fileCount,
          productionMain: {
            path: portablePath(PRODUCTION_MAIN),
            sha256: productionMainSha256,
            manifestSha256: null
          }
        };
  const productionReceipt = {
    mode: AGENT_RUNTIME === 'installed' ? 'installed-exe' : configuredSnapshotRoot ? 'immutable-snapshot' : 'live-build',
    snapshotRoot: AGENT_RUNTIME !== 'installed' && configuredSnapshotRoot ? portablePath(build.snapshotRoot) : null,
    manifestPath: AGENT_RUNTIME === 'installed' ? null : portablePath(build.manifestPath),
    artifactId: build?.manifest.artifactId ?? null,
    sourceHash: AGENT_RUNTIME === 'installed'
      ? null
      : configuredSnapshotRoot
        ? build.manifest.liveBuild.sourceSha256
        : build.manifest.source.sha256,
    outputHash: AGENT_RUNTIME === 'installed'
      ? productionMainSha256
      : configuredSnapshotRoot
        ? build.manifest.liveBuild.outputSha256
        : build.manifest.output.sha256,
    productionMain: {
      path: portablePath(AGENT_RUNTIME === 'installed' ? AGENT_EXE_PATH : PRODUCTION_MAIN),
      sha256: productionMainSha256,
      manifestSha256: productionMainManifestEntry?.sha256 ?? null
    }
  };
  const scratchRoot = await mkdtemp(join(tmpdir(), `soulforge-real-agent-${SAFE_TIMESTAMP}-`));
  const overlayRoot = join(scratchRoot, 'overlay');
  const userDataDir = join(scratchRoot, 'user-data');
  const taskRecordDir = join(scratchRoot, 'task-records');
  const reportDir = resolve(REPO_ROOT, 'output/agent-real');
  const reportStem = `${REPORT_LABEL}-${SAFE_TIMESTAMP}`;
  const reportPath = join(reportDir, `${reportStem}.json`);
  const rolloutCopyPath = join(reportDir, `${reportStem}.rollout.jsonl`);
  const taskRecordCopyPath = join(reportDir, `${reportStem}.evidence.md`);
  let app;
  let window;
  let sessionId = null;
  let report = null;
  let completionSummary = null;
  let terminalEvidence = null;
  let interruptedDurableRollout = null;
  let interruptedEvidenceHasEntries = false;
  let taskRecordStatus = 'not-emitted';
  let corpusManifest = null;
  let semanticPreflight = null;
  let phase = 'prepare';
  let electronOwnership = null;
  let cleanupResult = { status: 'pending', reason: 'cleanup-not-started' };
  let rollbackResult = { status: 'unverified', attempted: false, reason: 'run-did-not-reach-rollback' };
  let operationsBefore = null;
  let operationsAfterRun = null;
  let operationsAfterRollback = null;
  let newCommittedOperations = [];
  let rollbackResults = [];
  let providerEvidence = null;
  let treeBefore = null;
  let treeAfterRun = null;
  let treeAfterRollback = null;
  const pageErrors = [];
  const consoleErrors = [];
  const electronDiagnostics = {
    pid: null,
    exitCode: null,
    signal: null,
    stdoutTail: '',
    stderrTail: '',
    events: [],
    ownedProcessTree: null,
    productionMain: {
      path: portablePath(AGENT_RUNTIME === 'installed' ? AGENT_EXE_PATH : PRODUCTION_MAIN),
      sha256: productionMainSha256,
      snapshotRoot: AGENT_RUNTIME !== 'installed' && configuredSnapshotRoot ? portablePath(configuredSnapshotRoot) : null,
      artifactId: build?.manifest.artifactId ?? null
    }
  };
  const startedAt = new Date().toISOString();

  await mkdir(reportDir, { recursive: true });
  try {
    corpusManifest = await copySemanticWorkspace(overlayRoot);
    treeBefore = await snapshotTree(overlayRoot);
    await mkdir(userDataDir, { recursive: true });
    await mkdir(taskRecordDir, { recursive: true });

    phase = 'launch-electron';
    app = await electron.launch({
      ...(AGENT_RUNTIME === 'installed'
        ? { executablePath: AGENT_EXE_PATH }
        : { cwd: configuredSnapshotRoot ? resolve(configuredSnapshotRoot) : REPO_ROOT }),
      args: [
        ...(AGENT_RUNTIME === 'unpacked' ? [PRODUCTION_MAIN] : []),
        `--user-data-dir=${userDataDir}`
      ],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SF_E2E_OVERLAY_ROOT: overlayRoot,
        SF_E2E_BASE_ROOT: GAME_ROOT,
        // Keep the Agent's durable workspace/knowledge/operation databases
        // outside the overlay.  The overlay must contain only user Mod
        // resources so the final rollback comparison cannot be confused by
        // SoulForge's own SQLite sidecars (and an installed run cannot lock a
        // real workspace database).
        SF_E2E_WORKSPACE_STORAGE_ROOT: join(scratchRoot, 'workspace-storage'),
        SOULFORGE_AGENT_TASK_RECORD_DIR: taskRecordDir,
        ...(AGENT_RUNTIME === 'installed' ? { SF_E2E_INSTALLED_HARNESS: '1' } : {})
      }
    });
    const child = app.process();
    electronDiagnostics.pid = child.pid;
    child.stdout?.on('data', (chunk) => {
      electronDiagnostics.stdoutTail = (electronDiagnostics.stdoutTail + redactString(String(chunk))).slice(-32_768);
    });
    child.stderr?.on('data', (chunk) => {
      electronDiagnostics.stderrTail = (electronDiagnostics.stderrTail + redactString(String(chunk))).slice(-32_768);
    });
    child.on('exit', (code, signal) => {
      electronDiagnostics.exitCode = code;
      electronDiagnostics.signal = signal;
      electronDiagnostics.events.push({ type: 'process-exit', at: new Date().toISOString(), code, signal });
    });
    window = await app.firstWindow();
    window.on('crash', () => electronDiagnostics.events.push({ type: 'renderer-crash', at: new Date().toISOString() }));
    window.on('close', () => electronDiagnostics.events.push({ type: 'page-close', at: new Date().toISOString() }));
    window.on('pageerror', (error) => pageErrors.push(String(error)));
    window.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => 'soulforge' in globalThis, undefined, { timeout: 30_000 });
    electronOwnership = await captureOwnedElectronTree({
      rootPid: child.pid,
      scratchRoot,
      startedAt
    });
    electronDiagnostics.ownedProcessTree = electronOwnership;

    phase = 'open-workspace';
    const workspace = await withTimeout(window.evaluate(async () => {
      const api = globalThis.soulforge;
      const overlay = await api.openWorkspaceDialog();
      const base = await api.openBaseDialog();
      if (!overlay || !base) throw new Error('生产目录选择器没有返回 overlay/base 凭据。');
      const scan = await api.scanWorkspace({
        overlaySelectionId: overlay.selectionId,
        baseSelectionId: base.selectionId,
        game: 'sekiro'
      });
      const analysisStartedAt = new Date().toISOString();
      globalThis.__sfAgentHarnessAnalysis = { status: 'running', startedAt: analysisStartedAt };
      void api.analyzeWorkspace().then(
        (analysis) => {
          globalThis.__sfAgentHarnessAnalysis = {
            status: 'completed',
            startedAt: analysisStartedAt,
            finishedAt: new Date().toISOString(),
            analysis
          };
        },
        (error) => {
          globalThis.__sfAgentHarnessAnalysis = {
            status: 'failed',
            startedAt: analysisStartedAt,
            finishedAt: new Date().toISOString(),
            error: {
              code: error?.code ?? 'WORKSPACE_ANALYSIS_FAILED',
              message: error instanceof Error ? error.message : String(error)
            }
          };
        }
      );
      return {
        overlayLabel: overlay.label,
        baseLabel: base.label,
        scan: {
          workspaceSessionId: scan.workspaceSessionId,
          workspaceLabel: scan.workspaceLabel,
          fileCount: Array.isArray(scan.files) ? scan.files.length : 0,
          countsByKind: scan.countsByKind,
          diagnostics: scan.diagnostics,
          indexingStatus: scan.indexingStatus
        },
        analysis: { status: 'started', startedAt: analysisStartedAt }
      };
    }), WORKSPACE_PREP_TIMEOUT_MS, 'WORKSPACE_PREP_TIMEOUT', '生产工作区打开或轻量扫描超时。');
    log(`生产工作区已打开并启动后台分析：files=${workspace.scan.fileCount}。`);

    phase = 'semantic-preflight';
    const requiredFamilies = [
      ...(workspace.scan.countsByKind?.param > 0 ? ['param_row'] : []),
      ...(workspace.scan.countsByKind?.msg > 0 ? ['text_entry'] : [])
    ];
    let lastPreflightLogAt = 0;
    semanticPreflight = await waitForSemanticReadiness({
      readSnapshot: () => window.evaluate(async () => ({
        stats: await globalThis.soulforge.runAiTool('workspace_stats', {}),
        analysis: globalThis.__sfAgentHarnessAnalysis ?? null
      })),
      requiredFamilies,
      timeoutMs: SEMANTIC_PREFLIGHT_TIMEOUT_MS,
      onProgress: (state) => {
        if (state.attempts === 1 || state.elapsedMs - lastPreflightLogAt >= 10_000) {
          log(`首批语义预热：${state.status}，PARAM=${state.counts.param_row}，MSG=${state.counts.text_entry}。`);
          lastPreflightLogAt = state.elapsedMs;
        }
      }
    });
    log(`首批语义预检结束：${semanticPreflight.status}（${semanticPreflight.elapsedMs}ms）。`);
    for (const diagnostic of semanticPreflight.diagnostics) log(`${diagnostic.code}: ${diagnostic.message}`);

    phase = 'provider';
    if (AGENT_PROVIDER !== 'test' && AGENT_PROVIDER !== 'vault') {
      throw harnessError('REAL_AGENT_PROVIDER_REQUIRED', '模拟 Agent 必须显式指定 --provider test 或 --provider vault；未发起模型请求。');
    }
    let providerId = AGENT_CONFIG_ID;
    if (AGENT_PROVIDER === 'test') {
      const loaded = loadTestAgentProvider({ repoRoot: REPO_ROOT, explicitPath: AGENT_TEST_CONFIG_PATH });
      if (!loaded) {
        throw harnessError('REAL_AGENT_TEST_CONFIG_MISSING', '未找到有效的加密 test provider 配置；未发起模型请求。');
      }
      const saved = await window.evaluate(async (config) => {
        return globalThis.soulforge.upsertModelService(config);
      }, {
        id: 'test-service',
        displayName: 'test',
        protocol: loaded.config.protocol,
        baseUrl: loaded.config.baseUrl,
        model: loaded.config.model,
        apiKey: loaded.config.apiKey
      });
      if (!saved?.hasCredential) {
        throw harnessError('REAL_AGENT_TEST_CONFIG_REJECTED', 'test provider 未能写入隔离模型 vault；未发起模型请求。');
      }
      providerId = 'test-service';
      providerEvidence = { mode: 'test', id: providerId, source: 'simulation-test-config' };
    } else {
      if (!providerId || providerId === 'test-service') {
        throw harnessError('REAL_AGENT_PROVIDER_CONFIG_REQUIRED', 'vault provider 必须指定非 test-service 的 --config-id；未发起模型请求。');
      }
      const providers = await window.evaluate(() => globalThis.soulforge.listModelServices());
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (!provider || provider.hasCredential !== true) {
        throw harnessError('REAL_AGENT_PROVIDER_CONFIG_REQUIRED', `隔离 vault 中没有带凭据的 provider：${providerId}；未发起模型请求。`);
      }
      providerEvidence = { mode: 'vault', id: providerId, source: 'isolated-user-data' };
    }

    phase = 'baseline-operations';
    operationsBefore = await window.evaluate(() => globalThis.soulforge.listOperations());
    await window.evaluate(() => {
      globalThis.__sfAgentHarnessEvents = [];
      globalThis.__sfAgentHarnessUnsubscribe?.();
      globalThis.__sfAgentHarnessUnsubscribe = globalThis.soulforge.onAiAgentEvent((envelope) => {
        globalThis.__sfAgentHarnessEvents.push(envelope);
        if (envelope?.event?.type === 'approval-requested') {
          const allowed = new Set(['stage', 'commit', 'rollback', 'write']);
          const decision = allowed.has(envelope.event.permissionLevel) ? 'once' : 'reject';
          void globalThis.soulforge.respondAiAgentApproval({
            sessionId: envelope.sessionId,
            callId: envelope.event.callId,
            decision
          });
        }
      });
    });

    phase = 'run-agent';
    const requestedAgentMode = CLI_OPTIONS.observationOnly === true ? 'plan' : 'normal';
    const permission = await window.evaluate(
      (mode) => globalThis.soulforge.requestAiAgentPermission(mode),
      requestedAgentMode
    );
    if (!permission?.ok || typeof permission.grantId !== 'string') {
      throw harnessError(permission?.error?.code ?? 'AGENT_PERMISSION_REQUIRED', permission?.error?.message ?? '模拟 Agent 未获得正常审批权限。');
    }
    const accepted = await window.evaluate(
      async (request) => globalThis.soulforge.runAiAgent(request),
      {
        configId: providerId,
        prompt: TASK_QUERY,
        mode: requestedAgentMode,
        permissionGrantId: permission.grantId,
        streaming: true,
        maxSteps: MAX_STEPS,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxTotalOutputTokens: MAX_OUTPUT_TOKENS,
        autoCompactTokenLimit: 400_000,
        retryMaxAttempts: 2,
        useContextBroker: true,
        contextMaxBytes: 16_000,
        useRagSearch: true,
        ragSearchMaxHits: 8
      }
    );
    if (!accepted?.ok || typeof accepted.sessionId !== 'string') {
      throw harnessError(accepted?.error?.code ?? 'AGENT_SESSION_REJECTED', accepted?.error?.message ?? '生产主进程拒绝 Agent 会话。');
    }
    sessionId = accepted.sessionId;
    log(`生产 Agent 会话已受理：${sessionId}。`);
    const waited = await waitForAgentTerminal(window, sessionId);
    const events = waited.events;
    const terminal = waited.terminal.event;
    const eventsReport = eventSummary(events);
    terminalEvidence = sanitizeForReport({
      terminal,
      cancelledForTimeout: waited.cancelledForTimeout,
      cancelledForStop: waited.cancelledForStop,
      stopFileRequested: waited.stopFileRequested,
      ...(AGENT_STOP_FILE ? { stopFile: portablePath(AGENT_STOP_FILE) } : {}),
      events: eventsReport
    });
    if (terminal.type !== 'session-done') {
      phase = 'agent-terminal';
      throw harnessError(
        terminal.code ?? (waited.cancelledForTimeout ? 'AGENT_SESSION_TIMEOUT' : 'AGENT_SESSION_FAILED'),
        terminal.message ?? (waited.cancelledForTimeout ? '生产 Agent 会话超时后已取消。' : '生产 Agent 会话失败。'),
        terminalEvidence
      );
    }

    phase = 'verify-native-goals';
    operationsAfterRun = await window.evaluate(() => globalThis.soulforge.listOperations());
    const priorOperationIds = new Set(operationsBefore.map((operation) => operation.opId));
    newCommittedOperations = operationsAfterRun.filter((operation) => (
      operation.status === 'committed' && !priorOperationIds.has(operation.opId)
    ));
    treeAfterRun = await snapshotTree(overlayRoot);
    const nativeGoals = await verifyGoalsThroughNativeTool(window, goals, {
      before: treeBefore,
      after: treeAfterRun
    });

    phase = 'copy-durable-evidence';
    const rolloutSource = resolveWithin(join(userDataDir, 'agent'), terminal.rolloutFileName, 'ROLLOUT_PATH_FORBIDDEN');
    const taskRecordSource = resolve(taskRecordDir, `${sessionId}.md`);
    if (!isWithin(taskRecordDir, taskRecordSource)) throw harnessError('TASK_RECORD_PATH_FORBIDDEN', 'Evidence 路径越过隔离目录。');
    await sleep(100);
    await copyFile(rolloutSource, rolloutCopyPath);
    let taskRecordRaw = '';
    const taskRecordSnapshot = await readFile(taskRecordSource, 'utf8').catch(() => null);
    if (taskRecordSnapshot !== null) {
      await writeFile(taskRecordCopyPath, taskRecordSnapshot, 'utf8');
      taskRecordRaw = taskRecordSnapshot;
      taskRecordStatus = 'present';
    }
    // The production Agent now uses automatic read proofs and the durable
    // rollout as its authoritative evidence.  The old markdown task ledger is
    // optional historical evidence; its absence must be reported, not turn a
    // completed observation into an ENOENT harness failure.
    const rolloutRaw = await readFile(rolloutCopyPath, 'utf8');
    const durableRollout = parseDurableTerminal(rolloutRaw);
    const evidenceHasEntries = /^##\s+\S+/mu.test(taskRecordRaw);

    phase = 'rollback';
    const attemptedOperationIds = [];
    rollbackResult = {
      status: 'unverified',
      attempted: false,
      committedOperationCount: newCommittedOperations.length,
      reason: newCommittedOperations.length > 0 ? 'rollback-in-progress' : 'no-committed-operations-awaiting-verification',
      evidence: {
        committedOperationIds: newCommittedOperations.map((operation) => operation.opId),
        attemptedOperationIds,
        treeBeforeSha256: treeBefore.sha256,
        treeAfterRunSha256: treeAfterRun.sha256,
        rollbackResults: []
      }
    };
    rollbackResults = await rollbackCommittedOperations(
      newCommittedOperations,
      (opId) => {
        attemptedOperationIds.push(opId);
        rollbackResult = {
          ...rollbackResult,
          attempted: true,
          evidence: {
            ...rollbackResult.evidence,
            attemptedOperationIds: [...attemptedOperationIds]
          }
        };
        return window.evaluate((operationId) => globalThis.soulforge.rollbackOperation(operationId), opId);
      }
    );
    const rollbackThrown = rollbackResults.some((entry) => entry.error);
    const failedRollback = rollbackResults.find((entry) => entry.error) ?? null;
    rollbackResult = {
      ...rollbackResult,
      reason: rollbackThrown
        ? 'rollback-operation-threw'
        : newCommittedOperations.length > 0
          ? 'rollback-results-collected-awaiting-verification'
          : rollbackResult.reason,
      ...(failedRollback ? {
        failedOperationId: failedRollback.opId,
        rollbackError: failedRollback.error
      } : {}),
      evidence: {
        ...rollbackResult.evidence,
        rollbackResults
      }
    };
    let rollbackStatuses = new Map();
    let workspaceAnalysis = null;
    // A thrown inverse is indeterminate. Do not enqueue more database work
    // that can mask the failed operation; the catch report already contains
    // the committed IDs, attempted IDs and completed/failed results.
    if (!rollbackThrown) {
      // Observation-only runs cannot have committed operations. Re-querying
      // operation.list here only competes with the still-running background
      // semantic/RAG persistence queue and can turn an otherwise complete
      // observation into a history timeout. A write run still performs the
      // authoritative post-rollback reread below.
      operationsAfterRollback = newCommittedOperations.length === 0
        ? operationsAfterRun
        : await window.evaluate(() => globalThis.soulforge.listOperations());
      treeAfterRollback = await snapshotTree(overlayRoot);
      rollbackStatuses = new Map(operationsAfterRollback.map((operation) => [operation.opId, operation.status]));
      workspaceAnalysis = await window.evaluate(() => globalThis.__sfAgentHarnessAnalysis ?? null);
    }

    const treeRestoredExactly = Boolean(treeAfterRollback && treeAfterRollback.sha256 === treeBefore.sha256);
    const rollbackVerification = evaluateRollbackVerification({
      operations: newCommittedOperations,
      results: rollbackResults,
      statuses: rollbackStatuses,
      treeRestoredExactly
    });
    const lifecycleOk = terminal.type === 'session-done'
      && terminal.finishReason === 'stop'
      && durableRollout.terminal?.finishReason === 'stop'
      && eventsReport.lifecycle.some((entry) => entry.event.type === 'turn-complete' && entry.event.finishReason === 'stop');
    const goalCoverage = evaluateGoalCoverage(nativeGoals.evaluations, CLI_OPTIONS.observationOnly === true);
    const goalsOk = goalCoverage.goalsOk;
    const committedOperationOk = newCommittedOperations.length > 0;
    const writeObserved = treeAfterRun.sha256 !== treeBefore.sha256;
    const treeUnchangedBeforeRollback = treeAfterRun.sha256 === treeBefore.sha256;
    const rollbackOperationsOk = !rollbackThrown && rollbackVerification.verified;
    const rollbackOk = rollbackOperationsOk;
    const rollbackNoMutationEvidence = {
      committedOperationCount: newCommittedOperations.length,
      operationDeltaObserved: operationsAfterRun.some((operation) => (
        !operationsBefore.some((before) => before.opId === operation.opId)
      )),
      treeBeforeSha256: treeBefore.sha256,
      treeAfterRunSha256: treeAfterRun.sha256,
      treeAfterRollbackSha256: treeAfterRollback?.sha256 ?? null,
      treeUnchanged: treeUnchangedBeforeRollback,
      treeRestoredExactly
    };
    if (!rollbackThrown) {
      const noMutationVerified = newCommittedOperations.length === 0
        && treeUnchangedBeforeRollback
        && treeRestoredExactly;
      rollbackResult = newCommittedOperations.length === 0
        ? {
            status: noMutationVerified ? 'not_applicable' : 'unverified',
            attempted: false,
            committedOperationCount: 0,
            reason: noMutationVerified
              ? 'no-committed-operations-and-overlay-unchanged'
              : treeUnchangedBeforeRollback
                ? 'no-committed-operations-but-tree-not-restored'
                : 'no-committed-operations-but-overlay-changed',
            evidence: rollbackNoMutationEvidence
          }
        : {
            status: rollbackOk ? 'verified' : 'unverified',
            attempted: rollbackResults.some((entry) => entry.attempted === true),
            committedOperationCount: newCommittedOperations.length,
            reason: rollbackOk ? 'all-committed-operations-rolled-back' : 'rollback-check-failed',
            evidence: {
              committedOperationIds: newCommittedOperations.map((operation) => operation.opId),
              attemptedOperationIds: rollbackResults
                .filter((entry) => entry.attempted === true)
                .map((entry) => entry.opId),
              rollbackStatuses: Object.fromEntries(newCommittedOperations.map((operation) => [
                operation.opId,
                rollbackStatuses.get(operation.opId) ?? null
              ])),
              treeBeforeSha256: treeBefore.sha256,
              treeAfterRunSha256: treeAfterRun.sha256,
              treeAfterRollbackSha256: treeAfterRollback?.sha256 ?? null,
              treeRestoredExactly,
              rollbackResults
            }
          };
    }
    const durableEvidenceOk = durableRollout.parseErrors === 0
      && durableRollout.terminal !== null;
    const runtimeOk = eventsReport.seqGaps.length === 0
      && pageErrors.length === 0
      && waited.cancelledForTimeout === false;
    const taskSucceeded = lifecycleOk
      && WRITE_MODE
      && goalsOk
      && goalCoverage.taskCoverageOk
      && committedOperationOk
      && writeObserved
      && (rollbackOk || rollbackResult.status === 'not_applicable')
      && treeRestoredExactly
      && durableEvidenceOk
      && runtimeOk;

    report = sanitizeForReport({
      ok: taskSucceeded,
      startedAt,
      finishedAt: new Date().toISOString(),
      task: TASK_QUERY,
      policy: livePolicyIdentity(),
      goals: nativeGoals.evaluations,
      goalCoverage,
      rollback: rollbackResult,
      cleanup: cleanupResult,
      stop: classifyStopTelemetry({
        diagnostics: electronDiagnostics,
        stopFileRequested: waited.stopFileRequested
      }),
      verdict: {
        writeMode: WRITE_MODE,
        lifecycleOk,
        goalsOk,
        taskCoverageOk: goalCoverage.taskCoverageOk,
        taskCompletionVerified: goalCoverage.taskCompletionVerified,
        committedOperationOk,
        writeObserved,
        rollbackOk,
        treeRestoredExactly,
        durableEvidenceOk,
        runtimeOk,
        cleanupOk: null
      },
      build: buildSummary,
      productionReceipt,
      provider: providerEvidence,
      workspace: { ...workspace, semanticPreflight, analysis: workspaceAnalysis ?? workspace.analysis },
      isolatedWorkspace: {
        sourceModRoot: portablePath(relative(REPO_ROOT, MOD_ROOT)),
        semanticKinds: corpusManifest.copiedKinds,
        corpusManifest,
        before: summarizeTree(treeBefore),
        afterRun: summarizeTree(treeAfterRun),
        afterRollback: summarizeTree(treeAfterRollback),
        changedAfterRun: diffTrees(treeBefore, treeAfterRun),
        residualAfterRollback: treeAfterRollback ? diffTrees(treeBefore, treeAfterRollback) : null
      },
      session: {
        sessionId,
        terminal,
        cancelledForTimeout: waited.cancelledForTimeout,
        cancelledForStop: waited.cancelledForStop,
        stopFileRequested: waited.stopFileRequested,
        ...(AGENT_STOP_FILE ? { stopFile: portablePath(AGENT_STOP_FILE) } : {}),
        events: eventsReport,
        rolloutPath: rolloutCopyPath,
        taskRecordPath: taskRecordStatus === 'present' ? taskRecordCopyPath : null,
        taskRecordStatus,
        taskRecordDiagnostic: taskRecordStatus === 'present'
          ? null
          : { code: 'TASK_RECORD_NOT_EMITTED', message: '生产链使用自动读取证明；旧 markdown task ledger 未生成。' },
        durableRollout,
        evidenceHasEntries
      },
      nativeReads: nativeGoals.reads,
      operations: {
        before: operationsBefore,
        afterRun: operationsAfterRun,
        newCommitted: newCommittedOperations,
        rollbackResults,
        afterRollback: operationsAfterRollback
      },
      electronDiagnostics,
      rendererDiagnostics: { pageErrors, consoleErrors }
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    completionSummary = {
      ok: report.ok,
      verificationMode: goalCoverage.mode,
      fieldChecksOk: goalCoverage.fieldChecksOk,
      taskCompletionVerified: goalCoverage.taskCompletionVerified,
      finishReason: terminal.finishReason,
      steps: terminal.steps,
      goals: report.goals.map((goal) => ({ goalId: goal.goalId, verified: goal.verified, observedValue: goal.observedValue })),
      newCommittedOperations: newCommittedOperations.length,
      rollbackRestoredExactly: treeRestoredExactly,
      seqGaps: eventsReport.seqGaps,
      reportPath,
      evidencePath: taskRecordStatus === 'present' ? taskRecordCopyPath : null,
      rolloutPath: rolloutCopyPath
    };
    process.exitCode = report.ok ? 0 : 1;
    return report;
  } catch (error) {
    // Preserve an interrupted run before scratch cleanup; a missing terminal
    // event must not erase the tool calls that explain a renderer/main crash.
    const interruptedEvidence = [];
    if (sessionId) {
      const visit = async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const absolute = join(directory, entry.name);
          if (entry.isDirectory()) await visit(absolute);
          else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) {
            await copyFile(absolute, rolloutCopyPath);
            interruptedEvidence.push({ kind: 'rollout', path: rolloutCopyPath, incomplete: true });
          }
        }
      };
      await visit(join(userDataDir, 'agent')).catch(() => undefined);
      await copyFile(join(taskRecordDir, `${sessionId}.md`), taskRecordCopyPath)
        .then(() => interruptedEvidence.push({ kind: 'task-record', path: taskRecordCopyPath, incomplete: true }))
        .catch(() => undefined);
      if (interruptedEvidence.some((entry) => entry.kind === 'rollout')) {
        interruptedDurableRollout = await readFile(rolloutCopyPath, 'utf8')
          .then((raw) => parseDurableTerminal(raw))
          .catch(() => null);
      }
      interruptedEvidenceHasEntries = await readFile(taskRecordCopyPath, 'utf8')
        .then((raw) => /^##\s+\S+/mu.test(raw))
        .catch(() => false);
    }
    const stopFileRequested = Boolean(
      AGENT_STOP_FILE && await fileExists(AGENT_STOP_FILE)
    );
    const failure = sanitizeForReport({
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      phase,
      task: TASK_QUERY,
      policy: livePolicyIdentity(),
      goals,
      verificationMode: CLI_OPTIONS.observationOnly ? 'observation-only' : 'param-fields-only',
      writeMode: WRITE_MODE,
      taskCompletionVerified: false,
      rollback: rollbackResult,
      cleanup: cleanupResult,
      corpusManifest,
      semanticPreflight,
      build: buildSummary,
      productionReceipt,
      provider: providerEvidence,
      sessionId,
      session: terminalEvidence
        ? {
            ...terminalEvidence,
            durableRollout: interruptedDurableRollout,
            evidenceHasEntries: interruptedEvidenceHasEntries
          }
        : null,
      stop: classifyStopTelemetry({
        diagnostics: electronDiagnostics,
        stopFileRequested,
        errorCode: error?.code ?? 'REAL_AGENT_HARNESS_FAILED'
      }),
      interruptedEvidence,
      electronDiagnostics,
      isolatedWorkspace: {
        sourceModRoot: portablePath(relative(REPO_ROOT, MOD_ROOT)),
        scratchRoot: portablePath(scratchRoot),
        overlayRoot: portablePath(overlayRoot),
        userDataDir: portablePath(userDataDir),
        taskRecordDir: portablePath(taskRecordDir),
        semanticKinds: corpusManifest?.copiedKinds ?? [],
        corpusManifest,
        before: summarizeTree(treeBefore),
        afterRun: summarizeTree(treeAfterRun),
        afterRollback: summarizeTree(treeAfterRollback),
        changedAfterRun: treeBefore && treeAfterRun ? diffTrees(treeBefore, treeAfterRun) : null,
        residualAfterRollback: treeBefore && treeAfterRollback ? diffTrees(treeBefore, treeAfterRollback) : null
      },
      operations: {
        before: operationsBefore,
        afterRun: operationsAfterRun,
        newCommitted: newCommittedOperations,
        rollbackResults,
        afterRollback: operationsAfterRollback
      },
      error: {
        code: error?.code ?? 'REAL_AGENT_HARNESS_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: error?.details
      },
      verdict: {
        rollbackStatus: rollbackResult.status,
        cleanupOk: null
      },
      rendererDiagnostics: { pageErrors, consoleErrors }
    });
    report = failure;
    await writeFile(reportPath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8').catch(() => undefined);
    process.exitCode = 1;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { reportPath });
  } finally {
    if (window) {
      await Promise.race([
        window.evaluate(() => globalThis.__sfAgentHarnessUnsubscribe?.()).catch(() => undefined),
        sleep(CLEANUP_EVALUATE_TIMEOUT_MS)
      ]).catch(() => undefined);
    }
    const rollbackStatus = report?.rollback?.status ?? rollbackResult.status;
    const allowOwnedTreeKill = ['verified', 'not_applicable'].includes(rollbackStatus);
    let electronCleanup;
    let scratchCleanup;
    try {
      electronCleanup = await closeElectron(app, {
        scratchRoot,
        startedAt,
        ownership: electronOwnership,
        allowOwnedTreeKill
      });
      const scratchDecision = decideScratchCleanup({
        electronStatus: electronCleanup.status,
        rollbackStatus
      });
      scratchCleanup = scratchDecision.remove
        ? await removeScratchRoot(scratchRoot)
        : {
            status: 'preserved',
            path: portablePath(scratchRoot),
            reason: scratchDecision.reason,
            rollbackStatus,
            electronStatus: electronCleanup.status
          };
      const cleanupStatus = electronCleanup.status === 'succeeded' && scratchCleanup.status === 'succeeded'
        ? 'succeeded'
        : scratchCleanup.status === 'preserved'
          && (electronCleanup.status === 'succeeded' || electronCleanup.status === 'not-started')
          ? 'preserved'
          : 'failed';
      cleanupResult = {
        status: cleanupStatus,
        allowOwnedTreeKill,
        electron: electronCleanup,
        scratch: scratchCleanup
      };
    } catch (error) {
      cleanupResult = {
        status: 'failed',
        allowOwnedTreeKill,
        error: {
          code: error?.code ?? 'CLEANUP_FAILED',
          message: error?.message ?? String(error)
        },
        electron: electronCleanup ?? null,
        scratch: scratchCleanup ?? null
      };
    }
    if (report) {
      report.finishedAt = new Date().toISOString();
      report.policy = livePolicyIdentity();
      report.rollback = rollbackResult;
      report.cleanup = cleanupResult;
      report.verdict ??= {};
      report.verdict.cleanupOk = cleanupResult.status === 'succeeded';
      if (cleanupResult.status !== 'succeeded') report.ok = false;
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
    }
    if (completionSummary) {
      console.log(JSON.stringify({
        ...completionSummary,
        ok: report?.ok === true,
        cleanup: cleanupResult.status
      }, null, 2));
    }
    if (cleanupResult.status !== 'succeeded') process.exitCode = 1;
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(redactString(message));
  if (error?.reportPath) console.error(`失败报告：${error.reportPath}`);
  process.exitCode = 1;
});
