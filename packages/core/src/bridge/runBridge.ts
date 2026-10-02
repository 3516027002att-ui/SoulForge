import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  BridgeFileBackedResultDescriptor,
  BridgeCommandName,
  BridgeResult,
  Diagnostic,
  ResourceKind
} from '@soulforge/shared';
import {
  BridgeDaemonClient,
  BridgeDaemonError,
  type BridgeCancellationTerminalReceipt
} from './bridgeDaemonClient.js';
import {
  BRIDGE_TRANSPORT_TIMING_CODE,
  createBridgeTransportTimingCollector,
  type BridgeTransportTimingCollector
} from './bridgeTransportTiming.js';

export type BridgeCommand = Exclude<BridgeCommandName, 'capabilities' | 'health'>;

export type BridgeRequestPhase = 'command' | 'artifact';

export type RunBridgeCancellationTerminalReceipt = BridgeCancellationTerminalReceipt & {
  requestPhase: BridgeRequestPhase;
};

export interface RunBridgeOptions {
  bridgeProjectPath?: string;
  bridgeExecutablePath?: string;
  dotnetPath?: string;
  command: BridgeCommand;
  filePath: string;
  resourceUri?: string;
  allowedRoots?: string[];
  writableRoots?: string[];
  commandOptions?: Record<string, unknown>;
  oodleRuntimeRoot?: string;
  workspaceSessionId?: string;
  timeoutMs?: number;
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (payload: unknown) => void;
  onCancellationTerminal?: (
    receipt: RunBridgeCancellationTerminalReceipt
  ) => void | Promise<void>;
  /**
   * 守护进程单帧上限（字节）。缺省 16 MiB；PARAM 全量载荷（includeAllPayloads）
   * 可到数 MB~29 MB base64，调用方按需提高（守护进程绝对上限 32 MiB）。
   */
  maxFrameBytes?: number;
  /**
   * 守护进程并发请求数。默认 2；仅对已证明可并行的读取批次提高，避免
   * 把所有 native writer/read 链路一起放大。
   */
  maxConcurrency?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const BRIDGE_PROJECT_RELATIVE_PATH = 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj';
type BridgeClientPool = Map<string, Promise<BridgeDaemonClient>>;
interface BridgeClientLease {
  client: BridgeDaemonClient;
  key: string;
  promise: Promise<BridgeDaemonClient>;
}

const clients: BridgeClientPool = new Map();
const activeClientUses = new WeakMap<BridgeDaemonClient, number>();
interface BridgeClientScopeOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly workspaceSessionId: string;
  readonly allowedRoots: readonly string[];
  readonly writableRoots?: readonly string[];
  readonly oodleRuntimeRoot?: string;
  readonly maxFrameBytes?: number;
  readonly maxConcurrency?: number;
}
// Scope is known before the handshake settles. Keep an immutable snapshot so
// an unrelated startup cannot delay a request that it could never serve.
const startupScopes = new WeakMap<Promise<BridgeDaemonClient>, BridgeClientScopeOptions>();

function withCancellationTerminalPhase(
  observer: RunBridgeOptions['onCancellationTerminal'],
  requestPhase: BridgeRequestPhase
): ((receipt: BridgeCancellationTerminalReceipt) => void | Promise<void>) | undefined {
  if (!observer) return undefined;
  return (receipt) => observer({ ...receipt, requestPhase });
}

export type BridgeRunner = <T = unknown>(options: RunBridgeOptions) => Promise<BridgeResult<T>>;

export interface BridgeDaemonScope {
  run: BridgeRunner;
  dispose: () => Promise<void>;
}

interface DisposableBridgeClient {
  dispose: () => Promise<void>;
}

interface BridgeLaunch {
  executable: string;
  args: string[];
  cwd?: string;
  packaged?: boolean;
}

/**
 * Production Bridge entry. Requests are multiplexed over a pooled NDJSON
 * daemon; the legacy one-process-per-command CLI is retained only for explicit
 * fixture scripts and manual diagnostics.
 */
