import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runProcess } from './subprocess-control.mjs';
import { ownedTemporaryDirectoryObserver, prepareOwnedWindowsJob, recordOwnedProcess } from './owned-temporary-directory.mjs';

const helperPath = fileURLToPath(import.meta.url);

/** Persist a waiting supervisor before it can start work in an owned directory. */
export async function runOwnedProcess({ owner, signal, onStdout, onStderr, ...options }) {
  const supervisor = fork(helperPath, ['--worker'], {
    env: options.env, execArgv: [], detached: process.platform !== 'win32', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let result, reason = null, error;
  supervisor.stdout.on('data', chunk => onStdout?.(chunk));
  supervisor.stderr.on('data', chunk => onStderr?.(chunk));
  const closed = new Promise(resolveClosed => {
    supervisor.on('error', value => { error = value.message; });
    supervisor.on('message', value => {
      if (value.type === 'result') result = reason === 'timeout'
        ? { ...value.result, timedOut: true, cancelled: false, terminationReason: 'timeout' } : value.result;
    });
    supervisor.on('close', (code, closeSignal) => resolveClosed(result ?? {
      code: code ?? 1, signal: closeSignal, stdout: '', stderr: error ?? 'Owned process supervisor interrupted',
      stdoutTruncated: false, stderrTruncated: false, timeoutMs: options.timeoutMs,
      cancelled: reason === 'cancelled', timedOut: reason === 'timeout', terminationReason: reason ?? 'supervisor-exit'
    }));
  });
  const cancel = value => {
    reason ??= value;
    if (supervisor.connected) supervisor.send({ type: 'cancel', reason: value });
  };
  const onAbort = () => cancel('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  try {
    const ticket = await owner.trackProcess(supervisor.pid, {
      processGroup: process.platform !== 'win32', uncertainTree: process.platform === 'win32'
    });
    if (signal?.aborted) cancel('cancelled');
    if (options.timeoutMs) timer = setTimeout(() => cancel('timeout'), options.timeoutMs);
    supervisor.send({ type: 'start', ticket, options });
    return await closed;
  } catch (value) {
    supervisor.kill('SIGKILL'); await closed; throw value;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  }
}

if (process.argv[1] === helperPath && process.argv[2] === '--worker') {
  const cancellation = new AbortController();
  let started = false;
  // SIGKILL of the owner disconnects IPC. Keep observing the writer until it
  // finishes; the recorded supervisor/group protects every inherited child cwd.
  process.on('disconnect', () => {});
  // The owner may close these pipes during forced termination. Losing its log
  // consumer must not kill the supervisor while the writer is still running.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.on('SIGINT', () => cancellation.abort());
  process.on('SIGTERM', () => cancellation.abort());
  process.on('message', async message => {
    if (message.type === 'cancel') { cancellation.abort(message.reason); return; }
    if (message.type !== 'start' || started) return;
    started = true;
    try {
      const tickets = [message.ticket].flat();
      let options = message.options;
      if (process.platform === 'win32') {
        const id = randomUUID();
        for (const ticket of tickets) prepareOwnedWindowsJob(ticket, process.pid, id);
        const quote = value => {
          value = String(value);
          return value && !/[\s"]/.test(value) ? value : `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
        };
        const commandLine = [options.command, ...options.args].map(quote).join(' ');
        const source = await readFile(new URL('./owned-windows-job.ps1', import.meta.url), 'utf8');
        options = { ...options, command: 'powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
          stdinData: JSON.stringify({ ...message.options, commandLine, id, supervisorPid: process.pid,
            observer: ownedTemporaryDirectoryObserver(), tickets }) };
      }
      const result = await runProcess({ ...options, signal: cancellation.signal,
        detached: false, terminationGroup: process.platform !== 'win32' ? process.pid : undefined,
        onSpawn: child => { for (const ticket of [message.ticket].flat()) recordOwnedProcess(ticket, child.pid); },
        onStdout: chunk => { if (process.connected) process.stdout.write(chunk); },
        onStderr: chunk => { if (process.connected) process.stderr.write(chunk); } });
      // Windows has no POSIX group observer. A killed/uncertain tree remains
      // marked rather than being inferred dead from its former cmd PID.
      if (process.platform !== 'win32' || result.terminationReason === 'spawn-error' || result.treeTerminated) {
        for (const ticket of [message.ticket].flat()) recordOwnedProcess(ticket, process.pid, { finished: true });
      }
      if (process.connected) process.send({ type: 'result', result });
      process.exitCode = result.code || 0;
    } catch (error) {
      console.error(error.message); process.exitCode = 1;
    } finally {
      process.removeAllListeners('message');
      if (process.connected) process.disconnect();
    }
  });
}
