/** Run the four local test-set tasks as four independent overlay sessions. */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FOUR_TASKS } from './testing/real-agent-four-task-manifest.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(repoRoot, 'output', 'agent-real');

function parseArgs(args) {
  const passthrough = [];
  let only = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--only') {
      only = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--write' || arg === '--apply-overlay') {
      // The batch runner owns this safety switch and always adds --write.
      continue;
    }
    passthrough.push(arg);
    if (['--provider', '--config-id', '--test-config', '--runtime', '--exe', '--max-steps', '--timeout-ms', '--session-timeout-ms', '--workspace-timeout-ms', '--semantic-timeout-ms', '--max-output-tokens'].includes(arg)) {
      if (args[index + 1] !== undefined) passthrough.push(args[++index]);
    }
  }
  const tasks = only
    ? FOUR_TASKS.filter((task) => task.id === only || task.id.startsWith(`${only}-`))
    : FOUR_TASKS;
  if (tasks.length === 0) throw new Error(`未知四题测试项：${only}`);
  return { tasks, passthrough };
}

function scrub(value) {
  return String(value ?? '')
    .replace(/file:\/\/(?:[A-Za-z]:[\\/]|\/)[^"'{}\r\n]+/gu, 'file://[LOCAL_PATH]')
    .replace(/\b[A-Za-z]:[\\/][^"'{}\r\n]+/gu, '[LOCAL_PATH]')
    .replace(/\\\\[^"'{}\r\n]+/gu, '[LOCAL_PATH]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]');
}

function reportRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const absolute = resolve(value);
  return relative(repoRoot, absolute).replaceAll('\\', '/');
}

async function findChildReport(label) {
  const names = (await readdir(outputRoot).catch(() => []))
    .filter((name) => name.startsWith(`${label}-`) && name.endsWith('.json'))
    .sort();
  const name = names.at(-1);
  if (!name) return { path: null, report: null };
  const path = join(outputRoot, name);
  try { return { path, report: JSON.parse(await readFile(path, 'utf8')) }; }
  catch { return { path, report: null }; }
}

const { tasks, passthrough } = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const batchToken = startedAt.replace(/[^0-9TZ-]/gu, '');
const runtimeArgIndex = passthrough.findIndex((arg) => arg === '--runtime');
const aggregateRuntime = runtimeArgIndex >= 0 && typeof passthrough[runtimeArgIndex + 1] === 'string'
  ? passthrough[runtimeArgIndex + 1]
  : process.env.SOULFORGE_AGENT_RUNTIME?.trim() || 'unpacked';
const results = [];

await mkdir(outputRoot, { recursive: true });
for (const task of tasks) {
  // A unique batch label prevents a child crash before report creation from
  // accidentally picking a stale report left by an earlier run.
  const label = `four-${task.id}-${batchToken}`;
  const args = [
    join(repoRoot, 'scripts', 'run-real-agent-gyoubu.mjs'),
    '--testset', task.id,
    '--write',
    '--label', label,
    ...passthrough
  ];
  try {
    const child = await execFile(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env },
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    void child.stdout;
    const childResult = await findChildReport(label);
    const report = childResult.report;
    results.push({
      id: task.id,
      label: task.label,
      ok: report?.ok === true,
      reportPath: reportRelativePath(childResult.path),
      verificationMode: report?.goalCoverage?.mode ?? null,
      taskCompletionVerified: report?.goalCoverage?.taskCompletionVerified === true,
      error: null
    });
  } catch (error) {
    const childResult = await findChildReport(label);
    const report = childResult.report;
    results.push({
      id: task.id,
      label: task.label,
      ok: false,
      reportPath: reportRelativePath(childResult.path),
      verificationMode: report?.goalCoverage?.mode ?? null,
      taskCompletionVerified: false,
      error: { code: error?.code ?? 'FOUR_TASK_CHILD_FAILED', message: scrub(error?.message ?? '子任务失败。') }
    });
  }
}

const stem = `four-tasks-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
const aggregatePath = join(outputRoot, `${stem}.json`);
const aggregate = {
  ok: results.every((result) => result.ok === true),
  status: results.every((result) => result.ok === true) ? 'verified' : 'partial',
  startedAt,
  finishedAt: new Date().toISOString(),
  runtime: aggregateRuntime,
  tasks: results
};
await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: aggregate.ok,
  status: aggregate.status,
  tasks: results.map(({ id, ok, reportPath, error }) => ({ id, ok, reportPath, error })),
  reportPath: relative(repoRoot, aggregatePath).replaceAll('\\', '/')
}, null, 2));
process.exitCode = aggregate.ok ? 0 : 1;
