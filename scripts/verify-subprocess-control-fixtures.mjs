import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as subprocessControl from './subprocess-control.mjs';

const { processSucceeded, runProcess } = subprocessControl;

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

// A holder that outlives its driver while keeping the driver's inherited
// stdout/stderr open. Its own heartbeat proves identity before any signal.
const LINGER_MS = 15_000;
const lingerProgram = `
  // soulforge-owned-hang-linger
  const { writeFileSync } = require('node:fs');
  const sentinelPath = process.argv[1];
  let tick = 0;
  const beat = () => writeFileSync(sentinelPath, String(++tick), 'utf8');
  beat();
  const interval = setInterval(beat, 25);
  setTimeout(() => { clearInterval(interval); process.exit(0); }, Number(process.argv[2]));
`;
const lingerDriverProgram = `
  const { spawn } = require('node:child_process');
  const { existsSync, writeFileSync } = require('node:fs');
  const [pidPath, sentinelPath, lingerMs] = process.argv.slice(1);
  const holder = spawn(process.execPath, ['-e', ${JSON.stringify(lingerProgram)}, sentinelPath, lingerMs], {
    detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true
  });
  writeFileSync(pidPath, String(holder.pid), 'utf8');
  const until = Date.now() + 5000;
  while (!existsSync(sentinelPath) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  holder.unref();
  process.stdout.write('driver-ready\\n');
  process.exit(0);
`;

await main();

