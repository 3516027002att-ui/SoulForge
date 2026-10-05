import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Decode a subprocess byte stream incrementally while retaining a UTF-8-safe
 * byte-bounded tail. Call end() after stream EOF (or process close) so an
 * incomplete final sequence is represented by StringDecoder's replacement
 * character, just as Buffer.toString('utf8') does for malformed input.
 */
export function createUtf8OutputTail(outputLimitBytes) {
  const decoder = new StringDecoder('utf8');
  let value = '';
  let truncated = false;
  let ended = false;

  const append = (text) => {
    if (!text) return;
    const next = value + text;
    if (Buffer.byteLength(next, 'utf8') <= outputLimitBytes) {
      value = next;
      return;
    }

    const bytes = Buffer.from(next, 'utf8');
    let start = Math.max(0, bytes.length - outputLimitBytes);
    // A valid UTF-8 string can only start inside a code point at a continuation
    // byte. Drop that incomplete leading code point rather than returning a
    // replacement character whose three bytes could exceed the byte limit.
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    value = bytes.subarray(start).toString('utf8');
    truncated = true;
  };

  return {
    write(chunk) {
      append(decoder.write(chunk));
    },
    end() {
      if (ended) return;
      ended = true;
      append(decoder.end());
    },
    get value() { return value; },
    get truncated() { return truncated; }
  };
}

export function readTimeoutMs(name, fallbackMs, { minMs = 100, maxMs = 60 * 60 * 1000 } = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackMs;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minMs || value > maxMs) {
    throw new Error(`${name} must be an integer between ${minMs} and ${maxMs} milliseconds`);
  }
  return value;
}

export function createProcessCancellation() {
  const controller = new AbortController();
  const onSigint = () => controller.abort('SIGINT');
  const onSigterm = () => controller.abort('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return {
    signal: controller.signal,
    dispose() {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  };
}

export function processSucceeded(result) {
  return result?.code === 0
    && result?.timedOut !== true
    && result?.cancelled !== true;
}

export async function runProcess({
  command,
  args = [],
  cwd,
  env = process.env,
  timeoutMs,
  signal,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  onStdout,
  onStderr,
  owner,
  onSpawn,
  detached = process.platform !== 'win32',
  terminationGroup,
  stdinData
}) {
  if (owner) {
    const { runOwnedProcess } = await import('./owned-process.mjs');
    return runOwnedProcess({ command, args, cwd, env, timeoutMs, signal, outputLimitBytes, onStdout, onStderr, owner });
  }
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached,
        stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      resolvePromise(failedSpawn(error));
      return;
    }
    try { if (child.pid) onSpawn?.(child); }
    catch (error) {
      let treeTerminated = false;
      const cancelForce = terminateProcessTree(child, terminationGroup, () => { treeTerminated = true; });
      child.stdout.resume(); child.stderr.resume();
      child.once('close', () => { cancelForce(); resolvePromise({ ...failedSpawn(error), terminationReason: 'ownership-error', treeTerminated }); });
      return;
    }
    if (stdinData !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdinData); }

    const stdoutOutput = createUtf8OutputTail(outputLimitBytes);
    const stderrOutput = createUtf8OutputTail(outputLimitBytes);
    let terminationReason = null;
    let spawnError = null;
    let treeTerminated = false;
    let settled = false;
    let cancelForcedTermination = () => {};

    child.stdout.on('data', (chunk) => {
      onStdout?.(chunk);
      stdoutOutput.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      onStderr?.(chunk);
      stderrOutput.write(chunk);
    });

    const terminate = (reason) => {
      if (terminationReason !== null) return;
      terminationReason = reason;
      cancelForcedTermination = terminateProcessTree(child, terminationGroup, () => { treeTerminated = true; });
    };
    const onAbort = () => terminate('cancelled');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const timer = timeoutMs ? setTimeout(() => terminate('timeout'), timeoutMs) : undefined;
    child.on('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });
    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      // Process close is the fallback for streams destroyed before EOF.
      stdoutOutput.end();
      stderrOutput.end();
      clearTimeout(timer);
      cancelForcedTermination();
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        code: code ?? 1,
        stdout: stdoutOutput.value,
        stderr: spawnError ? `${stderrOutput.value}\n${spawnError}`.trim() : stderrOutput.value,
        stdoutTruncated: stdoutOutput.truncated,
        stderrTruncated: stderrOutput.truncated,
        timedOut: terminationReason === 'timeout',
        cancelled: terminationReason === 'cancelled',
        terminationReason,
        treeTerminated,
        signal: closeSignal ?? null,
        timeoutMs
      });
    });
  });
}

function failedSpawn(error) {
  return {
    code: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    terminationReason: 'spawn-error',
    signal: null,
    timeoutMs: null
  };
}

function terminateProcessTree(child, group = child.pid, confirmed = () => {}) {
  if (!child.pid) return () => {};
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    if (killed.status !== 0) child.kill('SIGKILL');
    else confirmed();
    return () => {};
  }

  try {
    process.kill(-group, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const force = setTimeout(() => {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 2_000);
  force.unref();
  return () => clearTimeout(force);
}