export async function runBridge<T = unknown>(options: RunBridgeOptions): Promise<BridgeResult<T>> {
  return runBridgeWithPool(options, clients);
}

/**
 * Release idle process-wide native readers before a memory-heavy post-commit
 * semantic refresh. Active requests are leased and never interrupted; a later
 * request can recreate an evicted idle client with the same scoped identity.
 */
export async function disposeIdleBridgeDaemonPool(): Promise<{
  disposedClientCount: number;
  activeClientCount: number;
}> {
  const disposed: Promise<DisposableBridgeClient | undefined>[] = [];
  let activeClientCount = 0;
  for (const [key, promise] of clients) {
    const client = await promise.catch(() => undefined);
    if (!client) {
      if (clients.get(key) === promise) clients.delete(key);
      continue;
    }
    if (clients.get(key) !== promise) continue;
    if ((activeClientUses.get(client) ?? 0) > 0 || !client.isIdle) {
      activeClientCount += 1;
      continue;
    }
    clients.delete(key);
    disposed.push(Promise.resolve(client));
  }
  await disposeBridgeClientPromises(disposed);
  return { disposedClientCount: disposed.length, activeClientCount };
}

/**
 * Create a short-lived Bridge client scope for operations that intentionally
 * add a unique, per-operation root (for example a PARAM unpack directory).
 *
 * The production pool remains process-wide and is not touched by this scope.
 * A scope owns every daemon it starts and drains in-flight requests before
 * disposing them, so callers can safely use it around a complete read flow,
 * including header/row-width retries and file-backed result materialization.
 */
export function createBridgeDaemonScope(): BridgeDaemonScope {
  const scopedClients: BridgeClientPool = new Map();
  let activeRuns = 0;
  let closing = false;
  let drainResolve: (() => void) | undefined;
  let disposePromise: Promise<void> | undefined;

  const run: BridgeRunner = async <T>(options: RunBridgeOptions): Promise<BridgeResult<T>> => {
    if (closing) {
      return failedBridgeResult<T>(options, 'BRIDGE_SCOPE_CLOSED', 'Bridge scope 已关闭，不能继续发起请求。');
    }
    activeRuns += 1;
    try {
      return await runBridgeWithPool<T>(options, scopedClients);
    } finally {
      activeRuns -= 1;
      if (closing && activeRuns === 0) drainResolve?.();
    }
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    closing = true;
    disposePromise = (async () => {
      if (activeRuns > 0) {
        await new Promise<void>((resolveDrain) => {
          drainResolve = resolveDrain;
        });
      }
      const active = [...scopedClients.values()];
      scopedClients.clear();
      await disposeBridgeClientPromises(active);
    })();
    return disposePromise;
  };

  return { run, dispose };
}

/**
 * Drain every client promise before reporting cleanup failure.  A rejected
 * dispose must not make callers tear down their temporary workspace while a
 * sibling daemon is still closing; all results are observed and failures are
 * rethrown after every client has settled.
 */
