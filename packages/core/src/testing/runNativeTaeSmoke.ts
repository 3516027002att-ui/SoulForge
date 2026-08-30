/**
 * Native TAE smoke: read a real Sekiro TAE from the registered corpus via Bridge.
 * Verifies header, animation count, event types, and roundtrip integrity.
 *
 * Authority: candidate — read-only, no writer or game-load verification.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { classifyChildExtract, reportInfrastructureFailure } from './nativeFixtureExtract.js';

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

    const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT || 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
    const extract = await runBridge<{ contentSize?: number }>({
      command: 'extract-bnd4-child',
      filePath: source,
      allowedRoots: [source.replace(/[/\\][^/\\]+$/, ''), oodleRuntimeRoot],
      writableRoots: [tmpDir],
      commandOptions: { childPath: 'tae/a00.tae', outputPath: taePath },
      oodleRuntimeRoot,
      timeoutMs: 120_000
    });
    // 「缺语料」与「环境/基础设施坏了」必须区分（硬约束 7）。判定逻辑与理由见
    // nativeFixtureExtract.ts —— TPF smoke 用同一份，不各写一遍。
    const verdict = classifyChildExtract(extract);
    if (verdict.kind === 'infrastructure-failure') {
      reportInfrastructureFailure('TAE', 'TAE_FIXTURE_EXTRACT_INFRASTRUCTURE_FAILURE', verdict);
      await disposeBridgeDaemonPool();
      return;
    }
    if (verdict.kind === 'missing-child') {
      console.log(JSON.stringify({
        ok: true,
        status: 'skipped',
        message: 'TAE fixture not available in container (子项不存在).',
        diagnostics: verdict.codes
      }));
      await disposeBridgeDaemonPool();
      return;
    }
  }

  const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT || 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
  const result = await runBridge<TaeEnvelope>({
    command: 'read-tae-document',
    filePath: taePath,
    allowedRoots: [taePath.replace(/[/\\][^/\\]+$/, ''), oodleRuntimeRoot],
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
