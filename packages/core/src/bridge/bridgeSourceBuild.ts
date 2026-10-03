import { spawn } from 'node:child_process';
import { BridgeDaemonError } from './bridgeDaemonClient.js';

interface SourceBuildOptions {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (value: unknown) => void;
}
interface SharedBuild {
  controller: AbortController;
  promise: Promise<void>;
  users: number;
}
const builds = new Map<string, SharedBuild>();

/** Source compilation owns a separate process and never feeds daemon NDJSON. */
export async function prepareBridgeSourceBuild(options: SourceBuildOptions): Promise<void> {
  if (options.signal?.aborted) throw cancelledBuild();
  const key = JSON.stringify([options.executable, options.args, options.cwd]);
  let entry = builds.get(key);
  if (entry?.controller.signal.aborted) {
    await entry.promise.catch(() => undefined);
    return prepareBridgeSourceBuild(options);
  }
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: 0, promise: executeBuild(options, controller) };
    const current = entry;
    builds.set(key, current);
    void current.promise.finally(() => {
      if (builds.get(key) === current) builds.delete(key);
    }).catch(() => undefined);
  }
  entry.users += 1;
  let rejectCancellation: ((error: Error) => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const onAbort = () => rejectCancellation?.(cancelledBuild());
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    options.onProgress?.({ phase: 'bridge-source-build', status: 'started' });
    await Promise.race([entry.promise, cancellation]);
    options.onProgress?.({ phase: 'bridge-source-build', status: 'completed' });
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    entry.users -= 1;
    if (entry.users === 0) {
      entry.controller.abort();
      // The last owner waits for the compiler tree to stop before returning.
      await entry.promise.catch(() => undefined);
    }
  }
}

function cancelledBuild(): BridgeDaemonError {
  return new BridgeDaemonError('BRIDGE_REQUEST_CANCELLED', 'Bridge source build cancelled.');
}

function executeBuild(options: SourceBuildOptions, controller: AbortController): Promise<void> {
  const signal = controller.signal;
  return new Promise((resolveBuild, rejectBuild) => {
    const grouped = process.platform === 'linux';
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd, windowsHide: true, detached: grouped, stdio: ['ignore', 'pipe', 'pipe']
    });
    let tail = '';
    let failure: BridgeDaemonError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let termination: Promise<void> | undefined;
    const remember = (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-8_192); };
    child.stdout.on('data', remember);
    child.stderr.on('data', remember);
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(kind);
      }
    };
    const stop = (error: BridgeDaemonError) => {
      if (failure) return;
      failure = error;
      controller.abort();
      kill('SIGTERM');
      termination = new Promise(resolveTermination => {
        killTimer = setTimeout(() => { kill('SIGKILL'); resolveTermination(); }, 1_000);
      });
    };
    const onAbort = () => stop(cancelledBuild());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timeoutMs = Math.min(900_000, Math.max(1, options.timeoutMs ?? 120_000));
    const timer = setTimeout(() => stop(new BridgeDaemonError(
      'BRIDGE_SOURCE_BUILD_TIMEOUT', `Bridge source build exceeded ${timeoutMs} ms.`
    )), timeoutMs);
    child.on('error', error => {
      failure ??= new BridgeDaemonError('BRIDGE_SOURCE_BUILD_FAILED', `Bridge source build could not start: ${error.message}`);
    });
    child.on('close', async code => {
      clearTimeout(timer);
      // Descendants may close their stdio independently of the parent. Keep
      // the group kill armed until termination, even after the parent exits.
      await termination;
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      if (failure) rejectBuild(failure);
      else if (code !== 0) rejectBuild(new BridgeDaemonError(
        'BRIDGE_SOURCE_BUILD_FAILED', `Bridge source build exited ${code}: ${tail}`
      ));
      else resolveBuild();
    });
  });
}
