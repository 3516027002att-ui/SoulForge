import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './subprocess-control.mjs';
import { runLinuxGuardianProcess } from './owned-process-linux-guardian.mjs';
import { ownedTemporaryDirectoryObserver, prepareOwnedWindowsJob, recordOwnedProcess } from './owned-temporary-directory.mjs';

const helperPath = fileURLToPath(import.meta.url);
// The guardian exits only after TerminateJobObject and ActiveProcesses == 0.
// A pipe still open after that belongs to a process outside the job; waiting
// longer cannot make it owned. Bound the post-exit drain instead of hanging.
export const WINDOWS_GUARDIAN_STDIO_DRAIN_MS = 5_000;

function isCompleteProcessResult(value) {
  return value && typeof value === 'object' && Number.isSafeInteger(value.code)
    && typeof value.stdout === 'string' && typeof value.stderr === 'string'
    && typeof value.stdoutTruncated === 'boolean' && typeof value.stderrTruncated === 'boolean'
    && typeof value.cancelled === 'boolean' && typeof value.timedOut === 'boolean'
    && (value.signal === null || typeof value.signal === 'string')
    && (value.terminationReason === null || typeof value.terminationReason === 'string');
}

/** Persist a waiting supervisor before it can start work in an owned directory. */
export async function runOwnedProcess({ owner, signal, onStdout, onStderr, ...options }) {
  const supervisor = fork(helperPath, ['--worker'], {
    env: options.env, execArgv: [], detached: process.platform !== 'win32', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let result, reason = null, error, ticket;
  supervisor.stdout.on('data', chunk => onStdout?.(chunk));
  supervisor.stderr.on('data', chunk => onStderr?.(chunk));
  const closed = new Promise(resolveClosed => {
    supervisor.on('error', value => { error = value.message; });
    supervisor.on('message', value => {
      if (value.type === 'result') result = value.result;
    });
    supervisor.on('close', (code, closeSignal) => {
      let finalResult = result ?? {
        // The supervisor close code is not the writer's receipt. In
        // particular, close(0) without a result must never be process-success.
        // Preserve a real nonzero code for diagnostics, but map missing/zero
        // close status to a failure and expose the missing receipt explicitly.
        code: Number.isSafeInteger(code) && code !== 0 ? code : 1,
        signal: closeSignal, stdout: '', stderr: error ?? 'Owned process supervisor interrupted',
        stdoutTruncated: false, stderrTruncated: false, timeoutMs: options.timeoutMs,
        cancelled: reason === 'cancelled', timedOut: reason === 'timeout', terminationReason: reason ?? 'supervisor-exit',
        outputError: 'OWNED_TEST_RESULT_UNAVAILABLE', supervisorExitCode: code, supervisorSignal: closeSignal
      };
      if (reason === 'timeout' && result) finalResult = { ...result, timedOut: true, cancelled: false, terminationReason: 'timeout' };
      else if (reason === 'cancelled' && result) finalResult = { ...result, timedOut: false, cancelled: true, terminationReason: 'cancelled' };

      const completeResult = isCompleteProcessResult(finalResult);
      const expectedSupervisorCode = Number.isSafeInteger(finalResult.code) ? finalResult.code || 0 : null;
      const supervisorClosedNormally = closeSignal === null && code === expectedSupervisorCode;
      if (result && (!completeResult || !supervisorClosedNormally)) {
        finalResult = { ...finalResult, code: finalResult.code || 1, terminationReason: 'supervisor-exit',
          outputError: error ?? `Owned process supervisor exit did not match its result (${code ?? 'null'}, ${closeSignal ?? 'none'})` };
      }

      // On Linux the worker only reports the writer result. The owner process
      // alone may retire its uncertain-tree ticket, and only after receiving a
      // complete normal receipt and observing the supervisor close normally.
      // Cancellation/timer state is sampled here so a late receipt cannot
      // erase uncertainty after the parent has already interrupted the run.
      if (process.platform === 'linux' && result && finalResult.treeStopped !== true && finalResult.code === 0) {
        finalResult = { ...finalResult, code: 1, terminationReason: 'tree-unproven',
          outputError: finalResult.outputError ?? 'OWNED_PROCESS_TREE_UNPROVEN' };
      }
      if (process.platform === 'linux' && result && supervisorClosedNormally
        && !isCompleteLinuxTreeResult(finalResult)) {
        finalResult = { ...finalResult, code: finalResult.code || 1, treeStopped: false,
          terminationReason: 'tree-unproven', outputError: 'OWNED_PROCESS_TREE_UNPROVEN' };
      }
      // A descendant leak is an operation failure, but ECHILD proves the tree
      // is stopped and permits safe disposal. Parent cancellation/timeout and
      // every missing/invalid proof remain uncertain.
      const linuxTreeStopped = process.platform === 'linux' && completeResult
        && supervisorClosedNormally && isCompleteLinuxTreeResult(finalResult)
        && finalResult.treeStopped === true && finalResult.cancelled === false && finalResult.timedOut === false
        && finalResult.terminationReason !== 'cancelled' && finalResult.terminationReason !== 'timeout';
      if (process.platform === 'linux' && ticket && reason === null && signal?.aborted !== true
        && linuxTreeStopped) {
        try {
          for (const item of [ticket].flat()) recordOwnedProcess(item, supervisor.pid, { finished: true });
        }
        catch (value) {
          error = value.message;
          finalResult = { ...finalResult, code: finalResult.code || 1, terminationReason: 'supervisor-exit',
            outputError: `OWNED_TEMP_TREE_RECEIPT_PUBLISH_FAILED: ${error}` };
        }
      }
      resolveClosed(finalResult);
    });
  });
  const cancel = value => {
    reason ??= value;
    if (supervisor.connected) supervisor.send({ type: 'cancel', reason: value });
  };
  const onAbort = () => cancel('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  try {
    ticket = await owner.trackProcess(supervisor.pid, {
      processGroup: process.platform !== 'win32', uncertainTree: process.platform === 'win32' || process.platform === 'linux'
    });
    if (signal?.aborted) cancel('cancelled');
    if (options.timeoutMs) timer = setTimeout(() => cancel('timeout'), options.timeoutMs);
    // The worker's own TEMP is redirected into the owned root; the owner's is
    // not, so it is where the Windows guardian compiles (see the worker).
    supervisor.send({ type: 'start', ticket, options, guardianTemp: tmpdir() });
    return await closed;
  } catch (value) {
    supervisor.kill('SIGKILL'); await closed; throw value;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  }
}

// The guardian's TEMP must not be (or be inside) one of this operation's
// owned roots. Unknown spellings or missing paths do not count as outside.
function outsideOwnedRoots(candidate, tickets) {
  if (typeof candidate !== 'string' || !candidate) return false;
  try {
    const temp = realpathSync.native(candidate);
    return tickets.every(ticket => {
      const rel = relative(realpathSync.native(ticket.root), temp);
      return rel !== '' && (isAbsolute(rel) || rel.split(/[\\/]/)[0] === '..');
    });
  } catch { return false; }
}

// Absent or unparseable at the published path: the guardian's 'assigned'
// write (or atomic replacement) never completed for that ticket.
function jobProofIncomplete(tickets, id) {
  if (!id) return false;
  return tickets.some(ticket => {
    try { JSON.parse(readFileSync(join(ticket.root, `.soulforge-windows-job.${id}.json`), 'utf8')); return false; }
    catch (error) { return error.code === 'ENOENT' || error instanceof SyntaxError; }
  });
}

function isCompleteLinuxTreeResult(value) {
  if (!isCompleteProcessResult(value) || typeof value.treeStopped !== 'boolean'
    || typeof value.descendantsObserved !== 'boolean'
    || value.code < 0 || value.code > 255
    || (value.childExitCode !== null && (!Number.isSafeInteger(value.childExitCode)
      || value.childExitCode < 0 || value.childExitCode > 255))) return false;

  const { code, signal, childExitCode, treeStopped, descendantsObserved, terminationReason, cancelled, timedOut } = value;
  const knownReasons = [null, 'cancelled', 'timeout', 'spawn-error', 'descendant-leak',
    'guardian-capability-unavailable', 'guardian-child-state-unavailable', 'tree-unproven', 'guardian-unavailable'];
  if (!knownReasons.includes(terminationReason)) return false;
  if ((cancelled && (timedOut || terminationReason !== 'cancelled'))
    || (timedOut && terminationReason !== 'timeout')
    || (terminationReason === 'cancelled' && !cancelled)
    || (terminationReason === 'timeout' && !timedOut)) return false;

  if (signal !== null && !/^SIG[A-Z0-9]+$/.test(signal)) return false;
  if (descendantsObserved && !['descendant-leak', 'timeout', 'cancelled'].includes(terminationReason)) return false;
  if (terminationReason === 'descendant-leak' && !descendantsObserved) return false;

  if (treeStopped) {
    if (['guardian-capability-unavailable', 'guardian-child-state-unavailable', 'tree-unproven', 'guardian-unavailable'].includes(terminationReason)) return false;
    if (signal === null ? childExitCode === null : childExitCode !== null) return false;
    if (signal !== null) {
      const signalNumber = osConstants.signals[signal];
      if (signalNumber !== undefined && code !== 128 + signalNumber) return false;
      if (signalNumber === undefined && (signal !== 'SIGUNKNOWN' || code < 129 || code > 192)) return false;
    } else if (code !== childExitCode
      && !(code === 1 && childExitCode === 0 && ['descendant-leak', 'timeout', 'cancelled'].includes(terminationReason))) {
      return false;
    }
    if (code === 0) return signal === null && childExitCode === 0 && !descendantsObserved
      && (terminationReason === null && !cancelled && !timedOut
        || terminationReason === 'timeout' && timedOut
        || terminationReason === 'cancelled' && cancelled);
    if (terminationReason === 'spawn-error') return signal === null && childExitCode !== null;
    if (terminationReason === 'timeout' || terminationReason === 'cancelled') return code !== 0;
    if (terminationReason === 'descendant-leak') return code !== 0 && descendantsObserved;
    return terminationReason === null;
  }

  return code !== 0 && terminationReason !== null;
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
      let options = message.options, windowsJobId = null, isolatedGuardianTemp = false;
      if (process.platform === 'win32') {
        const id = windowsJobId = randomUUID();
        for (const ticket of tickets) prepareOwnedWindowsJob(ticket, process.pid, id);
        const quote = value => {
          value = String(value);
          return value && !/[\s"]/.test(value) ? value : `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
        };
        const commandLine = [options.command, ...options.args].map(quote).join(' ');
        // -EncodedCommand (UTF-16LE base64) must fit the 32767-character command
        // line. Comments, blank lines and indentation are for readers of the
        // .ps1 files; no line of these scripts that starts with # or // carries
        // code, and the C# here-string does not depend on indentation.
        const source = (await Promise.all(['owned-windows-job-status.ps1', 'owned-windows-job.ps1']
          .map(name => readFile(new URL(name, import.meta.url), 'utf8')))).join('\n')
          .split(/\r?\n/).map(line => line.trimStart()).filter(line => line && !line.startsWith('#') && !line.startsWith('//')).join('\n');
        // The guardian compiles its job helper (Add-Type -> csc.exe) before any
        // job exists. Give it a TEMP outside every owned root, so a compiler
        // that outlives a guardian killed before its job proof cannot write
        // into one; the driver gets its own TEMP/TMP back (driverTemp).
        const env = options.env ?? process.env;
        const pick = name => env[Object.keys(env).find(key => key.toUpperCase() === name) ?? name] ?? '';
        const driverTemp = { TEMP: pick('TEMP'), TMP: pick('TMP') };
        isolatedGuardianTemp = outsideOwnedRoots(message.guardianTemp, tickets);
        const guardianEnv = isolatedGuardianTemp
          ? { ...Object.fromEntries(Object.entries(env).filter(([key]) => !['TEMP', 'TMP'].includes(key.toUpperCase()))),
            TEMP: message.guardianTemp, TMP: message.guardianTemp }
          : env;
        options = { ...options, env: guardianEnv, command: 'powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
          stdinData: JSON.stringify({ ...message.options, commandLine, id, supervisorPid: process.pid,
            observer: ownedTemporaryDirectoryObserver(), tickets, ...(isolatedGuardianTemp ? { driverTemp } : {}) }) };
      }
      const guardedOptions = { ...options, signal: cancellation.signal,
        onSpawn: child => { for (const ticket of [message.ticket].flat()) recordOwnedProcess(ticket, child.pid); },
        onStdout: chunk => { if (process.connected) process.stdout.write(chunk); },
        onStderr: chunk => { if (process.connected) process.stderr.write(chunk); } };
      const result = process.platform === 'linux'
        ? await runLinuxGuardianProcess(guardedOptions)
        : await runProcess({ ...guardedOptions, detached: false,
          stdioDrainMs: process.platform === 'win32' ? WINDOWS_GUARDIAN_STDIO_DRAIN_MS : undefined,
          terminationGroup: process.platform !== 'win32' ? process.pid : undefined });
      // Windows has no POSIX group observer. A killed/uncertain tree remains
      // marked rather than being inferred dead from its former cmd PID, with
      // one proven exception: runProcess resolves only after the guardian's
      // own exit, and a job proof that is absent or incomplete means it ended
      // before every 'assigned' proof was written. The driver is created
      // suspended inside the guardian's kill-on-close job and resumed only
      // after those proofs, so no driver ran; the guardian's compiler wrote
      // only to a TEMP outside the owned roots.
      if (process.platform === 'win32' && (result.terminationReason === 'spawn-error' || result.treeTerminated
        || (isolatedGuardianTemp && jobProofIncomplete(tickets, windowsJobId)))) {
        for (const ticket of [message.ticket].flat()) recordOwnedProcess(ticket, process.pid, { finished: true });
      }
      // A large result can still be queued after send() returns. Disconnecting
      // first loses the receipt even when the writer exited successfully.
      if (process.connected) await new Promise((resolveSent, rejectSent) => {
        process.send({ type: 'result', result }, error => error ? rejectSent(error) : resolveSent());
      });
      // Linux uncertainty is cleared by the owner side only after it receives
      // this complete result and observes our normal close. A lost IPC receipt,
      // parent interruption, cancellation, or timeout remains retained.
      process.exitCode = result.code || 0;
    } catch (error) {
      console.error(error.message); process.exitCode = 1;
    } finally {
      process.removeAllListeners('message');
      if (process.connected) process.disconnect();
    }
  });
}
