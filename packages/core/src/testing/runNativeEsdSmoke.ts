/**
 * Native ESD smoke: read a real Sekiro ESD from the registered corpus via Bridge.
 * Authority: candidate — read-only, no writer or game-load verification.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  // ESD 已延期 V0.6，本机 registry 未登记 esd-primary 是合法状态，应诚实跳过。
  // 原先直接调 resolveNativeFixture，角色缺失时抛 NATIVE_FIXTURE_ROLE_MISSING，
  // 使下方 status:'skipped' 分支永远不可达，把「本版不验证的延期能力」报成失败。
  // 注意这里只放行「未登记」；一旦登记，样本损坏/哈希不符/越界仍失败关闭。
  if (!explicitPath && !(await nativeFixtureRoleRegistered('esd-primary'))) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      message: 'esd-primary not registered in native fixture registry (ESD deferred to V0.6).'
    }));
    return;
  }

  const source = await resolveNativeFixture(
    explicitPath,
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

  // stateCount 是**语义状态数**（不含每组尾随哨兵槽）；文件头 0x30 计的是物理记录数，
  // 由 parsedStateRecordCount 对照。两者相差恰好 stateGroupCount，详见
  // EsdNativeDocument.cs 类型注释。这里把两组都打出来，避免读者把 659 与 707 之一
  // 当成「另一个算错了」。
  console.log(JSON.stringify({
    ok: true,
    message: `ESD native 读取验证通过（${d.stateGroupCount} groups, ${d.stateCount} states`
      + `（+${d.stateGroupCount} 尾随哨兵 = ${d.parsedStateRecordCount} 条记录）, ${d.conditionCount} conditions）`,
    stateGroupCount: d.stateGroupCount,
    stateCount: d.stateCount,
    parsedStateRecordCount: d.parsedStateRecordCount,
    declaredStateCount: d.declaredStateCount,
    stateSentinelModelConsistent: d.stateSentinelModelConsistent,
    conditionCount: d.conditionCount,
    commandCallCount: d.commandCallCount,
    commandBanks: d.commandBanks,
    coverageComplete: d.coverageComplete,
    coverageShortfalls: d.coverageShortfalls,
    authority: d.authority,
    roundTrip: r.diagnostics?.map((x: { code: string }) => x.code)
  }, null, 2));
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
