import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { processSucceeded, runProcess } from './subprocess-control.mjs';

const root = process.cwd();
const grandchildProgram = `
  const { writeFileSync } = require('node:fs');
  const sentinelPath = process.argv[1];
  let tick = 0;
  const writeSentinel = () => writeFileSync(sentinelPath, String(++tick), 'utf8');
  writeSentinel();
  process.stdout.write('ready\\n');
  setInterval(writeSentinel, 25);
`;
const treeProgram = `
  const { spawn } = require('node:child_process');
  const sentinelPath = process.argv[1];
  const grandchild = spawn(process.execPath, [
    '-e',
    ${JSON.stringify(grandchildProgram)},
    sentinelPath
  ], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  grandchild.stdout.once('data', () => {
    process.stdout.write(JSON.stringify({
      childPid: process.pid,
      grandchildPid: grandchild.pid
    }) + '\\n');
  });
  setInterval(() => {}, 1000);
`;

await main();

async function main() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'soulforge-subprocess-control-'));
  const timeoutSentinel = join(fixtureRoot, 'timeout-grandchild.sentinel');
  const cancelSentinel = join(fixtureRoot, 'cancel-grandchild.sentinel');
  try {
    const timeoutStarted = performance.now();
    const timedOut = await runProcess({
      command: process.execPath,
      args: ['-e', treeProgram, timeoutSentinel],
      cwd: root,
      timeoutMs: 1_000
    });
    const timeoutElapsedMs = Math.round(performance.now() - timeoutStarted);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.cancelled, false);
    assert.ok(timeoutElapsedMs < 10_000, `timeout cleanup took ${timeoutElapsedMs}ms`);
    await assertTreeStopped(readTreePids(timedOut.stdout), timeoutSentinel, 'timeout');

    const controller = new AbortController();
    const cancelGuard = setTimeout(() => controller.abort('fixture-cancel-guard'), 5_000);
    const cancelled = await runProcess({
      command: process.execPath,
      args: ['-e', treeProgram, cancelSentinel],
      cwd: root,
      timeoutMs: 10_000,
      signal: controller.signal,
      onStdout: () => controller.abort('fixture-cancel')
    });
    clearTimeout(cancelGuard);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.timedOut, false);
    await assertTreeStopped(readTreePids(cancelled.stdout), cancelSentinel, 'cancellation');

    const completed = await runProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("controlled-ok")'],
      cwd: root,
      timeoutMs: 5_000
    });
    assert.equal(completed.code, 0);
    assert.equal(completed.timedOut, false);
    assert.equal(completed.cancelled, false);
    assert.equal(completed.stdout, 'controlled-ok');
    assert.equal(processSucceeded(completed), true);
    assert.equal(processSucceeded({ code: 0, timedOut: true, cancelled: false }), false);
    assert.equal(processSucceeded({ code: 0, timedOut: false, cancelled: true }), false);
    assert.equal(processSucceeded({ code: 1, timedOut: false, cancelled: false }), false);

    const defaultOutputLimitBytes = 2 * 1024 * 1024;
    const oversized = await runProcess({
      command: process.execPath,
      args: ['-e', `
        process.stdout.write('o'.repeat(${defaultOutputLimitBytes + 4096}));
        process.stderr.write('e'.repeat(${defaultOutputLimitBytes + 4096}));
      `],
      cwd: root,
      timeoutMs: 5_000
    });
    assert.equal(oversized.code, 0);
    assert.equal(oversized.stdoutTruncated, true);
    assert.equal(oversized.stderrTruncated, true);
    assert.equal(Buffer.byteLength(oversized.stdout), defaultOutputLimitBytes);
    assert.equal(Buffer.byteLength(oversized.stderr), defaultOutputLimitBytes);
    assert.match(oversized.stdout, /^o+$/u);
    assert.match(oversized.stderr, /^e+$/u);

    console.log(JSON.stringify({
      ok: true,
      status: 'passed',
      cases: [
        'timeout-kills-child-grandchild',
        'abort-kills-child-grandchild',
        'normal-completion',
        'zero-exit-timeout-and-cancel-fail-success-predicate',
        'default-output-limit'
      ],
      timeoutElapsedMs
    }, null, 2));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function readTreePids(stdout) {
  const firstLine = stdout.split(/\r?\n/u).find(Boolean);
  assert.ok(firstLine, 'tree fixture did not report process ids');
  const parsed = JSON.parse(firstLine);
  assert.ok(Number.isInteger(parsed.childPid) && parsed.childPid > 0, 'invalid child pid');
  assert.ok(
    Number.isInteger(parsed.grandchildPid) && parsed.grandchildPid > 0,
    'invalid grandchild pid'
  );
  return [parsed.childPid, parsed.grandchildPid];
}

async function assertTreeStopped(pids, sentinelPath, label) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessRunning(pid))) {
      const stoppedValue = await readFile(sentinelPath, 'utf8');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      const settledValue = await readFile(sentinelPath, 'utf8');
      assert.equal(settledValue, stoppedValue, `${label} grandchild sentinel kept changing`);
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const survivors = pids.filter(isProcessRunning);
  assert.fail(`${label} left process tree members alive: ${survivors.join(', ')}`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}
