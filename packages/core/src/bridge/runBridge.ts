import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BridgeResult, Diagnostic, ResourceKind } from '@soulforge/shared';
import {
  BridgeDaemonClient,
  BridgeDaemonError
} from './bridgeDaemonClient.js';

export type BridgeCommand = 'inspect' | 'read-dcx-document' | 'write-bnd4' | 'snapshot-bnd4-child' | 'extract-bnd4-child' | 'read-fmg-document' | 'write-fmg' | 'read-param-document' | 'write-param' | 'read-emevd-document' | 'write-emevd' | 'read-msb-document' | 'write-msb' | 'export-event' | 'export-map' | 'export-param' | 'export-msg' | 'validate' | 'probe-oodle';

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
  const poolKey = JSON.stringify({ launch, workspaceSessionId, allowedRoots, writableRoots, oodleRuntimeRoot: options.oodleRuntimeRoot });

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
      maxFrameBytes: 16 * 1024 * 1024,
      maxConcurrency: 2,
      startupTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });
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
    return payload.result;
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

export async function disposeBridgeDaemonPool(): Promise<void> {
  const active = [...clients.values()];
  clients.clear();
  await Promise.all(active.map(async (promise) => {
    const client = await promise.catch(() => undefined);
    if (client) await client.dispose();
  }));
}

async function getOrCreateClient(
  key: string,
  options: Parameters<typeof BridgeDaemonClient.start>[0]
): Promise<BridgeDaemonClient> {
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
    case 'extract-bnd4-child': return 'unknown';
    case 'read-fmg-document': return 'msg';
    case 'write-fmg': return 'msg';
    case 'read-param-document': return 'param';
    case 'write-param': return 'param';
    case 'read-emevd-document': return 'event';
    case 'write-emevd': return 'event';
    case 'read-msb-document': return 'map';
    case 'write-msb': return 'map';
    default: return 'unknown';
  }
}
