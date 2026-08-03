/**
 * Section-28 real Sekiro launch/rollback gate.
 * Without SOULFORGE_SEKIRO_GAME_ROOT: honest skip (never fake pass).
 * With env: records presence and runs available native smokes only —
 * does not claim full launch unless an explicit launcher hook exists.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  ?? resolve(process.env.TEMP ?? '/tmp', 'soulforge-section28-gate');
const sekiro = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
const npmCli = process.env.npm_execpath?.trim()
  || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
let stepTimeoutMs;
try {
  stepTimeoutMs = readTimeoutMs('SOULFORGE_SECTION28_STEP_TIMEOUT_MS', 15 * 60 * 1000);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    gate: 'section-28-sekiro-launch-rollback',
    code: 'SECTION28_TIMEOUT_INVALID',
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
      { label: 'native-fixture-root', path: process.env.SOULFORGE_NATIVE_FIXTURE_ROOT ?? '' },
      { label: 'mod-workspace-root', path: resolve(root, 'mods') }
    ]
  });
  await mkdir(scratch, { recursive: true });
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    gate: 'section-28-sekiro-launch-rollback',
    ...scratchBoundaryFailure(error)
  }, null, 2));
  process.exit(1);
}

const report = {
  ok: true,
  gate: 'section-28-sekiro-launch-rollback',
  timestamp: new Date().toISOString(),
  sekiroRootPresent: Boolean(sekiro),
  sekiroExePresent: false,
  status: 'unknown',
  message: '',
  steps: /** @type {Array<Record<string, unknown>>} */ ([])
};

function runNpm(args, signal, extraEnv = {}) {
  return runProcess({
    command: process.execPath,
    args: [npmCli, ...args],
    cwd: root,
    timeoutMs: stepTimeoutMs,
    signal,
    env: { ...process.env, ...extraEnv }
  });
}

if (!sekiro) {
  report.status = 'skipped';
  report.message =
    'unverified-no-local-sekiro-runtime: 未设置 SOULFORGE_SEKIRO_GAME_ROOT；section-28 真游戏启动/回滚门禁未执行。';
  report.steps.push({ name: 'environment', ok: true, skipped: true, reason: report.message });
  const outPath = join(scratch, 'section28-sekiro-gate.json');
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  // Plan-named skip log — tolerate concurrent readers (EBUSY on Windows Tee).
  try {
    await writeFile(join(scratch, 'sekiro-smoke-skipped.log'), `${report.message}\n`, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code !== 'EBUSY' && code !== 'EPERM') throw error;
    await writeFile(join(scratch, 'sekiro-smoke-skipped.alt.log'), `${report.message}\n`, 'utf8');
  }
  console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
  process.exitCode = 0;
  process.exit();
}

// Env present: verify sekiro.exe existence, then run format smokes (not full game launch).
const exeCandidates = ['sekiro.exe', 'Sekiro.exe'];
for (const name of exeCandidates) {
  try {
    await access(join(sekiro, name), constants.F_OK);
    report.sekiroExePresent = true;
    report.steps.push({ name: 'sekiro-exe', ok: true, pathHint: name });
    break;
  } catch {
    // try next
  }
}
if (!report.sekiroExePresent) {
  report.status = 'failed';
  report.ok = false;
  report.message = 'SOULFORGE_SEKIRO_GAME_ROOT 已设置但未找到 sekiro.exe。';
  report.steps.push({ name: 'sekiro-exe', ok: false });
  const outPath = join(scratch, 'section28-sekiro-gate.json');
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
  process.exitCode = 1;
  process.exit();
}

// Real game launch through the pinned me3 gateway is now part of this gate.
// The me3-sekiro-session step runs a bounded launch/terminate/restart session
// in suspend mode (game process present, renderer not running) and records an
// honest native-verified observation. Status remains capped at partial: this
// machine is not a substitute for packaged-game acceptance.
const smokes = [
  { name: 'bridge:verify:oodle', args: ['run', 'bridge:verify:oodle'] },
  { name: 'bridge:verify:emevd', args: ['run', 'bridge:verify:emevd'] },
  { name: 'bridge:verify:msb', args: ['run', 'bridge:verify:msb'] },
  {
    name: 'me3-sekiro-session',
    args: ['run', 'test:me3-sekiro-session'],
    env: { SOULFORGE_ME3_SEKIRO_SESSION_RUN: '1', SOULFORGE_ME3_SEKIRO_SUSPEND: '1' }
  }
];
let failed = false;
const cancellation = createProcessCancellation();
try {
  for (const entry of smokes) {
    const result = await runNpm(entry.args, cancellation.signal, entry.env ?? {});
    const ok = processSucceeded(result);
    if (!ok) failed = true;
    report.steps.push({
      name: entry.name,
      ok,
      code: result.code,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      timeoutMs: result.timeoutMs,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutTail: result.stdout.slice(-800),
      stderrTail: result.stderr.slice(-800)
    });
    if (result.cancelled) break;
  }
} finally {
  cancellation.dispose();
}

report.status = failed ? 'failed' : 'partial';
report.ok = !failed;
report.message = failed
  ? 'section-28 前置 native smoke 或真实 me3 启动会话失败。'
  : 'section-28 前置 native smoke 与真实 me3 启动会话（suspend）通过；本机真实验证不替代打包游戏验收，不得声明 section-28 全绿。';

const outPath = join(scratch, 'section28-sekiro-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = failed ? 1 : 0;
