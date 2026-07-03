import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import type { BridgeResult, Diagnostic, ResourceKind } from '@soulforge/shared';

export type BridgeCommand = 'inspect' | 'export-event' | 'export-map' | 'export-param' | 'export-msg';

export interface RunBridgeOptions {
  bridgeProjectPath?: string;
  command: BridgeCommand;
  filePath: string;
  timeoutMs?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function runBridge<T = unknown>(options: RunBridgeOptions): Promise<BridgeResult<T>> {
  const bridgeProjectPath = options.bridgeProjectPath ?? resolve(process.cwd(), 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj');
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
      resolveResult(failedBridgeResult<T>(options, 'BRIDGE_TIMEOUT', `Bridge command timed out after ${timeoutMs}ms.`, { stderr }));
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
      resolveResult(failedBridgeResult<T>(options, 'BRIDGE_SPAWN_FAILED', error.message, { stderr }));
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