export async function disposeBridgeClientPromises(
  active: Iterable<Promise<DisposableBridgeClient | undefined>>
): Promise<void> {
  const settled = await Promise.allSettled([...active].map(async (promise) => {
    const client = await promise.catch(() => undefined);
    if (client) await client.dispose();
  }));
  const failures = settled
    .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    .map((item) => item.reason);
  if (failures.length === 0) return;
  if (failures.length === 1) {
    const failure = failures[0];
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  throw new AggregateError(failures, 'One or more Bridge daemon clients failed to dispose.');
}

async function runBridgeWithPool<T = unknown>(
  options: RunBridgeOptions,
  clientPool: BridgeClientPool
): Promise<BridgeResult<T>> {
  const transportTiming = options.commandOptions?.diagnosticTimings === true
    ? createBridgeTransportTimingCollector()
    : null;
  const bridgeProjectPath = resolveBridgeProjectPath(options.bridgeProjectPath, options.cwd);
  const allowedRoots = uniqueResolvedRoots([
    ...(options.allowedRoots?.length ? options.allowedRoots : [dirname(options.filePath)]),
    ...(options.oodleRuntimeRoot ? [options.oodleRuntimeRoot] : []),
    ...(options.writableRoots ?? [])
  ])
    .map((root) => resolve(root));
  const workspaceSessionId = options.workspaceSessionId
    ?? stableSessionId(allowedRoots);
  const launch = resolveBridgeLaunch(options, bridgeProjectPath);
  if (launch.packaged && !existsSync(launch.executable)) {
    const missing = failedBridgeResult<T>(
      options,
      'BRIDGE_PACKAGED_EXECUTABLE_MISSING',
      `打包运行时缺少 ${launch.executable}，拒绝回退到源码项目或 dotnet run。`,
      { executable: launch.executable }
    );
    return withTransportTiming(missing, transportTiming, 'failed');
  }
  const writableRoots = uniqueResolvedRoots(options.writableRoots ?? []);
  const maxConcurrency = normalizeMaxConcurrency(options.maxConcurrency);
  const maxFrameBytes = options.maxFrameBytes ?? 16 * 1024 * 1024;
  const poolKey = JSON.stringify({
    launch,
    workspaceSessionId,
    allowedRoots,
    writableRoots,
    oodleRuntimeRoot: options.oodleRuntimeRoot,
    maxFrameBytes,
    maxConcurrency
  });

  let leasedClient: BridgeDaemonClient | undefined;
  let acquiredLease: BridgeClientLease | undefined;
  try {
    const poolScope = transportTiming?.begin('poolAcquireMs') ?? null;
    const lease = await getOrCreateClient(poolKey, {
      executable: launch.executable,
      args: launch.args,
      cwd: options.cwd ?? launch.cwd ?? dirname(bridgeProjectPath),
      workspaceSessionId,
      allowedRoots,
      ...(writableRoots.length ? { writableRoots } : {}),
      ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: resolve(options.oodleRuntimeRoot) } : {}),
      // PARAM/MSB children and FMG tables can exceed 1 MiB when base64-framed.
      // PARAM 全量载荷（includeAllPayloads）可达数 MB~29 MB base64，按需提高。
      maxFrameBytes,
      maxConcurrency,
      startupTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    }, launch, clientPool);
    acquiredLease = lease;
    const client = lease.client;
    leasedClient = client;
    transportTiming?.end(poolScope);
    const daemonScope = transportTiming?.begin('daemonRequestMs') ?? null;
    const commandCancellationTerminal = withCancellationTerminalPhase(
      options.onCancellationTerminal,
      options.command === 'read-bridge-artifact' ? 'artifact' : 'command'
    );
    const payload = await client.request<BridgeResult<T>>({
      payload: {
        command: options.command,
        filePath: resolve(options.filePath),
        ...(options.commandOptions ? { options: options.commandOptions } : {})
      },
      resourceUri: options.resourceUri ?? pathToFileURL(resolve(options.filePath)).toString(),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(commandCancellationTerminal ? { onCancellationTerminal: commandCancellationTerminal } : {})
    });
    transportTiming?.end(daemonScope);
    if (options.command === 'read-bridge-artifact') {
      return withTransportTiming(
        payload.result,
        transportTiming,
        payload.result.parseStatus === 'failed' ? 'failed' : 'ok'
      );
    }
    // Keep this as a promise return (rather than `await`) so a rejected or
    // cancelled file-backed child request preserves the established caller
    // semantics. Materialization itself attaches the diagnostic on all
    // structured success/failure results.
    const materialized = materializeFileBackedResult(client, payload.result, options, transportTiming);
    leasedClient = undefined;
    return materialized.finally(() => releaseBridgeClientUse(client));
  } catch (error) {
    // Startup failures clean up their own promise in getOrCreateClient. A
    // newer startup under the same key is independent of this failure: never
    // await or remove it while reporting the original error.
    if (acquiredLease?.client.isClosed
      && clientPool.get(acquiredLease.key) === acquiredLease.promise) {
      clientPool.delete(acquiredLease.key);
    }
    const bridgeError = error instanceof BridgeDaemonError
      ? error
      : new BridgeDaemonError(
          'BRIDGE_DAEMON_FAILED',
          error instanceof Error ? error.message : String(error),
          true
        );
    const failed = failedBridgeResult<T>(options, bridgeError.code, bridgeError.message, {
      retryable: bridgeError.retryable,
      bridgeProjectPath,
      executable: launch.executable
    });
    return withTransportTiming(
      failed,
      transportTiming,
      bridgeError.code === 'BRIDGE_REQUEST_CANCELLED' ? 'cancelled' : 'failed'
    );
  } finally {
    if (leasedClient) releaseBridgeClientUse(leasedClient);
  }
}

