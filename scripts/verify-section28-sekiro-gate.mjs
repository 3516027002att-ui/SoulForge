/**
 * Section-28 real Sekiro launch/rollback gate.
 * Without SOULFORGE_SEKIRO_GAME_ROOT: honest skip (never fake pass).
 * With env: records presence and runs available native smokes only —
 * does not claim full launch unless an explicit launcher hook exists.
 */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch =
  process.env.SOULFORGE_SCRATCH
  ?? resolve(process.env.TEMP ?? '/tmp', 'soulforge-section28-gate');
const sekiro = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';

await mkdir(scratch, { recursive: true });

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

function run(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
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

// Real in-game launch automation is not shipped; record partial gate honestly.
const smokes = [
  { name: 'bridge:verify:oodle', args: ['run', 'bridge:verify:oodle'] },
  { name: 'bridge:verify:emevd', args: ['run', 'bridge:verify:emevd'] },
  { name: 'bridge:verify:msb', args: ['run', 'bridge:verify:msb'] }
];
let failed = false;
for (const step of smokes) {
  const result = await run('npm', step.args);
  const ok = result.code === 0;
  if (!ok) failed = true;
  report.steps.push({
    name: step.name,
    ok,
    code: result.code,
    stdoutTail: result.stdout.slice(-800)
  });
}

report.status = failed ? 'failed' : 'partial';
report.ok = !failed;
report.message = failed
  ? 'section-28 前置 native smoke 失败。'
  : 'section-28 前置 native smoke 通过；完整游戏启动/Mod 加载自动化未实现，不得声明 section-28 全绿。';

const outPath = join(scratch, 'section28-sekiro-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = failed ? 1 : 0;
