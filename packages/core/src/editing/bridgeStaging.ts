import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const MAX_STAGING_SEGMENT_LENGTH = 200;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export interface BridgeStagingDiagnostic {
  severity: 'error';
  code: string;
  message: string;
  details: {
    phase: 'prepare' | 'write' | 'read' | 'cleanup';
    errorName?: string;
    systemCode?: string;
  };
}

export type BridgeStagingResult<T> =
  | { ok: true; result: T; bytes: Buffer; diagnostics: [] }
  | { ok: false; result?: T; diagnostics: BridgeStagingDiagnostic[] };

export async function stageBridgeOutput<T extends { ok: boolean }>(input: {
  stagingRoot: string;
  prefix: string;
  fileName: string;
  allowedRoots: (stagingRoot: string) => string[];
  write: (context: {
    outputPath: string;
    allowedRoots: string[];
    writableRoots: string[];
  }) => Promise<T>;
}): Promise<BridgeStagingResult<T>> {
  if (!isSafeStagingSegment(input.prefix) || !isSafeStagingSegment(input.fileName)) {
    return failure(
      'BRIDGE_STAGING_PATH_INVALID',
      'prepare',
      new TypeError('Bridge staging names must be bounded safe path segments.')
    );
  }

  let stagingDirectory: string;
  try {
    await mkdir(input.stagingRoot, { recursive: true });
    stagingDirectory = await mkdtemp(join(input.stagingRoot, `${input.prefix}-`));
  } catch (error) {
    return failure('BRIDGE_STAGING_PREPARE_FAILED', 'prepare', error);
  }

  const outputPath = resolve(stagingDirectory, input.fileName);
  const outputRelativePath = relative(stagingDirectory, outputPath);
  if (!outputRelativePath || outputRelativePath !== input.fileName || isAbsolute(outputRelativePath)) {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      return failure('BRIDGE_STAGING_CLEANUP_FAILED', 'cleanup', error);
    }
    return failure(
      'BRIDGE_STAGING_PATH_INVALID',
      'prepare',
      new TypeError('Bridge staging output escaped its request directory.')
    );
  }
  let outcome: BridgeStagingResult<T>;
  try {
    const result = await input.write({
      outputPath,
      allowedRoots: input.allowedRoots(input.stagingRoot),
      writableRoots: [input.stagingRoot]
    });
    if (!result.ok) {
      outcome = { ok: false, result, diagnostics: [] };
    } else {
      try {
        outcome = { ok: true, result, bytes: await readFile(outputPath), diagnostics: [] };
      } catch (error) {
        outcome = { ...failure('BRIDGE_STAGING_OUTPUT_READ_FAILED', 'read', error), result };
      }
    }
  } catch (error) {
    outcome = failure('BRIDGE_STAGING_WRITE_FAILED', 'write', error);
  }

  try {
    await rm(stagingDirectory, { recursive: true, force: true });
  } catch (error) {
    return failure('BRIDGE_STAGING_CLEANUP_FAILED', 'cleanup', error);
  }
  return outcome;
}

function isSafeStagingSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_STAGING_SEGMENT_LENGTH
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && !isAbsolute(value)
    && !/[\\/]/u.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/[<>:"|?*]/u.test(value)
    && !value.endsWith('.')
    && !WINDOWS_DEVICE_NAME.test(value);
}

function failure(
  code: string,
  phase: BridgeStagingDiagnostic['details']['phase'],
  error: unknown
): { ok: false; diagnostics: BridgeStagingDiagnostic[] } {
  const systemCode = error && typeof error === 'object'
    && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  return {
    ok: false,
    diagnostics: [{
      severity: 'error',
      code,
      message: `Bridge 暂存 ${phase} 阶段失败。`,
      details: {
        phase,
        ...(error instanceof Error ? { errorName: error.name } : {}),
        ...(systemCode ? { systemCode } : {})
      }
    }]
  };
}
