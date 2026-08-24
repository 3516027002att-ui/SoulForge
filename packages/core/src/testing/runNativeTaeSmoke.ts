/**
 * Native TAE smoke: read a real Sekiro TAE from the registered corpus via Bridge.
 * Verifies header, animation count, event types, and roundtrip integrity.
 *
 * Authority: candidate — read-only, no writer or game-load verification.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { readTaeEventTemplateFile } from '../tae/taeEventTemplate.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { classifyChildExtract, reportInfrastructureFailure } from './nativeFixtureExtract.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
    events?: Array<{ parameterDecoded?: boolean }>;
  }>;
}

function templateCandidates(gameRoot: string | undefined): string[] {
  const candidates = [process.env.SOULFORGE_TAE_TEMPLATE_PATH?.trim() ?? ''];
  if (gameRoot) {
    candidates.push(join(gameRoot, '..', 'tools', 'DSAnimStudio-4.9.9[Build 4999]', 'Res', 'TAE.Template.SDT.xml'));
  }
  candidates.push('D:\\mystream\\Sekiro Shadows Die Twice\\tools\\DSAnimStudio-4.9.9[Build 4999]\\Res\\TAE.Template.SDT.xml');
  return [...new Set(candidates.filter(Boolean))];
}

async function loadTemplateLayouts(gameRoot: string | undefined): Promise<{
  source: string | null;
  layouts: Record<string, Array<{ name: string; kind: string; slotSize: number }>>;
}> {
  for (const candidate of templateCandidates(gameRoot)) {
    if (!existsSync(candidate)) continue;
    const parsed = await readTaeEventTemplateFile(candidate);
    if (!parsed.ok || parsed.byEventTypeId.size === 0) continue;
    return {
      source: candidate,
      layouts: Object.fromEntries(
        [...parsed.byEventTypeId.entries()].map(([eventTypeId, definition]) => [
          String(eventTypeId),
          definition.fields.map((field) => ({
            name: field.name,
            kind: field.kind,
            slotSize: field.slotSize
          }))
        ])
      )
    };
  }
  return { source: null, layouts: {} };
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const discoveredPath = gameRoot ? join(gameRoot, 'chr', 'c0000.anibnd.dcx') : undefined;
  const registryRegistered = await nativeFixtureRoleRegistered('tae-primary');
  // A configured read-only game root is sufficient for the real TAE read leg;
  // the registry remains the stronger hash-locked path when it is available.
  if (!explicitPath && !discoveredPath && !registryRegistered) {
    console.log(JSON.stringify({
      ok: true,
      status: 'NOT_RUN_ENVIRONMENTAL',
      message: '未提供 TAE 原版路径；请设置 SOULFORGE_SEKIRO_GAME_ROOT 或显式传入 c0000.anibnd.dcx。'
    }));
    return;
  }
  if (!explicitPath && discoveredPath && !existsSync(discoveredPath)) {
    throw new Error(`SOULFORGE_SEKIRO_GAME_ROOT 中缺少 ${discoveredPath}。`);
  }
  const source = await resolveNativeFixture(
    explicitPath ?? discoveredPath,
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
  const template = await loadTemplateLayouts(gameRoot ?? oodleRuntimeRoot);
  const result = await runBridge<TaeEnvelope>({
    command: 'read-tae-document',
    filePath: taePath,
    allowedRoots: [taePath.replace(/[/\\][^/\\]+$/, ''), oodleRuntimeRoot],
    oodleRuntimeRoot,
    ...(Object.keys(template.layouts).length > 0
      ? { commandOptions: { templateLayouts: template.layouts } }
      : {}),
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

  const decodedEvents = data.animations?.flatMap((animation) => animation.events ?? [])
    .filter((event) => event.parameterDecoded === true).length ?? 0;
  const observedEvents = data.animations?.flatMap((animation) => animation.events ?? []).length ?? 0;
  if (template.source && observedEvents > 0 && decodedEvents === 0) {
    throw new Error('TAE template was loaded but no observed event parameter decoded');
  }

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
    templateSource: template.source,
    templateEventTypeCount: Object.keys(template.layouts).length,
    observedEventCount: observedEvents,
    decodedEventCount: decodedEvents,
    sampleAnimations: data.animations?.slice(0, 5)
  }, null, 2));
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
