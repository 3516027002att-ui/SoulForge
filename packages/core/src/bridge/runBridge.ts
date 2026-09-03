import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  BridgeFileBackedResultDescriptor,
  BridgeResult,
  Diagnostic,
  ResourceKind
} from '@soulforge/shared';
import {
  BridgeDaemonClient,
  BridgeDaemonError
} from './bridgeDaemonClient.js';

export type BridgeCommand = 'inspect' | 'read-dcx-document' | 'write-bnd4' | 'snapshot-bnd4-child' | 'extract-bnd4-child' | 'list-bnd4-entries' | 'inventory-asset-resources' | 'read-fmg-document' | 'write-fmg' | 'read-param-document' | 'write-param' | 'read-gparam-document' | 'write-gparam' | 'read-text-catalog' | 'read-emevd-document' | 'write-emevd' | 'read-msb-document' | 'write-msb' | 'read-tae-document' | 'read-tae-event-params' | 'read-tae-animation-clip' | 'sample-tae-animation-pose' | 'read-bridge-artifact' | 'read-chrbnd-flver-preview' | 'read-map-part-flver-preview' | 'read-map-static-geometry' | 'read-tpf-document' | 'export-tpf-texture' | 'read-tpf-texture-preview' | 'write-tpf-texture-replace' | 'read-flver-document' | 'write-flver' | 'read-flver-mesh' | 'read-flver-skeleton' | 'read-flver-texture-slots' | 'read-flver-dummies' | 'read-esd-document' | 'write-esd-document' | 'write-tae-document' | 'write-fxr-document' | 'read-mtd-document' | 'write-mtd-document' | 'read-fxr-document' | 'list-ffxbnd-entries' | 'read-luabnd-document' | 'inspect-luabnd' | 'read-luabnd-script' | 'write-luabnd-script' | 'export-luabnd' | 'export-event' | 'export-map' | 'export-param' | 'export-msg' | 'validate' | 'probe-oodle' | 'probe-document-locator';

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
const clients = new Map<string, Promise<BridgeDaemonClient>>();

/**
 * Production Bridge entry. Requests are multiplexed over a pooled NDJSON
 * daemon; the legacy one-process-per-command CLI is retained only for explicit
 * fixture scripts and manual diagnostics.
 */
export async function runBridge<T = unknown>(options: RunBridgeOptions): Promise<BridgeResult<T>> {
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
  const writableRoots = uniqueResolvedRoots(options.writableRoots ?? []);
  const maxConcurrency = normalizeMaxConcurrency(options.maxConcurrency);
  const poolKey = JSON.stringify({
    launch,
    workspaceSessionId,
    allowedRoots,
    writableRoots,
    oodleRuntimeRoot: options.oodleRuntimeRoot,
    maxConcurrency
  });

  try {
    const client = await getOrCreateClient(poolKey, {
      executable: launch.executable,
      args: launch.args,
      cwd: options.cwd ?? dirname(bridgeProjectPath),
      workspaceSessionId,
      allowedRoots,
      ...(writableRoots.length ? { writableRoots } : {}),
      ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: resolve(options.oodleRuntimeRoot) } : {}),
      // PARAM/MSB children and FMG tables can exceed 1 MiB when base64-framed.
      // PARAM 全量载荷（includeAllPayloads）可达数 MB~29 MB base64，按需提高。
      maxFrameBytes: options.maxFrameBytes ?? 16 * 1024 * 1024,
      maxConcurrency,
      startupTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    }, launch);
    const payload = await client.request<BridgeResult<T>>({
      payload: {
        command: options.command,
        filePath: resolve(options.filePath),
        ...(options.commandOptions ? { options: options.commandOptions } : {})
      },
      resourceUri: options.resourceUri ?? pathToFileURL(resolve(options.filePath)).toString(),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    });
    if (options.command === 'read-bridge-artifact') return payload.result;
    return materializeFileBackedResult(client, payload.result, options);
  } catch (error) {
    const client = await clients.get(poolKey)?.catch(() => undefined);
    if (!client || client.isClosed) clients.delete(poolKey);
    const bridgeError = error instanceof BridgeDaemonError
      ? error
      : new BridgeDaemonError(
          'BRIDGE_DAEMON_FAILED',
          error instanceof Error ? error.message : String(error),
          true
        );
    return failedBridgeResult<T>(options, bridgeError.code, bridgeError.message, {
      retryable: bridgeError.retryable,
      bridgeProjectPath,
      executable: launch.executable
    });
  }
}