async function materializeFileBackedResult<T>(
  client: BridgeDaemonClient,
  result: BridgeResult<T>,
  options: RunBridgeOptions,
  transportTiming: BridgeTransportTimingCollector | null
): Promise<BridgeResult<T>> {
  const descriptor = readFileBackedDescriptor(result.data);
  if (!descriptor) {
    return withTransportTiming(
      result,
      transportTiming,
      result.parseStatus === 'failed' ? 'failed' : 'ok'
    );
  }

  transportTiming?.markArtifactExpected();
  const materializeScope = transportTiming?.begin('materializeTotalMs') ?? null;

  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < descriptor.byteLength) {
    const length = Math.min(descriptor.chunkSize, descriptor.byteLength - offset);
    const artifactScope = transportTiming?.begin('artifactRequestMs') ?? null;
    let payload: {
      result: BridgeResult<{
        artifactToken: string;
        offset: number;
        length: number;
        totalLength: number;
        complete: boolean;
        dataBase64: string;
      }>;
    };
    const artifactCancellationTerminal = withCancellationTerminalPhase(
      options.onCancellationTerminal,
      'artifact'
    );
    try {
      payload = await client.request<BridgeResult<{
        artifactToken: string;
        offset: number;
        length: number;
        totalLength: number;
        complete: boolean;
        dataBase64: string;
      }>>({
        payload: {
          command: 'read-bridge-artifact',
          filePath: resolve(options.filePath),
          options: {
            artifactToken: descriptor.artifactToken,
            offset,
            length
          }
        },
        resourceUri: options.resourceUri ?? pathToFileURL(resolve(options.filePath)).toString(),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(artifactCancellationTerminal ? { onCancellationTerminal: artifactCancellationTerminal } : {})
      });
    } catch (error) {
      // Do not catch/convert this rejection: callers rely on the existing
      // BridgeDaemonError cancellation/timeout behavior.
      void error;
      throw error;
    }
    transportTiming?.end(artifactScope);
    transportTiming?.recordArtifactRequest();
    const chunkResult = payload.result;
    const chunk = asArtifactChunk(chunkResult.data);
    if (chunkResult.parseStatus === 'failed' || !chunk) {
      return withTransportTiming({
        ...chunkResult,
        diagnostics: [
          ...chunkResult.diagnostics,
          {
            severity: 'error',
            code: 'BRIDGE_FILE_BACKED_RESULT_READ_FAILED',
            message: 'Bridge file-backed result chunk 无法读取或协议不完整。',
            sourceUri: options.resourceUri
          }
        ]
      } as BridgeResult<T>, transportTiming, 'failed');
    }
    if (chunk.artifactToken !== descriptor.artifactToken
      || chunk.offset !== offset
      || chunk.totalLength !== descriptor.byteLength) {
      return withTransportTiming(failedBridgeResult<T>(options, 'BRIDGE_FILE_BACKED_RESULT_SCHEMA_INVALID', 'Bridge file-backed result chunk identity 不匹配。', {
        artifactToken: descriptor.artifactToken,
        expectedOffset: offset,
        actualOffset: chunk.offset,
        expectedLength: descriptor.byteLength,
        actualLength: chunk.totalLength
      }), transportTiming, 'failed');
    }
    const decodeScope = transportTiming?.begin('base64DecodeMs') ?? null;
    const bytes = Buffer.from(chunk.dataBase64, 'base64');
    transportTiming?.end(decodeScope);
    if (bytes.length !== chunk.length || bytes.length === 0) {
      return withTransportTiming(failedBridgeResult<T>(options, 'BRIDGE_FILE_BACKED_RESULT_CHUNK_INVALID', 'Bridge file-backed result chunk 长度无效。', {
        artifactToken: descriptor.artifactToken,
        offset,
        expectedLength: chunk.length,
        actualLength: bytes.length
      }), transportTiming, 'failed');
    }
    chunks.push(bytes);
    offset += bytes.length;
  }

  const concatJsonParseScope = transportTiming?.begin('concatJsonParseMs') ?? null;
  try {
    const restored = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeResult<T>;
    if (!restored || typeof restored !== 'object' || !Array.isArray(restored.diagnostics)) {
      throw new Error('restored BridgeResult envelope is invalid');
    }
    transportTiming?.end(concatJsonParseScope);
    transportTiming?.end(materializeScope);
    return withTransportTiming({
      ...restored,
      diagnostics: [
        ...restored.diagnostics,
        // The daemon must keep the transport evidence that caused the
        // fallback.  The artifact intentionally contains the pre-fallback
        // result so materialization cannot recurse; merge the diagnostic from
        // the small descriptor envelope back into the restored result here.
        ...result.diagnostics.filter((diagnostic) => diagnostic.code === 'BRIDGE_RESULT_FILE_BACKED'),
        {
          severity: 'info',
          code: 'BRIDGE_FILE_BACKED_RESULT_MATERIALIZED',
          message: 'Bridge 大结果已通过 daemon-owned file-backed artifact 分块还原。',
          sourceUri: restored.sourceUri,
          details: {
            artifactToken: descriptor.artifactToken,
            byteLength: descriptor.byteLength,
            chunkSize: descriptor.chunkSize,
            payloadFormat: descriptor.payloadFormat,
            payloadVersion: descriptor.payloadVersion
          }
        }
      ]
    }, transportTiming, 'ok');
  } catch (error) {
    return withTransportTiming(failedBridgeResult<T>(options, 'BRIDGE_FILE_BACKED_RESULT_JSON_INVALID', 'Bridge file-backed result 不是有效的 BridgeResult JSON。', {
      artifactToken: descriptor.artifactToken,
      byteLength: descriptor.byteLength,
      error: error instanceof Error ? error.message : String(error)
    }), transportTiming, 'failed');
  }
}

