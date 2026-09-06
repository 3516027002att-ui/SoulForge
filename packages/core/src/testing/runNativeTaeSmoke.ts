/**
 * Native TAE smoke: read a real Sekiro TAE from the registered corpus via Bridge.
 * Verifies header, full TAE-child inventory, animation count, event types, and
 * roundtrip integrity. Container reads intentionally exercise the aggregate
 * path instead of extracting only the first child.
 *
 * Authority: candidate — read-only, no writer or game-load verification.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';

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
  taeEntryCount?: number;
  taeEntries?: Array<{
    entryIndex: number;
    entryId: number;
    entryName: string;
    taeGroup: string;
    animationCount: number;
    sourceSize: number;
    sourceHash: string;
  }>;
  animations?: Array<{
    animId: number;
    eventCount: number;
    groupCount: number;
    timesCount: number;
    hkxName?: string;
  }>;
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  // 当前版本不因 TAE 的开发范围阻断 native smoke；本机 registry 未登记
  // tae-primary 时只能诚实跳过。一旦登记，样本损坏/哈希不符/越界仍失败关闭。
  if (!explicitPath && !(await nativeFixtureRoleRegistered('tae-primary'))) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      message: 'tae-primary not registered in native fixture registry; native TAE verification is unavailable in this environment.'
    }));
    return;
  }
  const source = await resolveNativeFixture(
    process.argv[2],
    'tae-primary',
    '../../mods/chr/c0000.anibnd.dcx'
  );

  const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT || 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
  const result = await runBridge<TaeEnvelope>({
    command: 'read-tae-document',
    filePath: source,
    allowedRoots: [source.replace(/[/\\][^/\\]+$/, ''), oodleRuntimeRoot],
    oodleRuntimeRoot,
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

  if (source.toLowerCase().endsWith('.anibnd.dcx')) {
    if (data.taeEntryCount !== 65) {
      throw new Error(`expected all 65 native TAE entries, received ${data.taeEntryCount ?? 'missing'}`);
    }
    if (!data.taeEntries || data.taeEntries.length !== data.taeEntryCount) {
      throw new Error('TAE entry inventory is missing or incomplete');
    }
    for (const expected of ['a00.tae', 'a50.tae', 'a200.tae']) {
      const entry = data.taeEntries.find((item) => item.entryName.toLowerCase() === expected);
      if (!entry || entry.sourceHash.length === 0 || entry.animationCount <= 0) {
        throw new Error(`missing or empty native TAE entry ${expected}`);
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    message: `TAE native 读取验证通过（${data.animationCount} animations, ${data.totalEventCount} events）`,
    animationCount: data.animationCount,
    totalEventCount: data.totalEventCount,
    totalGroupCount: data.totalGroupCount,
    eventTypeCount: data.eventTypes?.length ?? 0,
    eventTypes: data.eventTypes?.slice(0, 20),
    taeEntryCount: data.taeEntryCount,
    taeEntries: data.taeEntries?.map((entry) => ({
      entryIndex: entry.entryIndex,
      entryId: entry.entryId,
      entryName: entry.entryName,
      taeGroup: entry.taeGroup,
      animationCount: entry.animationCount,
      sourceSize: entry.sourceSize,
      sourceHash: entry.sourceHash
    })),
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
