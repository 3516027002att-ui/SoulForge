import { spawn, type ChildProcess } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  Me3DetectionGatewayResult,
  Me3LaunchRequest,
  Me3LaunchResult,
  Me3ProfileCreateRequest,
  Me3ProfileCreateResult,
  Me3RuntimeGateway,
  Me3SpawnFailure,
  Me3TerminateRequest,
  Me3TerminateResult,
  Me3VersionProbeProcessResult,
  Me3VersionProbeRequest
} from '@soulforge/core';

const ME3_VERSION = '0.12.1';
const ME3_EXECUTABLE_NAME = process.platform === 'win32' ? 'me3.exe' : 'me3';
const OUTPUT_LIMIT_BYTES = 1_024;

export interface MainMe3RuntimeGatewayOptions {
  /** SoulForge-owned local data root. Renderer input must never select this path. */
  localDataRoot: string;
}

/**
 * Electron-main implementation of the privileged me3 detection port.
 *
 * Discovery is deliberately limited to the pinned SoulForge-owned tool slot.
 * It never searches a renderer-provided path and never returns a path-bearing
 * value to core or the renderer.
 */
export class MainMe3RuntimeGateway implements Me3RuntimeGateway {
  private readonly localDataRoot: string;
  private launchedProcess: ChildProcess | null = null;
  private launchedPid: number | null = null;
  /** Pids this gateway has launched and not yet confirmed terminated. */
  private readonly knownLaunchPids = new Set<number>();

  constructor(options: MainMe3RuntimeGatewayOptions) {
    if (!isAbsolute(options.localDataRoot)) throw new Error('ME3_LOCAL_DATA_ROOT_NOT_ABSOLUTE');
    this.localDataRoot = resolve(options.localDataRoot);
  }

  async probeVersion(request: Me3VersionProbeRequest): Promise<Me3DetectionGatewayResult> {
    if (request.operation !== 'version-probe') throw new Error('ME3_OPERATION_UNSUPPORTED');
    const candidate = await this.resolvePinnedCandidate();
    if (candidate.status === 'not-found') {
      return { status: 'not-found', checkedSources: ['well-known'] };
    }
    if (candidate.status === 'not-executable') {
      return {
        status: 'probed',
        discoverySource: 'well-known',
        process: failedProbe(candidate.reason)
      };
    }

    return {
      status: 'probed',
      discoverySource: 'well-known',
      process: await runVersionProbe(candidate.executablePath, request)
    };
  }

  async createProfile(request: Me3ProfileCreateRequest): Promise<Me3ProfileCreateResult> {
    if (request.operation !== 'profile-create') throw new Error('ME3_OPERATION_UNSUPPORTED');
    const candidate = await this.resolvePinnedCandidate();
    if (candidate.status === 'not-found') {
      return { exitCode: 1, stdout: '', stderr: 'me3 not found', timedOut: false, cancelled: false, spawnFailure: 'process-unavailable' };
    }
    if (candidate.status === 'not-executable') {
      return { exitCode: 1, stdout: '', stderr: 'me3 not executable', timedOut: false, cancelled: false, spawnFailure: candidate.reason };
    }
    return runProfileCreate(candidate.executablePath, request);
  }

  async launchGame(request: Me3LaunchRequest): Promise<Me3LaunchResult> {
    if (request.operation !== 'launch') throw new Error('ME3_OPERATION_UNSUPPORTED');
    const candidate = await this.resolvePinnedCandidate();
    if (candidate.status === 'not-found') {
      return { exitCode: null, stdout: '', stderr: 'me3 not found', timedOut: false, cancelled: false, spawnFailure: 'process-unavailable' };
    }
    if (candidate.status === 'not-executable') {
      return { exitCode: null, stdout: '', stderr: 'me3 not executable', timedOut: false, cancelled: false, spawnFailure: candidate.reason };
    }
    return this.runLaunch(candidate.executablePath, request);
  }

  async terminateProcess(request: Me3TerminateRequest): Promise<Me3TerminateResult> {
    if (request.operation !== 'terminate') throw new Error('ME3_OPERATION_UNSUPPORTED');
    const pid = request.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return { terminated: false };
    // The pid must be one this gateway launched. The known set is cleared when
    // the launcher closes; a live launcher is the tree root that taskkill /T /F
    // must terminate, and the session smoke is the final authority for game
    // process (sekiro.exe) disappearance.
    if (this.launchedPid !== pid && !this.knownLaunchPids.has(pid)) {
      return { terminated: false };
    }
    try {
      const confirmed = await terminateTreeAndConfirm(pid, request.timeoutMs);
      if (!confirmed) return { terminated: false };
      if (this.launchedPid === pid) this.launchedProcess = null;
      this.launchedPid = null;
      this.knownLaunchPids.delete(pid);
      return { terminated: true };
    } catch {
      return { terminated: false };
    }
  }