function withTransportTiming<T>(
  result: BridgeResult<T>,
  collector: BridgeTransportTimingCollector | null,
  outcome: 'ok' | 'failed' | 'cancelled'
): BridgeResult<T> {
  if (!collector) return result;
  return {
    ...result,
    diagnostics: [
      ...result.diagnostics,
      {
        severity: 'info',
        code: BRIDGE_TRANSPORT_TIMING_CODE,
        message: 'Bridge client transport and file-backed materialization timing.',
        details: collector.finish(outcome)
      }
    ]
  };
}

function readFileBackedDescriptor(value: unknown): BridgeFileBackedResultDescriptor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as { fileBacked?: unknown }).fileBacked;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const item = candidate as Partial<BridgeFileBackedResultDescriptor>;
  const byteLength: unknown = item.byteLength;
  const chunkSize: unknown = item.chunkSize;
  if (typeof item.artifactToken !== 'string' || item.artifactToken.length < 16
    || item.payloadFormat !== 'bridge-result-json' || item.payloadVersion !== 1
    || !isPositiveSafeInteger(byteLength)
    || !isPositiveSafeInteger(chunkSize)) return undefined;
  return { ...item, byteLength, chunkSize } as BridgeFileBackedResultDescriptor;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function asArtifactChunk(value: unknown): {
  artifactToken: string;
  offset: number;
  length: number;
  totalLength: number;
  complete: boolean;
  dataBase64: string;
} | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.artifactToken !== 'string' || !Number.isSafeInteger(item.offset)
    || !Number.isSafeInteger(item.length) || !Number.isSafeInteger(item.totalLength)
    || typeof item.complete !== 'boolean' || typeof item.dataBase64 !== 'string') return undefined;
  return item as {
    artifactToken: string;
    offset: number;
    length: number;
    totalLength: number;
    complete: boolean;
    dataBase64: string;
  };
}

