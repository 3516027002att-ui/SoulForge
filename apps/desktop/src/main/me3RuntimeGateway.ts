import { spawn } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  Me3DetectionGatewayResult,
  Me3RuntimeGateway,
  Me3SpawnFailure,
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
