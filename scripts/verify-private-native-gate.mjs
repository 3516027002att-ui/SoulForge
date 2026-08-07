/**
 * P7 private native gate — runs real native checks when env roots exist,
 * otherwise records an honest skip without claiming V0.5 complete.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProcessCancellation,
  processSucceeded,
  readTimeoutMs,
  runProcess
} from './subprocess-control.mjs';
import {
  resolveSafeScratchRoot,
  scratchBoundaryFailure
} from './scratch-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredScratch =
  process.env.SOULFORGE_SCRATCH
  ?? resolve(process.env.TEMP ?? '/tmp', 'soulforge-private-native-gate');

const sekiro = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
const nativeFixture = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() || '';
const npmCli = process.env.npm_execpath?.trim()
  || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
let stepTimeoutMs;
try {
  stepTimeoutMs = readTimeoutMs('SOULFORGE_PRIVATE_NATIVE_STEP_TIMEOUT_MS', 15 * 60 * 1000);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    gate: 'private-native',
    code: 'PRIVATE_NATIVE_TIMEOUT_INVALID',
    message: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
}

let assessmentFixtureCases;
try {
  assessmentFixtureCases = verifyAssessmentClassifier();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    gate: 'private-native',
    code: 'PRIVATE_NATIVE_ASSESSMENT_FIXTURE_FAILED',
    message: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
}

let scratch;
try {
  scratch = await resolveSafeScratchRoot({
    scratch: configuredScratch,
    repositoryRoot: root,
    protectedRoots: [
      { label: 'sekiro-game-root', path: sekiro },
      { label: 'native-fixture-root', path: nativeFixture },
      { label: 'mod-workspace-root', path: resolve(root, 'mods') }
    ]
  });
  await mkdir(scratch, { recursive: true });
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    gate: 'private-native',
    ...scratchBoundaryFailure(error)
  }, null, 2));
  process.exit(1);
}

const report = {
  ok: true,
  gate: 'private-native',
  timestamp: new Date().toISOString(),
  sekiroRootPresent: Boolean(sekiro),
  nativeFixturePresent: Boolean(nativeFixture),
  assessmentFixtureCases,
  steps: /** @type {Array<Record<string, unknown>>} */ ([]),
  status: 'unknown',
  message: ''
};

async function runNpm(args, env, signal) {
  const result = await runProcess({
    command: process.execPath,
    args: [npmCli, ...args],
    cwd: root,
    env: { ...process.env, ...env },
    timeoutMs: stepTimeoutMs,
    signal
  });
  return { ...result, result: extractLastJsonObject(result.stdout) };
}

if (!sekiro && !nativeFixture) {
  report.status = 'skipped';
  report.message =
    'unverified-no-local-sekiro-runtime: 未设置 SOULFORGE_SEKIRO_GAME_ROOT / SOULFORGE_NATIVE_FIXTURE_ROOT；私有 native 门禁未执行。';
  report.steps.push({
    name: 'environment',
    ok: true,
    skipped: true,
    reason: report.message
  });
  const outPath = resolve(scratch, 'private-native-gate.json');
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
  process.exitCode = 0;
  process.exit();
}

// When env present: run oodle probe + native preview sample (mods path optional)
const steps = [
  { name: 'bridge:verify:oodle', args: ['run', 'bridge:verify:oodle'] },
  { name: 'test:native-writer-failure-matrix', args: ['run', 'test:native-writer-failure-matrix'] },
  { name: 'bridge:verify:emevd', args: ['run', 'bridge:verify:emevd'] },
  { name: 'bridge:verify:fmg', args: ['run', 'bridge:verify:fmg'] },
  { name: 'bridge:verify:param', args: ['run', 'bridge:verify:param'] },
  { name: 'bridge:verify:msb', args: ['run', 'bridge:verify:msb'] },
  { name: 'bridge:verify:tae', args: ['run', 'bridge:verify:tae'] },
  { name: 'bridge:verify:tpf', args: ['run', 'bridge:verify:tpf'] },
  { name: 'bridge:verify:flver', args: ['run', 'bridge:verify:flver'] },
  { name: 'bridge:verify:esd', args: ['run', 'bridge:verify:esd'] }
];

let failed = false;
let partial = false;
const cancellation = createProcessCancellation();
try {
  for (const step of steps) {
    const result = await runNpm(step.args, {
      SOULFORGE_SEKIRO_GAME_ROOT: sekiro,
      SOULFORGE_NATIVE_FIXTURE_ROOT: nativeFixture
    }, cancellation.signal);
    const assessed = assessStep(step.name, result);
    if (!assessed.ok) failed = true;
    if (assessed.partial) partial = true;
    report.steps.push({
      name: step.name,
      ok: assessed.ok,
      partial: assessed.partial,
      code: result.code,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      timeoutMs: result.timeoutMs,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      semanticStatus: assessed.status,
      reason: assessed.reason,
      stdoutTail: result.stdout.slice(-1500),
      stderrTail: result.stderr.slice(-800)
    });
    if (result.cancelled) break;
  }
} finally {
  cancellation.dispose();
}