export async function disposeBridgeDaemonPool(): Promise<void> {
  const active = [...clients.values()];
  clients.clear();
  await Promise.all(active.map(async (promise) => {
    const client = await promise.catch(() => undefined);
    if (client) await client.dispose();
  }));
}

function retainBridgeClientUse(client: BridgeDaemonClient): void {
  activeClientUses.set(client, (activeClientUses.get(client) ?? 0) + 1);
}

function releaseBridgeClientUse(client: BridgeDaemonClient): void {
  const active = activeClientUses.get(client) ?? 0;
  if (active <= 1) activeClientUses.delete(client);
  else activeClientUses.set(client, active - 1);
}

async function findCoveringClient(
  clientPool: BridgeClientPool,
  launch: { executable: string; args: string[] },
  workspaceSessionId: string,
  allowedRoots: string[],
  writableRoots: string[],
  oodleRuntimeRoot?: string,
  maxFrameBytes?: number,
  maxConcurrency?: number
): Promise<BridgeClientLease | undefined> {
  for (const [key, promise] of clientPool.entries()) {
    const startupScope = startupScopes.get(promise);
    if (startupScope && !canServeBridgeRequest(startupScope, launch, workspaceSessionId,
      allowedRoots, writableRoots, oodleRuntimeRoot, maxFrameBytes, maxConcurrency)) continue;
    try {
      const client = await promise;
      if (clientPool.get(key) !== promise) continue;
      if (client.isClosed) {
        clientPool.delete(key);
        continue;
      }
      if (!canServeBridgeRequest(client.options, launch, workspaceSessionId,
        allowedRoots, writableRoots, oodleRuntimeRoot, maxFrameBytes, maxConcurrency)) continue;

      retainBridgeClientUse(client);
      return { client, key, promise };
    } catch (error) {
      const current = clientPool.get(key);
      if (current !== undefined && current !== promise) continue;
      if (current === promise) clientPool.delete(key);
      // A matching startup is the caller's startup too. Its own failure may
      // already have removed the entry; still report it without a hidden retry.
      if (startupScope) throw error;
    }
  }
  return undefined;
}

function canServeBridgeRequest(
  scope: BridgeClientScopeOptions,
  launch: { executable: string; args?: readonly string[] },
  workspaceSessionId: string,
  allowedRoots: readonly string[],
  writableRoots: readonly string[],
  oodleRuntimeRoot?: string,
  maxFrameBytes?: number,
  maxConcurrency?: number
): boolean {
  if (scope.executable !== launch.executable || scope.workspaceSessionId !== workspaceSessionId) return false;
  const launchArgs = launch.args ?? [];
  const scopeArgs = scope.args ?? [];
  if (scopeArgs.length !== launchArgs.length || scopeArgs.some((arg, index) => arg !== launchArgs[index])) return false;
  if (oodleRuntimeRoot && scope.oodleRuntimeRoot !== resolve(oodleRuntimeRoot)) return false;
  if (maxFrameBytes && (scope.maxFrameBytes ?? 0) < maxFrameBytes) return false;
  if (maxConcurrency && (scope.maxConcurrency ?? 1) < maxConcurrency) return false;
  const clientAllowed = scope.allowedRoots.map(root => resolve(root));
  if (!allowedRoots.every(root => isCoveredBy(resolve(root), clientAllowed))) return false;
  const clientWritable = (scope.writableRoots ?? []).map(root => resolve(root));
  return writableRoots.every(root => isCoveredBy(resolve(root), clientWritable));
}

