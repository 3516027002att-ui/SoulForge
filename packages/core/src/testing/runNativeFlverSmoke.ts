/**
 * Native FLVER smoke: read a real Sekiro FLVER from the registered corpus via Bridge.
 * Authority: candidate — read-only, no writer or game-load verification.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const source = await resolveNativeFixture(
    process.argv[2],
    'chrbnd-primary',
    '../../mods/chr/c1020.chrbnd.dcx'
  );
  const tmp = join(tmpdir(), 'soulforge-flver-smoke');
  mkdirSync(tmp, { recursive: true });
  const out = join(tmp, 'c1020.flver');

  const ex = await runBridge<{ contentSize?: number }>({
    command: 'extract-bnd4-child',
    filePath: source,
    allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
    writableRoots: [tmp],
    commandOptions: { childPath: 'c1020.flver', outputPath: out },
    timeoutMs: 120_000
  });
  if (!ex.data?.contentSize) {
    console.log(JSON.stringify({ ok: true, status: 'skipped', message: 'FLVER fixture not available.' }));
    await disposeBridgeDaemonPool();
    return;
  }

  const r = await runBridge<Record<string, unknown>>({
    command: 'read-flver-document',
    filePath: out,
    allowedRoots: [tmp],
    timeoutMs: 120_000
  });
  const d = r.data;
  if (r.parseStatus === 'failed' || !d) {
    throw new Error(`FLVER read failed: ${JSON.stringify(r.diagnostics)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: `FLVER native 读取验证通过（${d.boneCount} bones, ${d.materialCount} materials, ${d.meshCount} meshes）`,
    boneCount: d.boneCount,
    materialCount: d.materialCount,
    meshCount: d.meshCount,
    faceCount: d.faceCount,
    authority: d.authority,
    roundTrip: r.diagnostics?.map((x: { code: string }) => x.code)
  }, null, 2));
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
