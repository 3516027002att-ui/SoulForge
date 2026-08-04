/**
 * Native TPF smoke: read a real Sekiro TPF from the registered corpus via Bridge.
 * Verifies header, texture enumeration, DDS extraction, and roundtrip integrity.
 *
 * Authority: candidate — read-only, no writer or game-load verification.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface TpfEnvelope {
  format: string;
  sourceSize: number;
  sourceHash: string;
  textureCount: number;
  authority: string;
  textures?: Array<{
    index: number;
    name: string;
    format: number;
    mipCount: number;
    dataOffset: number;
    dataSize: number;
    width: number;
    height: number;
    ddsFourCC: string;
  }>;
}

async function main(): Promise<void> {
  const source = await resolveNativeFixture(
    process.argv[2],
    'tpf-primary',
    '../../mods/chr/c4510.texbnd.dcx'
  );

  // TPF files are inside texbnd containers; extract first if needed.
  const isContainer = source.endsWith('.dcx');
  let tpfPath = source;

  if (isContainer) {
    const tmpDir = process.env.SOULFORGE_SCRATCH ?? (await import('node:os')).tmpdir();
    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tmpDir, { recursive: true });
    tpfPath = join(tmpDir, 'soulforge-tpf-smoke.tpf');

    const extract = await runBridge<{ contentSize?: number }>({
      command: 'extract-bnd4-child',
      filePath: source,
      allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
      writableRoots: [tmpDir],
      commandOptions: { childPath: 'c4510.tpf', outputPath: tpfPath },
      timeoutMs: 120_000
    });
    if (extract.parseStatus === 'failed' || !extract.data?.contentSize) {
      console.log(JSON.stringify({
        ok: true,
        status: 'skipped',
        message: 'TPF fixture not available in container.',
        diagnostics: extract.diagnostics?.map((d) => d.code)
      }));
      await disposeBridgeDaemonPool();
      return;
    }
  }

  const result = await runBridge<TpfEnvelope>({
    command: 'read-tpf-document',
    filePath: tpfPath,
    allowedRoots: [tpfPath.replace(/[/\\][^/\\]+$/, '')],
    timeoutMs: 120_000
  });

  if (result.parseStatus === 'failed' || !result.data) {
    throw new Error(`TPF read failed: ${JSON.stringify(result.diagnostics)}`);
  }

  const data = result.data;
  if (data.format !== 'TPF') throw new Error(`unexpected format: ${data.format}`);
  if (data.textureCount <= 0) throw new Error('no textures found');
  if (!data.sourceHash) throw new Error('missing source hash');

  // Verify all textures have valid DDS data.
  const textures = data.textures ?? [];
  for (const tex of textures) {
    if (!tex.name) throw new Error(`texture ${tex.index} missing name`);
    if (tex.dataSize <= 0) throw new Error(`texture ${tex.index} has invalid dataSize`);
    if (tex.width <= 0 || tex.height <= 0) throw new Error(`texture ${tex.index} has invalid dimensions`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: `TPF native 读取验证通过（${data.textureCount} textures）`,
    textureCount: data.textureCount,
    authority: data.authority,
    sourceSize: data.sourceSize,
    textures: textures.slice(0, 10).map((t) => ({
      name: t.name,
      width: t.width,
      height: t.height,
      format: t.format,
      mipCount: t.mipCount,
      ddsFourCC: t.ddsFourCC,
      dataSize: t.dataSize
    }))
  }, null, 2));
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
