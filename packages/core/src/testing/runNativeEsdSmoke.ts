/**
 * Native ESD smoke: read a real Sekiro ESD from the registered corpus via Bridge.
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
    'esd-primary',
    '../../mods/script/talk/m11_02_00_00.talkesdbnd.dcx'
  );
  const tmp = join(tmpdir(), 'soulforge-esd-smoke');
  mkdirSync(tmp, { recursive: true });
  const out = join(tmp, 'sample.esd');
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT;

  const ex = await runBridge<{ contentSize?: number }>({
    command: 'extract-bnd4-child',
    filePath: source,
    allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
    writableRoots: [tmp],
    commandOptions: { entryIndex: 0, outputPath: out },
    timeoutMs: 120_000,
    ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
  });
  if (!ex.data?.contentSize) {
    console.log(JSON.stringify({ ok: true, status: 'skipped', message: 'ESD fixture not available.' }));
    await disposeBridgeDaemonPool();
    return;
  }

  const r = await runBridge<Record<string, unknown>>({
    command: 'read-esd-document',
    filePath: out,
    allowedRoots: [tmp],
    timeoutMs: 120_000
  });
  const d = r.data;
  if (r.parseStatus === 'failed' || !d) {
    throw new Error(`ESD read failed: ${JSON.stringify(r.diagnostics)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: `ESD native 读取验证通过（${d.stateGroupCount} groups, ${d.stateCount} states, ${d.conditionCount} conditions）`,
    stateGroupCount: d.stateGroupCount,
    stateCount: d.stateCount,
    conditionCount: d.conditionCount,
    commandCallCount: d.commandCallCount,
    commandBanks: d.commandBanks,
    authority: d.authority,
    roundTrip: r.diagnostics?.map((x: { code: string }) => x.code)
  }, null, 2));
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
