import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const sourcePath = resolve(scriptDirectory, 'owned-process-linux-guardian.c');
const artifactDirectory = resolve(repositoryRoot, '.local-validation/owned-process-guardian/linux-x64');
const binaryName = 'soulforge-owned-process-guardian';
const binaryFilePattern = new RegExp(`^${binaryName}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
const manifestName = `${binaryName}.manifest.json`;
const protocol = 'soulforge.owned-process-guardian.v1';
const protocolVersion = 1;
const compilerFlags = ['-D_GNU_SOURCE', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
const defaultOutputLimitBytes = 2 * 1024 * 1024;
const receiptLimitBytes = 16 * 1024;
const guardianStopDeadlineMs = 8_000;
const guardianStdioDrainDeadlineMs = 500;

const hash = value => createHash('sha256').update(value).digest('hex');
const missing = error => error?.code === 'ENOENT';

async function inspectRegularFile(path, maxBytes = Number.MAX_SAFE_INTEGER) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
    throw new Error('OWNED_PROCESS_GUARDIAN_ARTIFACT_INVALID');
  }
  return stat;
}

async function verifyGuardianArtifact(directory = artifactDirectory) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('OWNED_PROCESS_GUARDIAN_PLATFORM_UNSUPPORTED');
  const resolvedDirectory = resolve(directory);
  const directoryStat = await lstat(resolvedDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(resolvedDirectory) !== resolvedDirectory) {
    throw new Error('OWNED_PROCESS_GUARDIAN_ARTIFACT_INVALID');
  }
  const manifestPath = resolve(resolvedDirectory, manifestName);
  await inspectRegularFile(sourcePath, 256 * 1024);
  if (await realpath(sourcePath) !== sourcePath) throw new Error('OWNED_PROCESS_GUARDIAN_ARTIFACT_INVALID');
  await inspectRegularFile(manifestPath, 16 * 1024);
  const rawManifest = await readFile(manifestPath, 'utf8');
  let manifest;
  try { manifest = JSON.parse(rawManifest); }
  catch { throw new Error('OWNED_PROCESS_GUARDIAN_ARTIFACT_INVALID'); }
  if (manifest.schema !== 'soulforge.owned-process-guardian-build.v2'
    || manifest.protocol !== protocol || manifest.protocolVersion !== protocolVersion
    || manifest.platform !== 'linux' || manifest.arch !== 'x64'
    || typeof manifest.binaryFile !== 'string' || !binaryFilePattern.test(manifest.binaryFile)
    || !manifest.compiler || typeof manifest.compiler.command !== 'string' || !manifest.compiler.command
    || typeof manifest.compiler.version !== 'string' || !manifest.compiler.version
    || JSON.stringify(manifest.compiler.flags) !== JSON.stringify(compilerFlags)) {
    throw new Error('OWNED_PROCESS_GUARDIAN_ARTIFACT_STALE');
  }
  const binaryPath = resolve(resolvedDirectory, manifest.binaryFile);
  if (dirname(binaryPath) !== resolvedDirectory) throw new Error('OWNED_PROCESS_GUARDIAN_ARTIFACT_INVALID');
  await inspectRegularFile(binaryPath);
  await access(binaryPath, fsConstants.X_OK);
  const [source, binary] = await Promise.all([readFile(sourcePath), readFile(binaryPath)]);
  if (manifest.sourceSha256 !== hash(source) || manifest.binarySha256 !== hash(binary)) {
    throw new Error('OWNED_PROCESS_GUARDIAN_ARTIFACT_STALE');
  }
  return binaryPath;
}

function appendOutput(current, chunk, outputLimitBytes) {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= outputLimitBytes) return { value: next, truncated: false };
  return { value: Buffer.from(next).subarray(-outputLimitBytes).toString(), truncated: true };
}

function failedResult({ error, reason, timeoutMs, stdout = '', stderr = '', stdoutTruncated = false,
  stderrTruncated = false, childExitCode = null, descendantsObserved = false }) {
  const outputError = error === 'OWNED_PROCESS_GUARDIAN_ARTIFACT_STALE'
    ? 'OWNED_PROCESS_GUARDIAN_STALE'
    : error?.startsWith('OWNED_PROCESS_GUARDIAN_') ? error : 'OWNED_PROCESS_TREE_UNPROVEN';
  const prepareHint = ['OWNED_PROCESS_GUARDIAN_UNAVAILABLE', 'OWNED_PROCESS_GUARDIAN_STALE',
    'OWNED_PROCESS_GUARDIAN_ARTIFACT_INVALID'].includes(outputError)
    ? '\nRun `npm run prepare:owned-process-guardian` before retrying.' : '';
  return {
    code: 1, childExitCode, stdout,
    stderr: `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}${error}${prepareHint}`,
    stdoutTruncated, stderrTruncated, timedOut: reason === 'timeout', cancelled: reason === 'cancelled',
    terminationReason: reason ?? (outputError === 'OWNED_PROCESS_TREE_UNPROVEN' ? 'tree-unproven' : 'guardian-unavailable'),
    signal: null, timeoutMs, outputError, treeStopped: false, descendantsObserved
  };
}

function parseReceipt(chunks, byteLength, nonce) {
  if (byteLength <= 0 || byteLength > receiptLimitBytes) throw new Error('OWNED_PROCESS_GUARDIAN_RECEIPT_INVALID');
  const text = Buffer.concat(chunks, byteLength).toString('utf8');
  if (!text.endsWith('\n') || (text.match(/\n/g) ?? []).length !== 1) throw new Error('OWNED_PROCESS_GUARDIAN_RECEIPT_INVALID');
  const receipt = JSON.parse(text);
  if (!receipt || typeof receipt !== 'object' || receipt.protocol !== protocol || receipt.nonce !== nonce
    || !Number.isSafeInteger(receipt.code) || receipt.code < 0 || receipt.code > 255
    || !Number.isSafeInteger(receipt.spawnErrno) || receipt.spawnErrno < 0
    || (receipt.signal !== null && typeof receipt.signal !== 'string')
    || (receipt.childExitCode !== null && (!Number.isSafeInteger(receipt.childExitCode)
      || receipt.childExitCode < 0 || receipt.childExitCode > 255))
    || typeof receipt.treeStopped !== 'boolean' || typeof receipt.descendantsObserved !== 'boolean'
    || (receipt.terminationReason !== null && !['cancelled', 'timeout', 'spawn-error', 'descendant-leak', 'guardian-capability-unavailable', 'guardian-child-state-unavailable', 'tree-unproven'].includes(receipt.terminationReason))
    || !receiptSemanticsAreConsistent(receipt)) {
    throw new Error('OWNED_PROCESS_GUARDIAN_RECEIPT_INVALID');
  }
  return receipt;
}

function receiptSemanticsAreConsistent(receipt) {
  const { code, signal, childExitCode, treeStopped, descendantsObserved, terminationReason, spawnErrno } = receipt;
  if (signal !== null) {
    if (childExitCode !== null || spawnErrno !== 0 || !/^SIG[A-Z0-9]+$/.test(signal)) return false;
    const signalNumber = osConstants.signals[signal];
    if (signalNumber !== undefined && code !== 128 + signalNumber) return false;
    if (signalNumber === undefined && (signal !== 'SIGUNKNOWN' || code < 129 || code > 192)) return false;
  } else if (childExitCode !== null && code !== childExitCode
    && !(code === 1 && childExitCode === 0 && (terminationReason === 'descendant-leak'
      || (!treeStopped && ['tree-unproven', 'timeout', 'cancelled'].includes(terminationReason))))) {
    return false;
  }

  if (spawnErrno > 0 && !['spawn-error', 'guardian-capability-unavailable', 'guardian-child-state-unavailable'].includes(terminationReason)) return false;
  if (spawnErrno === 0 && terminationReason === 'spawn-error') return false;
  if (descendantsObserved && !['descendant-leak', 'timeout', 'cancelled'].includes(terminationReason)) return false;
  if (terminationReason === 'descendant-leak' && !descendantsObserved) return false;

  if (!treeStopped) {
    if (code === 0 || terminationReason === null) return false;
    if (['guardian-capability-unavailable', 'guardian-child-state-unavailable'].includes(terminationReason)) {
      return code === 1 && signal === null && childExitCode === null && !descendantsObserved && spawnErrno > 0;
    }
    return true;
  }

  if (signal === null && childExitCode === null) return false;
  if (['tree-unproven', 'guardian-capability-unavailable', 'guardian-child-state-unavailable'].includes(terminationReason)) return false;
  if (code === 0) {
    return signal === null && childExitCode === 0 && spawnErrno === 0
      && (terminationReason === null && !descendantsObserved
        || terminationReason === 'timeout' || terminationReason === 'cancelled');
  }
  if (terminationReason === 'descendant-leak' && code === 0) return false;
  if (terminationReason === 'spawn-error' && code === 0) return false;
  return true;
}

/** Linux-only owned target launcher. The native guardian owns the target and is the sole wait/reap owner. */
export async function runLinuxGuardianProcess(options, guardianDirectory = artifactDirectory) {
  const { command, args = [], cwd, env = process.env, timeoutMs, signal, onStdout, onStderr, onSpawn,
    outputLimitBytes = defaultOutputLimitBytes, stdinData } = options;
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    return failedResult({ error: 'OWNED_PROCESS_GUARDIAN_REQUEST_INVALID', timeoutMs });
  }
  if (stdinData !== undefined && typeof stdinData !== 'string' && !Buffer.isBuffer(stdinData) && !(stdinData instanceof Uint8Array)) {
    return failedResult({ error: 'OWNED_PROCESS_GUARDIAN_STDIN_UNSUPPORTED', timeoutMs });
  }
  if (signal?.aborted) {
    return failedResult({ error: 'OWNED_PROCESS_GUARDIAN_NOT_STARTED', reason: 'cancelled', timeoutMs });
  }
  let executable;
  try { executable = await verifyGuardianArtifact(guardianDirectory); }
  catch (error) { return failedResult({ error: missing(error) ? 'OWNED_PROCESS_GUARDIAN_UNAVAILABLE' : error.message, timeoutMs }); }
  if (signal?.aborted) {
    return failedResult({ error: 'OWNED_PROCESS_GUARDIAN_NOT_STARTED', reason: 'cancelled', timeoutMs });
  }

  const nonce = randomUUID();
  let child;
  try {
    child = spawn(executable, ['--nonce', nonce, '--timeout-ms', String(timeoutMs ?? 0), '--', command, ...args], {
      cwd, env, shell: false, windowsHide: true, detached: false,
      stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    return failedResult({ error: `OWNED_PROCESS_GUARDIAN_SPAWN_FAILED: ${error.message}`, timeoutMs });
  }

  let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false;
  let receiptBytes = 0, receiptChunks = [], spawnError = null, ownerError = null;
  let terminationReason = null, closed = false, hardStopTimer;
  const forceStopGuardian = () => {
    if (!closed && child.pid) child.kill('SIGKILL');
  };
  const requestStop = reason => {
    if (terminationReason !== null) return;
    terminationReason = reason;
    if (child.pid) child.kill(reason === 'timeout' ? 'SIGUSR1' : 'SIGTERM');
    hardStopTimer = setTimeout(forceStopGuardian, guardianStopDeadlineMs);
    hardStopTimer.unref();
  };
  child.stdout.on('data', chunk => {
    onStdout?.(chunk);
    const next = appendOutput(stdout, chunk, outputLimitBytes);
    stdout = next.value; stdoutTruncated ||= next.truncated;
  });
  child.stderr.on('data', chunk => {
    onStderr?.(chunk);
    const next = appendOutput(stderr, chunk, outputLimitBytes);
    stderr = next.value; stderrTruncated ||= next.truncated;
  });
  const receiptStream = child.stdio[3];
  if (!receiptStream) {
    spawnError = 'OWNED_PROCESS_GUARDIAN_RESULT_FD_UNAVAILABLE';
    requestStop('cancelled');
  } else {
    receiptStream.on('data', chunk => {
      receiptBytes += chunk.length;
      if (receiptBytes > receiptLimitBytes) return;
      receiptChunks.push(Buffer.from(chunk));
    });
    receiptStream.on('error', error => { spawnError ??= `OWNED_PROCESS_GUARDIAN_RESULT_FD_FAILED: ${error.message}`; });
  }
  child.on('error', error => { spawnError = error.message; });
  if (stdinData !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdinData); }
  if (child.pid && onSpawn) {
    try { onSpawn(child); }
    catch (error) { ownerError = error.message; requestStop('cancelled'); }
  }
  const onAbort = () => requestStop('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timeout = timeoutMs ? setTimeout(() => requestStop('timeout'), timeoutMs) : undefined;
  let exitDrainTimer, forcedStdioClose = false;
  const closeInfo = await new Promise(resolveClose => {
    const finish = info => {
      if (closed) return;
      closed = true;
      clearTimeout(exitDrainTimer);
      resolveClose(info);
    };
    child.once('exit', (code, closeSignal) => {
      const exitInfo = { code, signal: closeSignal };
      exitDrainTimer = setTimeout(() => {
        if (closed) return;
        forcedStdioClose = true;
        // Descendants can inherit stdout/stderr even after Guardian exit. Give
        // normal EOF a short drain window; then close only our read ends and
        // force an incomplete receipt. Never infer treeStopped from this.
        child.stdin?.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdio[3]?.destroy();
        finish({ ...exitInfo, forcedIncomplete: true });
      }, guardianStdioDrainDeadlineMs);
      exitDrainTimer.unref();
    });
    child.once('close', (code, closeSignal) => finish({ code, signal: closeSignal, forcedIncomplete: forcedStdioClose }));
  });
  clearTimeout(timeout); clearTimeout(hardStopTimer); signal?.removeEventListener('abort', onAbort);
  if (ownerError) return failedResult({ error: `OWNED_PROCESS_GUARDIAN_OWNER_RECEIPT_FAILED: ${ownerError}`,
    reason: terminationReason, timeoutMs, stdout, stderr, stdoutTruncated, stderrTruncated });
  if (spawnError) return failedResult({ error: `OWNED_PROCESS_GUARDIAN_SPAWN_FAILED: ${spawnError}`,
    reason: terminationReason, timeoutMs, stdout, stderr, stdoutTruncated, stderrTruncated });
  if (closeInfo.forcedIncomplete) return failedResult({ error: 'OWNED_PROCESS_GUARDIAN_STDIO_NOT_CLOSED',
    reason: terminationReason ?? 'tree-unproven', timeoutMs, stdout, stderr, stdoutTruncated, stderrTruncated });

  let receipt;
  try { receipt = parseReceipt(receiptChunks, receiptBytes, nonce); }
  catch (error) { return failedResult({ error: error.message, reason: terminationReason, timeoutMs,
    stdout, stderr, stdoutTruncated, stderrTruncated }); }
  const helperClosedNormally = closeInfo.signal === null && closeInfo.code === 0;
  const treeStopped = helperClosedNormally && receipt.treeStopped === true;
  if (!treeStopped) {
    const receiptError = receipt.terminationReason === 'guardian-capability-unavailable'
      ? 'OWNED_PROCESS_GUARDIAN_CAPABILITY_UNAVAILABLE'
      : receipt.terminationReason === 'guardian-child-state-unavailable'
        ? 'OWNED_PROCESS_GUARDIAN_CHILD_STATE_UNAVAILABLE' : 'OWNED_PROCESS_TREE_UNPROVEN';
    return failedResult({ error: receiptError, reason: terminationReason ?? 'tree-unproven',
      timeoutMs, stdout, stderr, stdoutTruncated, stderrTruncated, childExitCode: receipt.childExitCode,
      descendantsObserved: receipt.descendantsObserved });
  }

  const timedOut = terminationReason === 'timeout' || receipt.terminationReason === 'timeout';
  const cancelled = terminationReason === 'cancelled' || receipt.terminationReason === 'cancelled';
  const leakedAfterSuccess = receipt.descendantsObserved && receipt.childExitCode === 0 && !timedOut && !cancelled;
  const spawnFailed = receipt.spawnErrno !== 0 || receipt.terminationReason === 'spawn-error';
  const code = leakedAfterSuccess || (receipt.code === 0 && (timedOut || cancelled || spawnFailed)) ? 1 : receipt.code;
  const outputError = leakedAfterSuccess || receipt.terminationReason === 'descendant-leak'
    ? 'OWNED_TEST_DESCENDANT_LEAKED' : spawnFailed ? 'OWNED_PROCESS_GUARDIAN_SPAWN_ERROR' : undefined;
  const reason = timedOut ? 'timeout' : cancelled ? 'cancelled'
    : receipt.terminationReason;
  if (receipt.spawnErrno) stderr = `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}execvp failed (errno ${receipt.spawnErrno})`;
  return {
    code, childExitCode: receipt.childExitCode, stdout, stderr, stdoutTruncated, stderrTruncated,
    timedOut, cancelled, terminationReason: reason, signal: receipt.signal, timeoutMs,
    ...(outputError ? { outputError } : {}), treeStopped: true, descendantsObserved: receipt.descendantsObserved
  };
}