async function materializeFileBackedResult<T>(
  client: BridgeDaemonClient,
  result: BridgeResult<T>,
  options: RunBridgeOptions
): Promise<BridgeResult<T>> {
  const descriptor = readFileBackedDescriptor(result.data);
  if (!descriptor) return result;

  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < descriptor.byteLength) {
    const length = Math.min(descriptor.chunkSize, descriptor.byteLength - offset);
    const payload = await client.request<BridgeResult<{
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
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    });
    const chunkResult = payload.result;
    const chunk = asArtifactChunk(chunkResult.data);
    if (chunkResult.parseStatus === 'failed' || !chunk) {
      return {
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
      } as BridgeResult<T>;
    }
    if (chunk.artifactToken !== descriptor.artifactToken
      || chunk.offset !== offset
      || chunk.totalLength !== descriptor.byteLength) {
      return failedBridgeResult<T>(options, 'BRIDGE_FILE_BACKED_RESULT_SCHEMA_INVALID', 'Bridge file-backed result chunk identity 不匹配。', {
        artifactToken: descriptor.artifactToken,
        expectedOffset: offset,
        actualOffset: chunk.offset,
        expectedLength: descriptor.byteLength,
        actualLength: chunk.totalLength
      });
    }
    const bytes = Buffer.from(chunk.dataBase64, 'base64');
    if (bytes.length !== chunk.length || bytes.length === 0) {
      return failedBridgeResult<T>(options, 'BRIDGE_FILE_BACKED_RESULT_CHUNK_INVALID', 'Bridge file-backed result chunk 长度无效。', {
        artifactToken: descriptor.artifactToken,
        offset,
        expectedLength: chunk.length,
        actualLength: bytes.length
      });
    }
    chunks.push(bytes);
    offset += bytes.length;
  }

  try {
    const restored = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeResult<T>;
    if (!restored || typeof restored !== 'object' || !Array.isArray(restored.diagnostics)) {
      throw new Error('restored BridgeResult envelope is invalid');
    }
    return {
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
    };
  } catch (error) {
    return failedBridgeResult<T>(options, 'BRIDGE_FILE_BACKED_RESULT_JSON_INVALID', 'Bridge file-backed result 不是有效的 BridgeResult JSON。', {
      artifactToken: descriptor.artifactToken,
      byteLength: descriptor.byteLength,
      error: error instanceof Error ? error.message : String(error)
    });
  }
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

async function findCoveringClient(
  launch: { executable: string; args: string[] },
  workspaceSessionId: string,
  allowedRoots: string[],
  writableRoots: string[],
  oodleRuntimeRoot?: string,
  maxFrameBytes?: number,
  maxConcurrency?: number
): Promise<BridgeDaemonClient | undefined> {
  const normAllowed = allowedRoots.map((r) => resolve(r));
  const normWritable = writableRoots.map((r) => resolve(r));
  for (const [key, promise] of clients.entries()) {
    try {
      const client = await promise;
      if (client.isClosed) {
        clients.delete(key);
        continue;
      }
      if (client.options.executable !== launch.executable) continue;
      // Native document sessions are scoped to this opaque workspace session.
      // A client whose roots cover the request is not interchangeable with a
      // client from another session: reusing it can make a valid PARAM session
      // token look expired when the follow-up request lands on the other daemon.
      if (client.options.workspaceSessionId !== workspaceSessionId) continue;
      if (oodleRuntimeRoot && client.options.oodleRuntimeRoot !== resolve(oodleRuntimeRoot)) continue;
      if (maxFrameBytes && (client.options.maxFrameBytes ?? 0) < maxFrameBytes) continue;
      if (maxConcurrency && (client.options.maxConcurrency ?? 1) < maxConcurrency) continue;

      const clientAllowed = client.options.allowedRoots.map((r) => resolve(r));
      const allAllowedCovered = normAllowed.every((root) => isCoveredBy(root, clientAllowed));
      if (!allAllowedCovered) continue;

      const clientWritable = (client.options.writableRoots ?? []).map((r) => resolve(r));
      const allWritableCovered = normWritable.every((root) => isCoveredBy(root, clientWritable));
      if (!allWritableCovered) continue;

      return client;
    } catch {
      clients.delete(key);
    }
  }
  return undefined;
}

function isCoveredBy(target: string, roots: string[]): boolean {
  const normalizedTarget = resolve(target).toLowerCase();
  return roots.some((root) => {
    const normalizedRoot = resolve(root).toLowerCase();
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + (process.platform === 'win32' ? '\\' : '/'));
  });
}

async function getOrCreateClient(
  key: string,
  options: Parameters<typeof BridgeDaemonClient.start>[0],
  launch: { executable: string; args: string[] }
): Promise<BridgeDaemonClient> {
  const covering = await findCoveringClient(
    launch,
    options.workspaceSessionId,
    options.allowedRoots,
    options.writableRoots ?? [],
    options.oodleRuntimeRoot,
    options.maxFrameBytes,
    options.maxConcurrency
  );
  if (covering) return covering;

  const existing = clients.get(key);
  if (existing) {
    const client = await existing;
    if (!client.isClosed) return client;
    clients.delete(key);
  }

  const created = BridgeDaemonClient.start(options);
  clients.set(key, created);
  try {
    return await created;
  } catch (error) {
    clients.delete(key);
    throw error;
  }
}

function resolveBridgeLaunch(
  options: RunBridgeOptions,
  bridgeProjectPath: string
): { executable: string; args: string[] } {
  if (options.bridgeExecutablePath) {
    return { executable: resolve(options.bridgeExecutablePath), args: [] };
  }

  const projectDirectory = dirname(bridgeProjectPath);
  const builtCandidates = [
    join(projectDirectory, 'bin', 'Release', 'net10.0', 'win-x64', 'publish', 'SoulForge.Bridge.exe'),
    join(projectDirectory, 'bin', 'Release', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe'),
    join(projectDirectory, 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe')
  ];
  const built = builtCandidates.find(existsSync);
  if (built) return { executable: built, args: [] };

  return {
    executable: resolveDotnetPath(options.dotnetPath),
    args: ['run', '--project', bridgeProjectPath, '--no-launch-profile', '--']
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
