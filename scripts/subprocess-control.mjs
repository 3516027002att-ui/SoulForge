import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

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

export function runProcess({
  command,
  args = [],
  cwd,
  env = process.env,
  timeoutMs,
  signal,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  onStdout,
  onStderr
}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolvePromise(failedSpawn(error));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let terminationReason = null;
    let spawnError = null;
    let settled = false;
    let cancelForcedTermination = () => {};

    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) <= outputLimitBytes) return { value: next, truncated: false };
      return {
        value: Buffer.from(next).subarray(-outputLimitBytes).toString(),
        truncated: true
      };
    };

    child.stdout.on('data', (chunk) => {
      onStdout?.(chunk);
      const next = append(stdout, chunk);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on('data', (chunk) => {
      onStderr?.(chunk);
      const next = append(stderr, chunk);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });

    const terminate = (reason) => {
      if (terminationReason !== null) return;
      terminationReason = reason;
      cancelForcedTermination = terminateProcessTree(child);
    };
    const onAbort = () => terminate('cancelled');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    child.on('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });
    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelForcedTermination();
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr: spawnError ? `${stderr}\n${spawnError}`.trim() : stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut: terminationReason === 'timeout',
        cancelled: terminationReason === 'cancelled',
        terminationReason,
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

function terminateProcessTree(child) {
  if (!child.pid) return () => {};
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    if (killed.status !== 0) child.kill('SIGKILL');
    return () => {};
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const force = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 2_000);
  force.unref();
  return () => clearTimeout(force);
}