report.status = failed ? 'failed' : partial ? 'partial' : 'passed';
report.ok = !failed;
report.message = failed
  ? '私有 native 门禁有失败步骤；不得声明 V0.5 全绿。'
  : partial
    ? '私有 native 门禁可执行步骤完成，但仍含 partial/candidate 覆盖；不得声明 V0.5 全绿。'
    : '私有 native 门禁步骤通过（仍不等于 section-28 真游戏启动）。';

const outPath = resolve(scratch, 'private-native-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = failed ? 1 : 0;

function assessStep(name, result) {
  if (!processSucceeded(result) || !result.result || result.result.ok !== true) {
    const reason = result.timedOut
      ? '命令超时并已终止子进程树。'
      : result.cancelled
        ? '命令已取消并终止子进程树。'
        : '命令失败或未返回 ok=true 的结构化结果。';
    return { ok: false, partial: false, status: 'failed', reason };
  }
  const semanticStatus = typeof result.result.status === 'string' ? result.result.status : '';
  if (semanticStatus === 'failed') {
    return { ok: false, partial: false, status: 'failed', reason: '子步骤返回 status=failed。' };
  }
  if (['skipped', 'unverified', 'unsupported', 'candidate', 'fixture-confirmed', 'partial', 'blocked'].includes(semanticStatus)) {
    return {
      ok: true,
      partial: true,
      status: semanticStatus,
      reason: `子步骤返回 status=${semanticStatus}，不能算完整 native pass。`
    };
  }
  if (name === 'bridge:verify:oodle') {
    const success = result.result.realRuntimeSuccessPath === 'krak-decompress-preview-verified';
    return success
      ? { ok: true, partial: false, status: 'passed', reason: '合法 runtime 与注册 KRAK fixture 成功解压。' }
      : { ok: true, partial: true, status: 'partial', reason: '仅验证失败关闭或 runtime 导出，未验证注册 KRAK 成功解压。' };
  }
  if (name === 'bridge:verify:param' && Number(result.result.corpusFailed ?? 0) > 0) {
    return { ok: true, partial: true, status: 'partial', reason: `PARAM corpus 仍有 ${result.result.corpusFailed} 个 unsupported/failed 样本。` };
  }
  const authority = typeof result.result.authority === 'string' ? result.result.authority : '';
  if (authority === 'candidate' || authority === 'fixture-confirmed' || authority === 'partial') {
    return { ok: true, partial: true, status: authority, reason: `返回 authority=${authority}，不能算完整 native pass。` };
  }
  return { ok: true, partial: false, status: 'passed', reason: '结构化断言通过。' };
}

function verifyAssessmentClassifier() {
  const success = (result) => ({
    code: 0,
    timedOut: false,
    cancelled: false,
    result: { ok: true, ...result }
  });
  const cases = [
    ['skipped', 'bridge:verify:esd', success({ status: 'skipped' }), { ok: true, partial: true, status: 'skipped' }],
    ['unverified', 'bridge:verify:esd', success({ status: 'unverified' }), { ok: true, partial: true, status: 'unverified' }],
    ['unsupported', 'bridge:verify:esd', success({ status: 'unsupported' }), { ok: true, partial: true, status: 'unsupported' }],
    ['candidate-status', 'bridge:verify:tae', success({ status: 'candidate' }), { ok: true, partial: true, status: 'candidate' }],
    ['fixture-authority', 'bridge:verify:tae', success({ authority: 'fixture-confirmed' }), { ok: true, partial: true, status: 'fixture-confirmed' }],
    ['native-verified', 'bridge:verify:emevd', success({ status: 'native-verified' }), { ok: true, partial: false, status: 'passed' }],
    ['oodle-success', 'bridge:verify:oodle', success({ realRuntimeSuccessPath: 'krak-decompress-preview-verified' }), { ok: true, partial: false, status: 'passed' }],
    ['param-partial', 'bridge:verify:param', success({ corpusFailed: 2 }), { ok: true, partial: true, status: 'partial' }],
    ['semantic-failed', 'bridge:verify:esd', success({ status: 'failed' }), { ok: false, partial: false, status: 'failed' }],
    ['process-failed', 'bridge:verify:esd', { code: 1, timedOut: false, cancelled: false, result: null }, { ok: false, partial: false, status: 'failed' }]
  ];
  for (const [label, name, result, expected] of cases) {
    const actual = assessStep(name, result);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(actual[key], value, `${label}: ${key}`);
    }
  }
  return cases.length;
}

function extractLastJsonObject(stdout) {
  // start > 0 而不是 start >= 0：`'{bad'.lastIndexOf('{', -1)` 返回 **0**，不是 -1，
  // 所以原先的 `start >= 0` 在「输出首字符是 { 且整段不可解析」时永真——死循环。
  // 实测：该输入下循环不终止；表现为门禁超时，而超时会被误读成环境问题
  // （缺语料/机器慢），真正原因是解析逻辑本身。
  //
  // 0 位单独在循环外处理，保证首字符是 { 的合法 JSON 仍能被解析到。
  for (let start = stdout.lastIndexOf('{'); start > 0; start = stdout.lastIndexOf('{', start - 1)) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {
      // npm may print non-JSON prefixes; keep searching earlier object starts.
    }
  }
  if (stdout.startsWith('{')) {
    try {
      return JSON.parse(stdout);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
