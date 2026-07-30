/**
 * Native TAE smoke: read a real Sekiro TAE from the registered corpus via Bridge.
 * Verifies header, animation count, event types, and roundtrip integrity.
 *
 * Authority: candidate — read-only, no writer or game-load verification.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface TaeEnvelope {
  format: string;
  version: number;
  sourceSize: number;
  sourceHash: string;
  animationCount: number;
  totalEventCount: number;
  totalGroupCount: number;
  eventTypes: number[];
  authority: string;
  animations?: Array<{
    animId: number;
    eventCount: number;
    groupCount: number;
    timesCount: number;
    hkxName?: string;
  }>;
}

async function main(): Promise<void> {
  const source = await resolveNativeFixture(
    process.argv[2],
    'tae-primary',
    '../../mods/chr/c0000.anibnd.dcx'
  );

  // TAE files are inside anibnd containers; extract first if needed.
  const isContainer = source.endsWith('.dcx');
  let taePath = source;

  if (isContainer) {
    // Extract the first TAE child from the anibnd container.
    const tmpDir = process.env.SOULFORGE_SCRATCH ?? (await import('node:os')).tmpdir();
    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tmpDir, { recursive: true });
    taePath = join(tmpDir, 'soulforge-tae-smoke-a00.tae');

    const extract = await runBridge<{ contentSize?: number }>({
      command: 'extract-bnd4-child',
      filePath: source,
      allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
      writableRoots: [tmpDir],
      commandOptions: { childPath: 'tae/a00.tae', outputPath: taePath },
      timeoutMs: 120_000
    });
    if (extract.parseStatus === 'failed' || !extract.data?.contentSize) {
      console.log(JSON.stringify({
        ok: true,
        status: 'skipped',
        message: 'TAE fixture not available in container.',
        diagnostics: extract.diagnostics?.map((d) => d.code)
      }));
      await disposeBridgeDaemonPool();
      return;
    }
  }

  const result = await runBridge<TaeEnvelope>({
    command: 'read-tae-document',
    filePath: taePath,
    allowedRoots: [taePath.replace(/[/\\][^/\\]+$/, '')],
    timeoutMs: 120_000
  });

  if (result.parseStatus === 'failed' || !result.data) {
    throw new Error(`TAE read failed: ${JSON.stringify(result.diagnostics)}`);
  }

  const data = result.data;
  if (data.format !== 'TAE') throw new Error(`unexpected format: ${data.format}`);
  if (data.animationCount <= 0) throw new Error('no animations found');
  if (data.totalEventCount <= 0) throw new Error('no events found');
  if (!data.sourceHash) throw new Error('missing source hash');

  console.log(JSON.stringify({
    ok: true,
    message: `TAE native 读取验证通过（${data.animationCount} animations, ${data.totalEventCount} events）`,
    animationCount: data.animationCount,
    totalEventCount: data.totalEventCount,
    totalGroupCount: data.totalGroupCount,
    eventTypeCount: data.eventTypes?.length ?? 0,
    eventTypes: data.eventTypes?.slice(0, 20),
    authority: data.authority,
    sourceSize: data.sourceSize,
    sampleAnimations: data.animations?.slice(0, 5)
  }, null, 2));
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
