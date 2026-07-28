import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stageBridgeOutput } from '../editing/bridgeStaging.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-bridge-staging-'));
  try {
    const ok = await stageBridgeOutput({
      stagingRoot: join(root, 'ok'),
      prefix: 'fmg',
      fileName: 'output.bin',
      allowedRoots: (stagingRoot) => [stagingRoot],
      write: async ({ outputPath }) => {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, 'verified-output');
        return { ok: true, diagnostics: [] };
      }
    });
    if (!ok.ok || ok.bytes.toString() !== 'verified-output') {
      throw new Error(`success path failed: ${JSON.stringify(ok)}`);
    }

    const writeFailure = await stageBridgeOutput({
      stagingRoot: join(root, 'write-failure'),
      prefix: 'param',
      fileName: 'output.bin',
      allowedRoots: (stagingRoot) => [stagingRoot],
      write: async () => { throw new Error('injected bridge failure'); }
    });
    assertCode(writeFailure, 'BRIDGE_STAGING_WRITE_FAILED', root);

    const missingOutput = await stageBridgeOutput({
      stagingRoot: join(root, 'missing-output'),
      prefix: 'emevd',
      fileName: 'output.bin',
      allowedRoots: (stagingRoot) => [stagingRoot],
      write: async () => ({ ok: true, diagnostics: [] })
    });
    assertCode(missingOutput, 'BRIDGE_STAGING_OUTPUT_READ_FAILED', root);

    const blockedRoot = join(root, 'not-a-directory');
    await writeFile(blockedRoot, 'blocked');
    const prepareFailure = await stageBridgeOutput({
      stagingRoot: blockedRoot,
      prefix: 'msb',
      fileName: 'output.bin',
      allowedRoots: (stagingRoot) => [stagingRoot],
      write: async () => ({ ok: true, diagnostics: [] })
    });
    assertCode(prepareFailure, 'BRIDGE_STAGING_PREPARE_FAILED', root);

    let unsafeWriteCalls = 0;
    const unsafeSegments = [
      { label: 'parent-file-name', prefix: 'safe', fileName: '../escaped.bin' },
      { label: 'parent-prefix', prefix: '../escaped', fileName: 'output.bin' },
      { label: 'forward-separator', prefix: 'safe', fileName: 'nested/output.bin' },
      { label: 'back-separator', prefix: 'safe', fileName: 'nested\\output.bin' },
      { label: 'absolute-path', prefix: 'safe', fileName: join(root, 'absolute.bin') },
      { label: 'drive-relative', prefix: 'safe', fileName: 'C:relative.bin' },
      { label: 'empty', prefix: 'safe', fileName: '' },
      { label: 'dot', prefix: 'safe', fileName: '.' },
      { label: 'parent-segment', prefix: 'safe', fileName: '..' },
      { label: 'control', prefix: 'safe', fileName: 'bad\u0000name.bin' },
      { label: 'device-name', prefix: 'safe', fileName: 'CON.bin' }
    ];
    for (const [index, item] of unsafeSegments.entries()) {
      const before = (await readdir(root)).sort();
      const unsafe = await stageBridgeOutput({
        stagingRoot: join(root, `unsafe-${index}`),
        prefix: item.prefix,
        fileName: item.fileName,
        allowedRoots: (stagingRoot) => [stagingRoot],
        write: async () => {
          unsafeWriteCalls += 1;
          return { ok: true, diagnostics: [] };
        }
      });
      assertCode(unsafe, 'BRIDGE_STAGING_PATH_INVALID', root);
      const after = (await readdir(root)).sort();
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(`${item.label} left staging artifacts: ${JSON.stringify({ before, after })}`);
      }
    }
    if (unsafeWriteCalls !== 0) {
      throw new Error(`Unsafe staging names invoked write ${unsafeWriteCalls} times.`);
    }

    for (const name of ['ok', 'write-failure', 'missing-output']) {
      const entries = await readDirectorySafe(join(root, name));
      if (entries.length !== 0) throw new Error(`${name} request staging directory leaked.`);
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'Bridge staging success/write/read/prepare diagnostics passed',
      cases: [
        'success',
        'write-failure',
        'missing-output',
        'prepare-failure',
        'unsafe-path-segments'
      ],
      unsafePathCases: unsafeSegments.length
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertCode(
  result: Awaited<ReturnType<typeof stageBridgeOutput>>,
  code: string,
  forbiddenAbsoluteRoot: string
): void {
  if (result.ok || !result.diagnostics.some((item) => item.code === code)) {
    throw new Error(`Expected ${code}, got ${JSON.stringify(result)}`);
  }
  if (JSON.stringify(result.diagnostics).includes(forbiddenAbsoluteRoot)) {
    throw new Error(`${code} leaked the absolute staging root.`);
  }
}

async function readDirectorySafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
