import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BridgeDaemonClient, BridgeDaemonError } from '../bridge/bridgeDaemonClient.js';

async function main(): Promise<void> {
  const executable = resolve(
    process.argv[2] ?? '../../bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'
  );
  const root = await mkdtemp(join(tmpdir(), 'soulforge-bridge-crash-'));
  const eventDirectory = join(root, 'event');
  const filePath = join(eventDirectory, 'crash-smoke.emevd');
  await mkdir(eventDirectory, { recursive: true });
  await writeFile(filePath, Buffer.from('EVD\0bridge-crash-smoke', 'binary'));

  let crashedClient: BridgeDaemonClient | undefined;
  let replacementClient: BridgeDaemonClient | undefined;
  try {
    crashedClient = await startClient(executable, root, 'bridge-crash-smoke');
    const health = await crashedClient.health();
    const processId = health.processId;
    if (typeof processId !== 'number' || !Number.isInteger(processId)) {
      throw new Error(`Bridge health did not return a valid process id: ${JSON.stringify(health)}`);
    }

    let progressFrames = 0;
    let killed = false;
    const interrupted = crashedClient.request({
      payload: { command: 'inspect', filePath },
      resourceUri: 'file://event/crash-smoke.emevd',
      timeoutMs: 10_000,
      onProgress: () => {
        progressFrames += 1;
        if (killed) return;
        killed = true;
        process.kill(processId);
      }
    });

    let crashError: unknown;
    try {
      await interrupted;
    } catch (error) {
      crashError = error;
    }
    if (!(crashError instanceof BridgeDaemonError) || crashError.code !== 'BRIDGE_PROCESS_EXITED') {
      throw new Error(`In-flight request did not fail closed after Bridge crash: ${String(crashError)}`);
    }
    if (!crashedClient.isClosed) throw new Error('Crashed Bridge client remained reusable.');
    if (!killed || progressFrames < 1) throw new Error('Crash was not injected into an active request.');

    // A replacement process is created only after an explicit caller request. The interrupted
    // request is never retained or replayed by BridgeDaemonClient.
    replacementClient = await startClient(executable, root, 'bridge-crash-smoke');
    const replacementHealth = await replacementClient.health();
    if (replacementHealth.processId === processId) {
      throw new Error('Replacement Bridge did not start as a new process.');
    }
    const explicitRetry = await replacementClient.request<{ parseStatus: string }>({
      payload: { command: 'inspect', filePath },
      resourceUri: 'file://event/crash-smoke.emevd',
      timeoutMs: 10_000
    });
    if (explicitRetry.result.parseStatus !== 'partial') {
      throw new Error(`Replacement Bridge request failed: ${JSON.stringify(explicitRetry)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'Bridge 崩溃失败关闭、重新握手与不自动重放验证通过',
      interruptedError: crashError.code,
      originalProcessId: processId,
      replacementProcessId: replacementHealth.processId,
      progressFramesBeforeCrash: progressFrames
    }, null, 2));
  } finally {
    await replacementClient?.dispose();
    await crashedClient?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function startClient(executable: string, allowedRoot: string, workspaceSessionId: string) {
  return BridgeDaemonClient.start({
    executable,
    workspaceSessionId,
    allowedRoots: [allowedRoot],
    maxFrameBytes: 256 * 1024,
    maxConcurrency: 1,
    startupTimeoutMs: 10_000
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