async function main() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'soulforge-subprocess-control-'));
  const timeoutSentinel = join(fixtureRoot, 'timeout-grandchild.sentinel');
  const cancelSentinel = join(fixtureRoot, 'cancel-grandchild.sentinel');
  try {
    const unicodeText = '仓库🙂';
    const unicodeBytes = Buffer.from(unicodeText, 'utf8');
    const unicodeBase64 = unicodeBytes.toString('base64');
    const splitWriter = `
      const bytes = Buffer.from(${JSON.stringify(unicodeBase64)}, 'base64');
      let offset = 0;
      function writeNextByte() {
        if (offset >= bytes.length) return;
        const byte = bytes.subarray(offset, offset + 1);
        offset += 1;
        process.stdout.write(byte);
        process.stderr.write(byte);
        setTimeout(writeNextByte, 25);
      }
      writeNextByte();
    `;
    const stdoutChunks = [];
    const stderrChunks = [];
    const splitUnicode = await runProcess({
      command: process.execPath,
      args: ['-e', splitWriter],
      cwd: root,
      timeoutMs: 5_000,
      outputLimitBytes: 64,
      onStdout: chunk => {
        assert.ok(Buffer.isBuffer(chunk), 'stdout callback must receive the original Buffer type');
        stdoutChunks.push(Buffer.from(chunk));
      },
      onStderr: chunk => {
        assert.ok(Buffer.isBuffer(chunk), 'stderr callback must receive the original Buffer type');
        stderrChunks.push(Buffer.from(chunk));
      }
    });
    assert.equal(splitUnicode.code, 0);
    assert.equal(splitUnicode.timedOut, false);
    assert.equal(splitUnicode.cancelled, false);
    assert.equal(splitUnicode.terminationReason, null);
    assert.equal(splitUnicode.stdout, unicodeText, 'stdout must decode UTF-8 split across stream chunks');
    assert.equal(splitUnicode.stderr, unicodeText, 'stderr must decode UTF-8 split across stream chunks');
    assert.ok(stdoutChunks.length > 1, 'stdout callback must receive multiple original byte chunks');
    assert.ok(stderrChunks.length > 1, 'stderr callback must receive multiple original byte chunks');
    assert.deepEqual(Buffer.concat(stdoutChunks), unicodeBytes, 'stdout callback bytes must remain unchanged');
    assert.deepEqual(Buffer.concat(stderrChunks), unicodeBytes, 'stderr callback bytes must remain unchanged');
    const hasSplitInsideCodePoint = chunks => {
      let byteOffset = 0;
      for (const chunk of chunks.slice(0, -1)) {
        byteOffset += chunk.length;
        if (byteOffset < unicodeBytes.length && (unicodeBytes[byteOffset] & 0xc0) === 0x80) return true;
      }
      return false;
    };
    assert.equal(hasSplitInsideCodePoint(stdoutChunks), true, 'fixture must split stdout inside a UTF-8 code point');
    assert.equal(hasSplitInsideCodePoint(stderrChunks), true, 'fixture must split stderr inside a UTF-8 code point');

    const tailLimitBytes = 7;
    const tailText = 'a仓🙂z';
    const tailResult = await runProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(tailText).toString('base64'))}, 'base64'))`],
      cwd: root,
      timeoutMs: 5_000,
      outputLimitBytes: tailLimitBytes
    });
    assert.equal(tailResult.code, 0);
    assert.equal(tailResult.stdoutTruncated, true);
    assert.equal(tailResult.stdout, '🙂z', 'truncated tail must drop a partial leading code point');
    assert.ok(Buffer.byteLength(tailResult.stdout, 'utf8') <= tailLimitBytes, 'truncated UTF-8 tail must stay within its byte limit');
    assert.equal(Buffer.from(tailResult.stdout, 'utf8').toString('utf8'), tailResult.stdout, 'truncated tail must be valid UTF-8');

    const incompleteResult = await runProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write(Buffer.from([0xe4, 0xbb])); process.stderr.write(Buffer.from([0xff]));"],
      cwd: root,
      timeoutMs: 5_000,
      outputLimitBytes: 64
    });
    assert.equal(incompleteResult.code, 0);
    assert.equal(incompleteResult.stdout, '\uFFFD', 'an incomplete final UTF-8 sequence must flush as a replacement character');
    assert.equal(incompleteResult.stderr, '\uFFFD', 'invalid final UTF-8 bytes must retain replacement decoding');

    // The direct collector cases make chunk splitting deterministic; the
    // process-level byte writer above remains the old-implementation RED.
    assert.equal(typeof subprocessControl.createUtf8OutputTail, 'function', 'the shared UTF-8 collector must be wired into subprocess control');
    const splitCollector = subprocessControl.createUtf8OutputTail(64);
    for (const byte of unicodeBytes) splitCollector.write(Buffer.from([byte]));
    splitCollector.end();
    assert.equal(splitCollector.value, unicodeText);
    assert.equal(splitCollector.truncated, false);

    for (const [limit, expected] of [[8, '仓🙂z'], [7, '🙂z'], [3, 'z'], [0, '']]) {
      const collector = subprocessControl.createUtf8OutputTail(limit);
      collector.write(Buffer.from(tailText, 'utf8'));
      collector.end();
      assert.equal(collector.value, expected, `tail at ${limit} bytes must retain whole UTF-8 code points`);
      assert.equal(collector.truncated, true);
      assert.ok(Buffer.byteLength(collector.value, 'utf8') <= limit);
      assert.equal(Buffer.from(collector.value, 'utf8').toString('utf8'), collector.value);
    }

    const incompleteCollector = subprocessControl.createUtf8OutputTail(64);
    incompleteCollector.write(Buffer.from([0xf0, 0x9f, 0x99]));
    incompleteCollector.end();
    assert.equal(incompleteCollector.value, '\uFFFD');
    assert.equal(incompleteCollector.truncated, false);

    const undersizedCollector = subprocessControl.createUtf8OutputTail(2);
    undersizedCollector.write(Buffer.from([0xf0, 0x9f, 0x99]));
    undersizedCollector.end();
    assert.equal(undersizedCollector.value, '');
    assert.equal(undersizedCollector.truncated, true);
    assert.ok(Buffer.byteLength(undersizedCollector.value, 'utf8') <= 2);

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

    // The driver exits at once; a detached holder keeps its inherited stdio
    // open for LINGER_MS. Waiting only for 'close' would wait for that holder.
    const lingerResults = [];
    const runLingerCase = async (name, run) => {
      const pidPath = join(fixtureRoot, `${name}.pid`);
      const sentinelPath = join(fixtureRoot, `${name}.sentinel`);
      const timing = { started: performance.now(), runElapsedMs: null };
      let failure = null;
      try {
        await run(pidPath, sentinelPath, timing);
      } catch (error) {
        failure = error;
      } finally {
        try { await stopLingeringHolder(pidPath, sentinelPath, name); }
        catch (error) { failure ??= error; }
      }
      lingerResults.push({ name, ok: failure === null, runElapsedMs: timing.runElapsedMs,
        error: failure === null ? null : failure.message });
    };

    await runLingerCase('timeout-after-exit-releases-inherited-stdio', async (pidPath, sentinelPath, timing) => {
      const result = await runProcess({
        command: process.execPath,
        args: ['-e', lingerDriverProgram, pidPath, sentinelPath, String(LINGER_MS)],
        cwd: root,
        timeoutMs: 1_000
      });
      timing.runElapsedMs = Math.round(performance.now() - timing.started);
      assert.ok(timing.runElapsedMs < 8_000,
        `timeout after driver exit waited ${timing.runElapsedMs}ms for an inherited stdio holder`);
      assert.equal(result.timedOut, true);
      assert.equal(result.cancelled, false);
      assert.equal(result.terminationReason, 'timeout');
      assert.notEqual(result.code, 0, 'an unowned stdio holder must not leave a success code');
      assert.match(result.stdout, /driver-ready/u, 'output delivered before the timeout must be retained');
      assert.equal(await sentinelIsChanging(sentinelPath), true, 'the holder must still be alive when the run resolves');
    });

    await runLingerCase('stdio-drain-bounds-inherited-stdio', async (pidPath, sentinelPath, timing) => {
      const result = await runProcess({
        command: process.execPath,
        args: ['-e', lingerDriverProgram, pidPath, sentinelPath, String(LINGER_MS)],
        cwd: root,
        stdioDrainMs: 500
      });
      timing.runElapsedMs = Math.round(performance.now() - timing.started);
      assert.ok(timing.runElapsedMs < 5_000,
        `stdioDrainMs did not bound the post-exit drain: waited ${timing.runElapsedMs}ms`);
      assert.equal(result.terminationReason, 'stdio-held-after-exit');
      assert.equal(result.outputError, 'PROCESS_STDIO_HELD_AFTER_EXIT');
      assert.equal(result.code, 1, 'held stdio after exit is a failure, matching descendant-leak');
      assert.equal(result.childExitCode, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
      assert.match(result.stdout, /driver-ready/u, 'output delivered before the drain bound must be retained');
      assert.equal(await sentinelIsChanging(sentinelPath), true, 'the holder must still be alive when the run resolves');

      const drained = await runProcess({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("drain-ok")'],
        cwd: root,
        timeoutMs: 5_000,
        stdioDrainMs: 500
      });
      assert.equal(drained.code, 0, 'a normal close must win over the drain bound');
      assert.equal(drained.terminationReason, null);
      assert.equal(drained.stdout, 'drain-ok');
    });

    // A busy runner can stall the holder's heartbeat for longer than one
    // observation window. Cleanup must still stop it instead of concluding
    // from one quiet window that it is gone. SIGSTOP makes that stall exact.
    if (process.platform !== 'win32') {
      await runLingerCase('cleanup-stops-holder-after-stalled-heartbeat', async (pidPath, sentinelPath, timing) => {
        const result = await runProcess({
          command: process.execPath,
          args: ['-e', lingerDriverProgram, pidPath, sentinelPath, '8000'],
          cwd: root,
          stdioDrainMs: 300
        });
        timing.runElapsedMs = Math.round(performance.now() - timing.started);
        assert.equal(result.terminationReason, 'stdio-held-after-exit');
        const pid = Number(await readFile(pidPath, 'utf8'));
        process.kill(pid, 'SIGSTOP');
        setTimeout(() => { try { process.kill(pid, 'SIGCONT'); } catch { /* already gone */ } }, 400).unref();
      });
    }

    console.error(JSON.stringify({ lingerResults }));
    const lingerFailures = lingerResults.filter(item => !item.ok);
    assert.equal(lingerFailures.length, 0,
      `inherited stdio cases failed: ${lingerFailures.map(item => `${item.name} (${item.runElapsedMs}ms): ${item.error}`).join(' | ')}`);

    console.log(JSON.stringify({
      ok: true,
      status: 'passed',
      cases: [
        'split-multibyte-stdout-stderr-and-raw-callback-buffers',
        'utf8-safe-output-tail-byte-limit',
        'incomplete-final-utf8-flush',
        'timeout-kills-child-grandchild',
        'abort-kills-child-grandchild',
        'normal-completion',
        'zero-exit-timeout-and-cancel-fail-success-predicate',
        'default-output-limit',
        'timeout-after-exit-releases-inherited-stdio',
        'stdio-drain-bounds-inherited-stdio',
        ...(process.platform !== 'win32' ? ['cleanup-stops-holder-after-stalled-heartbeat'] : [])
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

async function sentinelIsChanging(sentinelPath) {
  let before;
  try { before = await readFile(sentinelPath, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  return (await readFile(sentinelPath, 'utf8')) !== before;
}

/** Stop only a holder whose own heartbeat still proves the PID is ours. */
async function stopLingeringHolder(pidPath, sentinelPath, label) {
  let pid;
  try { pid = Number(await readFile(pidPath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  // One quiet window is not proof the holder is gone: a busy runner can stall
  // its heartbeat. Every observation that still shows it beating (only the
  // holder writes this sentinel, so a reused PID never qualifies) kills it.
  let killed = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const beating = await sentinelIsChanging(sentinelPath);
    if (!beating && !isProcessRunning(pid)) return;
    if (beating) {
      try { process.kill(pid, 'SIGKILL'); killed = true; } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.fail(`${label} lingering stdio holder ${pid} did not exit (${killed ? 'SIGKILL sent' : 'no SIGKILL sent'}; ${await describeHolder(pid, sentinelPath)})`);
}

async function describeHolder(pid, sentinelPath) {
  let state = 'state unknown';
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      state = `state ${fields[0]}, ppid ${fields[1]}`;
    } catch (error) { state = error?.code === 'ENOENT' ? 'no /proc entry' : `stat ${error?.code}`; }
  }
  return `${state}, heartbeat ${await sentinelIsChanging(sentinelPath) ? 'changing' : 'stopped'}`;
}
