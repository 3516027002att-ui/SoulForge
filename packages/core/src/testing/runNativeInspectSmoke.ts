import { resolve } from 'node:path';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openResourcePreview } from '../preview/openResourcePreview.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';

interface NativeInspectSmokeSummary {
  workspaceRoot: string;
  sampledFiles: number;
  nativeInspections: number;
  containerSummaries: number;
  totalContainerHints: number;
  headerSummaries: number;
  failures: Array<{ relativePath: string; diagnostics: unknown[] }>;
  samples: Array<{
    relativePath: string;
    resourceKind: string;
    formatKind: string;
    rootFormat?: string;
    hints: number;
    parser?: string;
  }>;
}

const MAX_SAMPLES = 24;

async function main(): Promise<void> {
  // 默认值原先是 `../../mods`，从仓库根运行时 resolve 会跳出仓库落到 `D:\mods`
  // ——一个既不存在也不属于本项目的路径。改为沿用 native 层统一的语料环境变量
  // SOULFORGE_NATIVE_FIXTURE_ROOT（由 scripts/with-local-has-game-env.mjs 注入），
  // 显式参数仍然优先。都没有时下面会走结构化 skip。
  const workspaceRoot = resolve(
    process.argv[2]
    ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? '../../mods'
  );
  const result = await scanWorkspace({ workspaceRoot });
  const nativeFiles = result.files
    .filter((file) => file.formatKind !== 'text' && file.formatKind !== 'unknown')
    .sort((left, right) => rankNativeFile(left.relativePath) - rankNativeFile(right.relativePath))
    .slice(0, MAX_SAMPLES);

  // 无语料是「没有可验证对象」，不是「验证失败」。原先在全部采样跑完后才硬抛
  // 'found no native files to sample'，于是在任何没有本机 mod 语料的机器上
  // （默认 workspaceRoot 是不存在的 ../../mods）该 smoke 恒定 failed，把环境
  // 缺失伪装成能力缺陷。按仓库约定改成显式 skipped：既不谎称通过，也不污染红灯。
  if (nativeFiles.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'NATIVE_CORPUS_UNAVAILABLE',
      workspaceRoot,
      message: `工作区 ${workspaceRoot} 下没有可采样的原生文件，跳过原生 inspect 验证。`,
      hint: '传入真实 mod 工作区路径作为第一个参数即可执行：node dist/testing/runNativeInspectSmoke.js <workspaceRoot>'
    }, null, 2));
    return;
  }

  const summary: NativeInspectSmokeSummary = {
    workspaceRoot,
    sampledFiles: nativeFiles.length,
    nativeInspections: 0,
    containerSummaries: 0,
    totalContainerHints: 0,
    headerSummaries: 0,
    failures: [],
    samples: []
  };

  for (const file of nativeFiles) {
    const preview = await openResourcePreview({ file, inspectNative: true, parseStructured: true, bridgeTimeoutMs: 30_000 });
    if (preview.nativeInspection) summary.nativeInspections += 1;
    if (preview.structuredPreview?.container) {
      summary.containerSummaries += 1;
      summary.totalContainerHints += preview.structuredPreview.container.hints.length;
    }
    if (hasHeaderSummary(preview.nativeInspection?.data)) summary.headerSummaries += 1;

    summary.samples.push({
      relativePath: file.relativePath,
      resourceKind: file.resourceKind,
      formatKind: file.formatKind,
      ...(preview.structuredPreview?.container?.rootFormat ? { rootFormat: preview.structuredPreview.container.rootFormat } : {}),
      hints: preview.structuredPreview?.container?.hints.length ?? 0,
      ...(preview.structuredPreview?.parser ? { parser: preview.structuredPreview.parser } : {})
    });

    if (preview.previewKind === 'failed' || preview.nativeInspection?.parseStatus === 'failed') {
      summary.failures.push({ relativePath: file.relativePath, diagnostics: preview.diagnostics });
    }
  }

  const bridgeUnavailable = summary.failures.length > 0 && summary.failures.every((failure) => hasBridgeSpawnFailure(failure.diagnostics));
  console.log(JSON.stringify({ ...summary, bridgeUnavailable }, null, 2));

  if (bridgeUnavailable) return;
  if (summary.nativeInspections === 0) throw new Error('Native inspect smoke test did not attach any bridge inspection results.');
  if (summary.containerSummaries === 0) throw new Error('Native inspect smoke test did not produce any container summaries.');
  if (summary.headerSummaries === 0) throw new Error('Native inspect smoke test did not produce any header summaries.');
  if (summary.failures.length > 0) throw new Error(`Native inspect smoke test failed on ${summary.failures.length} sampled file(s).`);
}

function hasBridgeSpawnFailure(diagnostics: unknown[]): boolean {
  return diagnostics.some((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== 'object') return false;
    const code = (diagnostic as { code?: unknown }).code;
    const message = (diagnostic as { message?: unknown }).message;
    return code === 'BRIDGE_SPAWN_FAILED' && typeof message === 'string' && message.includes('ENOENT');
  });
}

function rankNativeFile(relativePath: string): number {
  const path = relativePath.toLowerCase();
  if (path.includes('msg') || path.includes('fmg')) return 0;
  if (path.includes('param')) return 1;
  if (path.includes('emevd')) return 2;
  if (path.includes('msb')) return 3;
  if (path.includes('bnd')) return 4;
  if (path.endsWith('.dcx')) return 5;
  return 10;
}

function hasHeaderSummary(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const evidence = (data as { evidence?: unknown }).evidence;
  if (!Array.isArray(evidence)) return false;
  return evidence.some((item) => item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'headerSummary');
}

main().finally(() => disposeBridgeDaemonPool()).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
