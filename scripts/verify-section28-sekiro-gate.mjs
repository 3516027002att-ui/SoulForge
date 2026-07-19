/**
 * Section-28 real Sekiro launch/rollback gate.
 * Without SOULFORGE_SEKIRO_GAME_ROOT: honest skip (never fake pass).
 * With env: records presence and runs available native smokes only —
 * does not claim full launch unless an explicit launcher hook exists.
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeGateCommand } from './native-gate-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch =
  process.env.SOULFORGE_SCRATCH
  ?? resolve(process.env.TEMP ?? '/tmp', 'soulforge-section28-gate');
const sekiro = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
const allowSkip = process.argv.includes('--allow-skip');

await mkdir(scratch, { recursive: true });

const report = {
  ok: true,
  gate: 'section-28-sekiro-launch-rollback',
  timestamp: new Date().toISOString(),
  sekiroRootPresent: Boolean(sekiro),
  sekiroExePresent: false,
  modEnginePresent: false,
  oodlePresent: false,
  modEngineIniPresent: false,
  modsDirPresent: false,
  modsDcxCount: 0,
  sandboxRollbackDryRunOk: false,
  interactiveLaunchAttempted: false,
  interactiveLaunchBlocked: true,
  interactiveLaunchProbeOk: false,
  interactiveLaunchExitCode: null,
  interactiveLaunchTimedOut: false,
  gameRootWriteClaimed: false,
  status: 'unknown',
  message: '',
  steps: /** @type {Array<Record<string, unknown>>} */ ([])
};

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args) {
  const result = await runNativeGateCommand(command, args, {
    cwd: root,
    env: process.env
  });
  return {
    code: result.exitCode ?? result.code ?? 1,
    exitCode: result.exitCode ?? result.code ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnErrorCode: result.spawnErrorCode ?? null
  };
}

if (!sekiro) {
  report.ok = allowSkip;
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
  process.exitCode = allowSkip ? 0 : 2;
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

let failed = false;

// Extra read-only preflight under game root.
const extraChecks = [
  ['dinput8.dll', 'mod-engine-dll'],
  ['oo2core_6_win64.dll', 'oodle-runtime'],
  ['modengine.ini', 'mod-engine-ini']
];
for (const [name, stepName] of extraChecks) {
  const ok = await exists(join(sekiro, name));
  if (name === 'dinput8.dll') report.modEnginePresent = ok;
  if (name === 'oo2core_6_win64.dll') report.oodlePresent = ok;
  if (name === 'modengine.ini') report.modEngineIniPresent = ok;
  report.steps.push({ name: stepName, ok, pathHint: name });
  if (!ok) failed = true;
}
try {
  const modsRoot = join(sekiro, 'mods');
  report.modsDirPresent = await exists(modsRoot);
  if (report.modsDirPresent) {
    // shallow+deep count without writing
    async function countDcx(dir) {
      let n = 0;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) n += await countDcx(full);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dcx')) n += 1;
      }
      return n;
    }
    report.modsDcxCount = await countDcx(modsRoot);
  }
  report.steps.push({ name: 'mods-inventory', ok: report.modsDirPresent && report.modsDcxCount > 0, modsDcxCount: report.modsDcxCount });
  if (!(report.modsDirPresent && report.modsDcxCount > 0)) failed = true;
} catch (error) {
  report.steps.push({ name: 'mods-inventory', ok: false, error: error instanceof Error ? error.message : String(error) });
  failed = true;
}

// Sandbox Patch Engine rollback dry-run (never writes game root).
{
  const dry = await run(process.execPath, [resolve(root, 'scripts/section28-sandbox-rollback-dryrun.mjs')]);
  let structured = null;
  try {
    const text = String(dry.stdout || '');
    const start = text.lastIndexOf('{');
    structured = start >= 0 ? JSON.parse(text.slice(start)) : null;
  } catch {
    structured = null;
  }
  const ok = (dry.exitCode ?? dry.code) === 0 && structured?.ok === true && structured?.gameRootUntouched === true;
  report.sandboxRollbackDryRun = ok;
  report.sandboxRollbackDryRunOk = ok;
  if (!ok) failed = true;
  report.steps.push({
    name: 'sandbox-rollback-dry-run',
    ok,
    code: dry.exitCode ?? dry.code,
    structured,
    stdoutTail: String(dry.stdout || '').slice(-500),
    stderrTail: String(dry.stderr || '').slice(-500)
  });
}

// Real interactive in-game launch automation remains blocked by default.
const smokes = [
  { name: 'bridge:verify:oodle:real', args: ['run', 'bridge:verify:oodle:real'] },
  { name: 'bridge:verify:emevd', args: ['run', 'bridge:verify:emevd'] },
  { name: 'bridge:verify:msb', args: ['run', 'bridge:verify:msb'] }
];
for (const step of smokes) {
  const result = await run('npm', step.args);
  const ok = (result.exitCode ?? result.code) === 0;
  if (!ok) failed = true;
  report.steps.push({
    name: step.name,
    ok,
    code: result.exitCode ?? result.code,
    stdoutTail: result.stdout.slice(-800)
  });
}

// Optional short-lived launch probe. Default blocked.
// Requires SOULFORGE_SECTION28_ALLOW_LAUNCH=1. Never writes game root/mods.
const allowLaunch = process.env.SOULFORGE_SECTION28_ALLOW_LAUNCH === '1';
if (!failed && allowLaunch && report.sekiroExePresent) {
  report.interactiveLaunchBlocked = false;
  report.interactiveLaunchAttempted = true;
  const timeoutMs = Math.max(1000, Number(process.env.SOULFORGE_SECTION28_LAUNCH_TIMEOUT_MS || 5000));
  const exePath = join(sekiro, 'sekiro.exe');
  const probe = await new Promise((resolvePromise) => {
    let settled = false;
    const child = spawn(exePath, [], {
      cwd: sekiro,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolvePromise({ timedOut: true, code: null, error: null });
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ timedOut: false, code: null, error: error instanceof Error ? error.message : String(error) });
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ timedOut: false, code: code ?? 0, error: null });
    });
  });
  report.interactiveLaunchTimedOut = probe.timedOut === true;
  report.interactiveLaunchExitCode = probe.code;
  // Success criteria for probe: process started (timeout kill or clean exit), no spawn error.
  const ok = !probe.error;
  report.interactiveLaunchProbeOk = ok;
  if (!ok) failed = true;
  report.steps.push({
    name: 'interactive-launch-probe',
    ok,
    timedOut: probe.timedOut === true,
    code: probe.code,
    timeoutMs,
    error: probe.error,
    note: 'short-lived process probe only; not full Mod-load gameplay verification'
  });
} else if (!failed) {
  report.steps.push({
    name: 'interactive-launch-probe',
    ok: true,
    skipped: true,
    blocked: true,
    reason: 'set SOULFORGE_SECTION28_ALLOW_LAUNCH=1 to enable short-lived process probe'
  });
}

report.status = failed ? 'failed' : 'partial';
report.ok = false;
report.message = failed
  ? (allowLaunch ? 'section-28 启动探测或前置 smoke 失败。' : 'section-28 前置 native smoke 失败。')
  : (allowLaunch && report.interactiveLaunchProbeOk
    ? 'section-28 前置 smoke + 短超时启动探测通过；完整 Mod 加载/游戏内验证仍未实现，不得声明 section-28 全绿。'
    : 'section-28 前置 native smoke 通过；完整游戏启动/Mod 加载自动化未实现，不得声明 section-28 全绿。');

const outPath = join(scratch, 'section28-sekiro-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = failed ? 1 : 2;