  private runLaunch(executablePath: string, request: Me3LaunchRequest): Me3LaunchResult {
    if (request.signal?.aborted) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true, spawnFailure: null };
    }

    const args = ['launch', '-g', request.game, '-p', request.profileName];
    if (request.diagnostics) args.push('-d');
    // Main-process-only launch augmentation. The pinned Sekiro game root lets a
    // non-Steam install be targeted via `-e`; the suspend flag keeps an automated
    // session from running the renderer. Neither value is ever returned to core
    // or the renderer — argv stays inside the privileged gateway.
    const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
    if (gameRoot && isAbsolute(gameRoot)) {
      args.push('-e', join(gameRoot, 'sekiro.exe'));
    }
    if (process.env.SOULFORGE_ME3_SEKIRO_SUSPEND === '1') {
      args.push('--suspend');
    }

    let child: ChildProcess;
    try {
      child = spawn(executablePath, args, {
        cwd: dirname(executablePath),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: minimalRuntimeEnvironment()
      });
    } catch (error) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false, spawnFailure: classifySpawnFailure(error) };
    }

    const pid = child.pid ?? null;
    this.launchedProcess = child;
    this.launchedPid = pid;
    if (pid !== null) this.knownLaunchPids.add(pid);

    // Capture initial output but don't wait for exit — this is a long-running process
    let stdout = '';
    let stderr = '';
    const OUTPUT_LIMIT = 4096;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      if (stdout.length < OUTPUT_LIMIT) stdout = (stdout + text).slice(0, OUTPUT_LIMIT);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      if (stderr.length < OUTPUT_LIMIT) stderr = (stderr + text).slice(0, OUTPUT_LIMIT);
    });
    child.once('close', () => {
      if (this.launchedProcess === child) {
        this.launchedProcess = null;
        this.launchedPid = null;
      }
      if (child.pid !== undefined) this.knownLaunchPids.delete(child.pid);
    });

    // Return immediately with the PID — don't wait for the game to exit
    return { exitCode: null, stdout, stderr, timedOut: false, cancelled: false, spawnFailure: null, ...(pid !== null ? { pid } : {}) };
  }

  private async resolvePinnedCandidate(): Promise<
    | { status: 'ready'; executablePath: string }
    | { status: 'not-found' }
    | { status: 'not-executable'; reason: Me3SpawnFailure }
  > {
    const me3Root = join(this.localDataRoot, 'tools', 'me3');
    const pinnedPath = join(me3Root, `v${ME3_VERSION}`, 'bin', ME3_EXECUTABLE_NAME);
    try {
      const [realRoot, realCandidate] = await Promise.all([
        realpath(me3Root),
        realpath(pinnedPath)
      ]);
      const relativePath = relative(realRoot, realCandidate);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)
        || basename(realCandidate).toLowerCase() !== ME3_EXECUTABLE_NAME.toLowerCase()) {
        return { status: 'not-executable', reason: 'not-executable' };
      }
      const candidateStat = await stat(realCandidate);
      if (!candidateStat.isFile()) return { status: 'not-executable', reason: 'not-executable' };
      return { status: 'ready', executablePath: realCandidate };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'not-found' };
      if (code === 'EACCES' || code === 'EPERM') {
        return { status: 'not-executable', reason: 'permission-denied' };
      }
      return { status: 'not-executable', reason: 'unknown' };
    }
  }
}

async function runVersionProbe(
  executablePath: string,
  request: Me3VersionProbeRequest
): Promise<Me3VersionProbeProcessResult> {
  if (request.signal?.aborted) return cancelledProbe();

  return await new Promise((resolveProbe) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrObserved = false;
    let stderrBytes = 0;
    let stderrTruncated = false;
    let child: ReturnType<typeof spawn> | undefined;

    const settle = (result: Me3VersionProbeProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolveProbe(result);
    };
    const current = (
      exitCode: number | null,
      flags: Pick<Me3VersionProbeProcessResult, 'timedOut' | 'cancelled' | 'spawnFailure'>
    ): Me3VersionProbeProcessResult => ({
      exitCode,
      stdout: stdout.toString('utf8'),
      stdoutTruncated,
      stderrObserved,
      stderrTruncated,
      ...flags
    });
    const stop = (): void => {
      try { child?.kill(); } catch { /* best effort after a bounded version probe */ }
    };
    const onAbort = (): void => {
      stop();
      settle(current(null, { timedOut: false, cancelled: true, spawnFailure: null }));
    };
    const timer = setTimeout(() => {
      stop();
      settle(current(null, { timedOut: true, cancelled: false, spawnFailure: null }));
    }, request.timeoutMs);

    try {
      child = spawn(executablePath, ['--version'], {
        cwd: dirname(executablePath),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: minimalRuntimeEnvironment()
      });
    } catch (error) {
      settle(failedProbe(classifySpawnFailure(error)));
      return;
    }

    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = OUTPUT_LIMIT_BYTES - stdout.length;
      if (bytes.length > remaining) stdoutTruncated = true;
      if (remaining > 0) stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (length > 0) stderrObserved = true;
      stderrBytes += length;
      if (stderrBytes > OUTPUT_LIMIT_BYTES) stderrTruncated = true;
    });
    child.once('error', (error) => {
      settle(failedProbe(classifySpawnFailure(error)));
    });
    child.once('close', (code) => {
      settle(current(code, { timedOut: false, cancelled: false, spawnFailure: null }));
    });
  });
}

function minimalRuntimeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR'] as const) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function failedProbe(reason: Me3SpawnFailure): Me3VersionProbeProcessResult {
  return {
    exitCode: null,
    stdout: '',
    stdoutTruncated: false,
    stderrObserved: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    spawnFailure: reason
  };
}

function cancelledProbe(): Me3VersionProbeProcessResult {
  return {
    ...failedProbe('unknown'),
    cancelled: true,
    spawnFailure: null
  };
}

function classifySpawnFailure(error: unknown): Me3SpawnFailure {
  const code = errorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'process-unavailable';
  if (code === 'ENOEXEC') return 'not-executable';
  return 'unknown';
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Terminate the launched process tree and confirm the root pid is gone.
 *
 * On Windows this awaits `taskkill /pid <pid> /T /F` instead of firing and
 * forgetting, then polls until the pid no longer appears in the process table.
 * A taskkill exit code of 128 (no such process) is treated as success because
 * the tree is already gone. On other platforms a SIGTERM is sent and the same
 * pid disappearance is polled.
 *
 * Returns true only when the pid is confirmed gone within the deadline.
 */
async function terminateTreeAndConfirm(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(Math.min(timeoutMs, 15_000), 2_000);
  if (process.platform === 'win32') {
    const exitCode = await runTaskkill(pid);
    if (exitCode === null) return false;
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // pid already gone
    }
  }
  while (Date.now() < deadline) {
    if (!(await processWithPidExists(pid))) return true;
    await sleep(500);
  }
  return false;
}

function runTaskkill(pid: number): Promise<number | null> {
  return new Promise((resolveKill) => {
    const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.once('error', () => resolveKill(null));
    child.once('close', (code) => resolveKill(code));
  });
}

function processWithPidExists(pid: number): Promise<boolean> {
  return new Promise((resolveExists) => {
    const child = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      if (stdout.length < 4096) stdout = (stdout + text).slice(0, 4096);
    });
    child.once('error', () => resolveExists(false));
    child.once('close', (code) => resolveExists(code === 0 && stdout.includes(String(pid))));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const PROFILE_OUTPUT_LIMIT_BYTES = 4096;

async function runProfileCreate(
  executablePath: string,
  request: Me3ProfileCreateRequest
): Promise<Me3ProfileCreateResult> {
  if (request.signal?.aborted) {
    return { exitCode: 1, stdout: '', stderr: '', timedOut: false, cancelled: true, spawnFailure: null };
  }

  const args = ['profile', 'create', request.profileName, '-g', request.game, '--overwrite'];
  for (const packagePath of request.packagePaths) {
    args.push('--package', packagePath);
  }

  return await new Promise((resolveResult) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let child: ReturnType<typeof spawn> | undefined;

    const settle = (result: Me3ProfileCreateResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolveResult(result);
    };
    const current = (
      exitCode: number,
      flags: Pick<Me3ProfileCreateResult, 'timedOut' | 'cancelled' | 'spawnFailure'>
    ): Me3ProfileCreateResult => ({
      exitCode,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      ...flags
    });
    const stop = (): void => {
      try { child?.kill(); } catch { /* best effort */ }
    };
    const onAbort = (): void => {
      stop();
      settle(current(1, { timedOut: false, cancelled: true, spawnFailure: null }));
    };
    const timer = setTimeout(() => {
      stop();
      settle(current(1, { timedOut: true, cancelled: false, spawnFailure: null }));
    }, request.timeoutMs);

    try {
      child = spawn(executablePath, args, {
        cwd: dirname(executablePath),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: minimalRuntimeEnvironment()
      });
    } catch (error) {
      settle({ exitCode: 1, stdout: '', stderr: '', timedOut: false, cancelled: false, spawnFailure: classifySpawnFailure(error) });
      return;
    }

    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = PROFILE_OUTPUT_LIMIT_BYTES - stdout.length;
      if (remaining > 0) stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = PROFILE_OUTPUT_LIMIT_BYTES - stderr.length;
      if (remaining > 0) stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
    });
    child.once('error', (error) => {
      settle({ exitCode: 1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut: false, cancelled: false, spawnFailure: classifySpawnFailure(error) });
    });
    child.once('close', (code) => {
      settle(current(code ?? 1, { timedOut: false, cancelled: false, spawnFailure: null }));
    });
  });
}
