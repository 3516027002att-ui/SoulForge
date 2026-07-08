import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeResult, Diagnostic, ResourceKind } from '@soulforge/shared';

export type BridgeCommand = 'inspect' | 'export-event' | 'export-map' | 'export-param' | 'export-msg' | 'validate';

export interface RunBridgeOptions {
  bridgeProjectPath?: string;
  command: BridgeCommand;
  filePath: string;
  timeoutMs?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const BRIDGE_PROJECT_RELATIVE_PATH = 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj';

export async function runBridge<T = unknown>(options: RunBridgeOptions): Promise<BridgeResult<T>> {
  const bridgeProjectPath = resolveBridgeProjectPath(options.bridgeProjectPath, options.cwd);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolveResult) => {
    const child = spawn(
      'dotnet',
      ['run', '--project', bridgeProjectPath, '--', options.command, options.filePath],
      {
        cwd: options.cwd ?? dirname(bridgeProjectPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolveResult(failedBridgeResult<T>(options, 'BRIDGE_TIMEOUT', `Bridge command timed out after ${timeoutMs}ms.`, { stderr, bridgeProjectPath }));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(failedBridgeResult<T>(options, 'BRIDGE_SPAWN_FAILED', error.message, { stderr, bridgeProjectPath }));
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const parsed = parseBridgeJson<T>(stdout, options, stderr);
      resolveResult(parsed);
    });
  });
}

function resolveBridgeProjectPath(explicitPath?: string, cwd?: string): string {
  if (explicitPath) return explicitPath;

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

function parseBridgeJson<T>(stdout: string, options: RunBridgeOptions, stderr: string): BridgeResult<T> {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return failedBridgeResult<T>(options, 'BRIDGE_EMPTY_OUTPUT', 'Bridge returned no JSON output.', { stderr });
  }

  try {
    const value = JSON.parse(trimmed) as BridgeResult<T>;
    const diagnostics: Diagnostic[] = Array.isArray(value.diagnostics) ? value.diagnostics : [];

    if (stderr.trim().length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'BRIDGE_STDERR',
        message: 'Bridge wrote diagnostic text to stderr.',
        sourceUri: value.sourceUri,
        details: { stderr }
      });
    }

    return {
      ...value,
      diagnostics
    };
  } catch (error) {
    return failedBridgeResult<T>(options, 'BRIDGE_INVALID_JSON', 'Bridge output was not valid JSON.', {
      error: error instanceof Error ? error.message : String(error),
      stdout: trimmed.slice(0, 4000),
      stderr
    });
  }
}

function failedBridgeResult<T>(options: RunBridgeOptions, code: string, message: string, details?: unknown): BridgeResult<T> {
  return {
    sourceUri: `file://${encodeURI(options.filePath)}`,
    sourcePath: options.filePath,
    game: 'unknown',
    resourceKind: commandToResourceKind(options.command),
    parseStatus: 'failed',
    diagnostics: [
      {
        severity: 'error',
        code,
        message,
        sourceUri: `file://${encodeURI(options.filePath)}`,
        ...(details === undefined ? {} : { details })
      }
    ]
  };
}

function commandToResourceKind(command: BridgeCommand): ResourceKind {
  switch (command) {
    case 'export-event':
      return 'event';
    case 'export-map':
      return 'map';
    case 'export-param':
      return 'param';
    case 'export-msg':
      return 'msg';
    default:
      return 'unknown';
  }
}
