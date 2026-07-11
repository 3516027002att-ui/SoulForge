import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BridgeResult } from '@soulforge/shared';
import { BridgeDaemonClient, BridgeDaemonError } from '../bridge/bridgeDaemonClient.js';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

interface DcxEnvelope {
  sourceHash: string;
  nested?: { entryCount: number; entries: Array<{ name: string; contentHash: string }> };
}

async function main(): Promise<void> {
  const executable = resolve(process.argv[2] ?? '../../bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe');
  const source = resolve(process.argv[3] ?? '../../mods/chr/c0000.anibnd.dcx');
  const writableRoot = await mkdtemp(join(tmpdir(), 'soulforge-native-bnd4-writer-'));
  const sourceRoot = resolve(source, '..');
  const sourceHashBefore = sha256(await readFile(source));
  try {
    const inspected = await runBridge<DcxEnvelope>({
      bridgeExecutablePath: executable, command: 'read-dcx-document', filePath: source,
      allowedRoots: [sourceRoot, writableRoot], writableRoots: [writableRoot],
      workspaceSessionId: 'native-bnd4-writer-smoke', timeoutMs: 60_000
    });
    const envelope = inspected.data;
    if (!envelope?.nested || envelope.nested.entryCount < 1) throw new Error('Real BND4 envelope unavailable.');

    const forbiddenOutput = join(sourceRoot, 'must-not-write.anibnd.dcx');
    const denied = await writeAdd(executable, source, sourceRoot, writableRoot, forbiddenOutput, envelope.sourceHash, 'native-bnd4-writer-denied');
    if (!denied.diagnostics.some((item) => item.code === 'BRIDGE_OUTPUT_OUTSIDE_WRITABLE_ROOTS')) {
      throw new Error(`Bridge did not reject output outside writable roots: ${JSON.stringify(denied.diagnostics)}`);
    }

    const outputPath = join(writableRoot, 'added.anibnd.dcx');
    const written = await writeAdd(executable, source, sourceRoot, writableRoot, outputPath, envelope.sourceHash, 'native-bnd4-writer-smoke');
    if (written.parseStatus === 'failed') throw new Error(`Native BND4 writer failed: ${JSON.stringify(written.diagnostics)}`);
    const reread = await runBridge<DcxEnvelope>({
      bridgeExecutablePath: executable, command: 'read-dcx-document', filePath: outputPath,
      allowedRoots: [sourceRoot, writableRoot], writableRoots: [writableRoot],
      workspaceSessionId: 'native-bnd4-writer-smoke', timeoutMs: 60_000
    });
    if (reread.data?.nested?.entryCount !== envelope.nested.entryCount + 1) throw new Error('Added BND4 entry was not preserved after reread.');
    if (sha256(await readFile(source)) !== sourceHashBefore) throw new Error('Bridge writer mutated source Mod file.');

    await disposeBridgeDaemonPool();
    const crashOutput = join(writableRoot, 'crash.anibnd.dcx');
    const client = await BridgeDaemonClient.start({
      executable, workspaceSessionId: 'native-bnd4-writer-crash',
      allowedRoots: [sourceRoot, writableRoot], writableRoots: [writableRoot], maxConcurrency: 1
    });
    const health = await client.health();
    const pid = Number(health.processId);
    let killed = false;
    let crashError: unknown;
    try {
      await client.request<BridgeResult>({
        payload: { command: 'write-bnd4', filePath: source, options: addOptions(crashOutput, envelope.sourceHash) },
        resourceUri: 'file://chr/c0000.anibnd.dcx', timeoutMs: 60_000,
        onProgress: () => { if (!killed) { killed = true; process.kill(pid); } }
      });
    } catch (error) { crashError = error; }
    if (!(crashError instanceof BridgeDaemonError) || crashError.code !== 'BRIDGE_PROCESS_EXITED') {
      throw new Error(`Writer crash did not fail closed: ${String(crashError)}`);
    }
    if ((await readdir(writableRoot)).some((name) => name === 'crash.anibnd.dcx')) throw new Error('Crashed writer published output.');
    const explicitRetry = await writeAdd(executable, source, sourceRoot, writableRoot, crashOutput, envelope.sourceHash, 'native-bnd4-writer-retry');
    if (explicitRetry.parseStatus === 'failed') throw new Error('Explicit writer retry failed.');
    console.log(JSON.stringify({
      ok: true,
      message: '真实 BND4 Bridge 暂存 writer、重读、崩溃失败关闭与显式重试验证通过',
      originalEntries: envelope.nested.entryCount,
      outputEntries: reread.data.nested.entryCount,
      sourceUnchanged: true,
      outsideWritableRootRejected: true,
      crashError: (crashError as BridgeDaemonError).code,
      autoReplay: false
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(writableRoot, { recursive: true, force: true });
  }
}

function writeAdd(executable: string, source: string, sourceRoot: string, writableRoot: string, outputPath: string, expectedContainerHash: string, workspaceSessionId: string) {
  return runBridge({
    bridgeExecutablePath: executable, command: 'write-bnd4', filePath: source,
    allowedRoots: [sourceRoot, writableRoot], writableRoots: [writableRoot], workspaceSessionId,
    timeoutMs: 60_000, commandOptions: addOptions(outputPath, expectedContainerHash)
  });
}
function addOptions(outputPath: string, expectedContainerHash: string) {
  return {
    outputPath, mutation: 'add', expectedContainerHash,
    id: 2_000_000_000, name: 'N:\\SoulForge\\verification\\added.bin',
    contentBase64: Buffer.from('SoulForge-native-BND4-writer').toString('base64')
  };
}
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
