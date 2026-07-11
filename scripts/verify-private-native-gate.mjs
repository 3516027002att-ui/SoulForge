/**
 * P7 private native gate — runs real native checks when env roots exist,
 * otherwise records an honest skip without claiming V0.5 complete.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch =
  process.env.SOULFORGE_SCRATCH
  ?? resolve(process.env.TEMP ?? '/tmp', 'soulforge-private-native-gate');

const sekiro = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
const nativeFixture = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() || '';

await mkdir(scratch, { recursive: true });

const report = {
  ok: true,
  gate: 'private-native',
  timestamp: new Date().toISOString(),
  sekiroRootPresent: Boolean(sekiro),
  nativeFixturePresent: Boolean(nativeFixture),
  steps: /** @type {Array<Record<string, unknown>>} */ ([]),
  status: 'unknown',
  message: ''
};

function run(command, args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
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
  { name: 'bridge:verify:oodle', cmd: 'npm', args: ['run', 'bridge:verify:oodle'] },
  { name: 'bridge:verify:emevd', cmd: 'npm', args: ['run', 'bridge:verify:emevd'] },
  { name: 'bridge:verify:fmg', cmd: 'npm', args: ['run', 'bridge:verify:fmg'] },
  { name: 'bridge:verify:param', cmd: 'npm', args: ['run', 'bridge:verify:param'] },
  { name: 'bridge:verify:msb', cmd: 'npm', args: ['run', 'bridge:verify:msb'] }
];

let failed = false;
for (const step of steps) {
  const result = await run(step.cmd, step.args, {
    SOULFORGE_SEKIRO_GAME_ROOT: sekiro,
    SOULFORGE_NATIVE_FIXTURE_ROOT: nativeFixture
  });
  const ok = result.code === 0;
  if (!ok) failed = true;
  report.steps.push({
    name: step.name,
    ok,
    code: result.code,
    stdoutTail: result.stdout.slice(-1500),
    stderrTail: result.stderr.slice(-800)
  });
}

report.status = failed ? 'failed' : 'passed';
report.ok = !failed;
report.message = failed
  ? '私有 native 门禁有失败步骤；不得声明 V0.5 全绿。'
  : '私有 native 门禁步骤通过（仍不等于 section-28 真游戏启动）。';

const outPath = resolve(scratch, 'private-native-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = failed ? 1 : 0;
