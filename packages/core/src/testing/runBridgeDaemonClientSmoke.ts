import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

async function main(): Promise<void> {
  const executable = resolve(
    process.argv[2] ?? '../../bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'
  );
  const root = await mkdtemp(join(tmpdir(), 'soulforge-bridge-client-'));
  const eventDirectory = join(root, 'event');
  await mkdir(eventDirectory, { recursive: true });
  const filePath = join(eventDirectory, 'client-smoke.emevd');
  await writeFile(filePath, Buffer.from('EVD\0client-smoke', 'binary'));

  try {
    const progress: unknown[] = [];
    const first = await runBridge({
      bridgeExecutablePath: executable,
      command: 'inspect',
      filePath,
      resourceUri: 'file://event/client-smoke.emevd',
      allowedRoots: [root],
      workspaceSessionId: 'bridge-client-smoke',
      timeoutMs: 10_000,
      onProgress: (payload) => progress.push(payload)
    });
    if (first.parseStatus !== 'partial') {
      throw new Error(`First daemon request failed: ${JSON.stringify(first.diagnostics)}`);
    }

    const second = await runBridge({
      bridgeExecutablePath: executable,
      command: 'validate',
      filePath,
      resourceUri: 'file://event/client-smoke.emevd',
      allowedRoots: [root],
      workspaceSessionId: 'bridge-client-smoke',
      timeoutMs: 10_000
    });
    if (!second.diagnostics.some((item) => item.code === 'VALIDATION_READABLE')) {
      throw new Error(`Second pooled daemon request failed: ${JSON.stringify(second.diagnostics)}`);
    }
    if (progress.length < 2) throw new Error('Bridge client did not receive progress frames.');

    console.log(JSON.stringify({
      ok: true,
      message: 'TypeScript Bridge 常驻客户端验证通过',
      firstStatus: first.parseStatus,
      secondStatus: second.parseStatus,
      progressFrames: progress.length
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