function isCoveredBy(target: string, roots: string[]): boolean {
  const windows = process.platform === 'win32';
  const normalizedTarget = windows ? resolve(target).toLowerCase() : resolve(target);
  return roots.some((root) => {
    const normalizedRoot = windows ? resolve(root).toLowerCase() : resolve(root);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + (process.platform === 'win32' ? '\\' : '/'));
  });
}

async function getOrCreateClient(
  key: string,
  options: Parameters<typeof BridgeDaemonClient.start>[0],
  launch: { executable: string; args: string[] },
  clientPool: BridgeClientPool
): Promise<BridgeClientLease> {
  const covering = await findCoveringClient(
    clientPool,
    launch,
    options.workspaceSessionId,
    options.allowedRoots,
    options.writableRoots ?? [],
    options.oodleRuntimeRoot,
    options.maxFrameBytes,
    options.maxConcurrency
  );
  if (covering) return covering;

  const existing = clientPool.get(key);
  if (existing) {
    const client = await existing;
    if (!client.isClosed && clientPool.get(key) === existing) {
      retainBridgeClientUse(client);
      return { client, key, promise: existing };
    }
    if (clientPool.get(key) === existing) clientPool.delete(key);
    return getOrCreateClient(key, options, launch, clientPool);
  }

  const startupScope = Object.freeze({
    executable: options.executable,
    args: Object.freeze([...(options.args ?? [])]),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    workspaceSessionId: options.workspaceSessionId,
    allowedRoots: Object.freeze([...options.allowedRoots]),
    ...(options.writableRoots ? { writableRoots: Object.freeze([...options.writableRoots]) } : {}),
    ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
    ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {})
  });
  const created = BridgeDaemonClient.start(options);
  startupScopes.set(created, startupScope);
  clientPool.set(key, created);
  try {
    const client = await created;
    if (clientPool.get(key) !== created || client.isClosed) {
      if (clientPool.get(key) === created) clientPool.delete(key);
      return getOrCreateClient(key, options, launch, clientPool);
    }
    retainBridgeClientUse(client);
    return { client, key, promise: created };
  } catch (error) {
    if (clientPool.get(key) === created) clientPool.delete(key);
    throw error;
  }
}

function resolveBridgeLaunch(
  options: RunBridgeOptions,
  bridgeProjectPath: string
): BridgeLaunch {
  if (options.bridgeExecutablePath) {
    return { executable: resolve(options.bridgeExecutablePath), args: [] };
  }
  // Linux x64 uses its native apphost in both packaged and source builds.
  // Never select a neighboring Windows binary from a mixed build directory.
  const linuxX64 = process.platform === 'linux' && process.arch === 'x64';
  const runtimeIdentifier = linuxX64 ? 'linux-x64' : 'win-x64';
  const executableName = linuxX64 ? 'SoulForge.Bridge' : 'SoulForge.Bridge.exe';

  // A packaged Electron build has no repository checkout or dotnet project.
  // electron-builder places the self-contained Bridge under resources/bridge;
  // prefer that executable before falling back to the normal source/build
  // discovery used by development and native smoke scripts.
  const electronProcess = process as NodeJS.Process & {
    defaultApp?: boolean;
    resourcesPath?: string;
  };
  const packagedResourceRoot = electronProcess.resourcesPath;
  if (packagedResourceRoot && electronProcess.defaultApp !== true) {
    const packaged = resolve(packagedResourceRoot, 'bridge', executableName);
    return {
      executable: packaged,
      args: [],
      cwd: dirname(packaged),
      packaged: true
    };
  }

  const projectDirectory = dirname(bridgeProjectPath);
  const builtCandidates = [
    join(projectDirectory, 'bin', 'Release', 'net10.0', runtimeIdentifier, 'publish', executableName),
    join(projectDirectory, 'bin', 'Release', 'net10.0', runtimeIdentifier, executableName),
    join(projectDirectory, 'bin', 'Debug', 'net10.0', runtimeIdentifier, executableName)
  ];
  const built = builtCandidates.find(existsSync);
  if (built) return { executable: built, args: [] };

  return {
    executable: resolveDotnetPath(options.dotnetPath),
    args: [
      'run', '--project', bridgeProjectPath, '--no-launch-profile',
      ...(linuxX64 ? [
        // Build explicitly before daemon startup: compiler/restore logs are
        // not NDJSON frames, so source fallback must never start a build.
        '--no-build', '--no-restore',
        '--runtime', runtimeIdentifier,
        '-p:SelfContained=false', '-p:PublishSingleFile=false'
      ] : []),
      '--'
    ]
  };
}

function resolveDotnetPath(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.SOULFORGE_DOTNET,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'SoulForge', 'dotnet', 'dotnet.exe')
      : undefined
  ].filter((value): value is string => Boolean(value));
  return candidates.find(existsSync) ?? 'dotnet';
}

function resolveBridgeProjectPath(explicitPath?: string, cwd?: string): string {
  if (explicitPath) return resolve(explicitPath);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const startDirectories = [cwd, process.cwd(), moduleDir].filter((value): value is string => Boolean(value));
  for (const startDirectory of startDirectories) {
    const found = findBridgeProjectPathUp(startDirectory);
    if (found) return found;
  }
  return resolve(process.cwd(), BRIDGE_PROJECT_RELATIVE_PATH);
}

function findBridgeProjectPathUp(startDirectory: string): string | null {
  let current = resolve(startDirectory);
  while (true) {
    const candidate = resolve(current, BRIDGE_PROJECT_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function stableSessionId(allowedRoots: string[]): string {
  return `bridge-${createHash('sha256').update(allowedRoots.join('\n')).digest('hex').slice(0, 24)}`;
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return 2;
  return Math.max(1, Math.min(8, value));
}

function uniqueResolvedRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots.map((value) => resolve(value))) {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(root);
  }
  return result;
}

function failedBridgeResult<T>(
  options: RunBridgeOptions,
  code: string,
  message: string,
  details?: unknown
): BridgeResult<T> {
  const sourceUri = options.resourceUri ?? pathToFileURL(resolve(options.filePath)).toString();
  const diagnostic: Diagnostic = {
    severity: 'error',
    code,
    message,
    sourceUri,
    ...(details === undefined ? {} : { details })
  };
  return {
    sourceUri,
    sourcePath: options.filePath,
    game: 'unknown',
    resourceKind: commandToResourceKind(options.command),
    parseStatus: 'failed',
    diagnostics: [diagnostic]
  };
}

function commandToResourceKind(command: BridgeCommand): ResourceKind {
  switch (command) {
    case 'export-event': return 'event';
    case 'export-map': return 'map';
    case 'export-param': return 'param';
    case 'export-msg': return 'msg';
    case 'probe-oodle': return 'unknown';
    case 'read-dcx-document': return 'unknown';
    case 'write-bnd4': return 'unknown';
    case 'snapshot-bnd4-child': return 'unknown';
    case 'read-fmg-document': return 'msg';
    case 'read-text-catalog': return 'msg';
    case 'write-fmg': return 'msg';
    case 'read-param-document': return 'param';
    case 'write-param': return 'param';
    case 'read-gparam-document':
    case 'write-gparam': return 'param';
    case 'read-emevd-document': return 'event';
    case 'write-emevd': return 'event';
    case 'read-msb-document': return 'map';
    case 'write-msb': return 'map';
    case 'read-tae-event-params': return 'action';
    case 'read-bridge-artifact': return 'unknown';
    case 'read-chrbnd-flver-preview': return 'chr';
    case 'read-map-part-flver-preview': return 'map';
    case 'list-ffxbnd-entries': return 'sfx';
    case 'write-flver': return 'chr';
    default: return 'unknown';
  }
}
