import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResourceFormatKind, ResourceKind } from '@soulforge/shared';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openResourcePreview } from '../preview/openResourcePreview.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';
import { ALL_RESOURCE_KINDS } from '../workspace/resourceKinds.js';

interface PreviewCounts {
  text: number;
  hex: number;
  empty: number;
  failed: number;
}

async function main(): Promise<void> {
  const workspaceRoot = resolve(process.argv[2] ?? '../../mods');

  // 语料缺失时结构化跳过，而不是让 scanWorkspace 抛 ENOENT。
  //
  // 这条 smoke 打的是本机真实 Mod 目录（默认 ../../mods），公开环境没有它。此前
  // 它既没有跳过分支、又不在任何 tier —— 于是「无法执行」和「无人调度」两个问题
  // 互相掩盖：登记进 native 层后必须能诚实跳过，否则会把缺语料伪装成失败。
  // 跳过标记用单行 status:'skipped'，由 verify 的五态判定识别，绝不冒充通过。
  if (!existsSync(workspaceRoot)) {
    console.log(JSON.stringify({
      ok: null,
      status: 'skipped',
      smoke: 'real-mod-open',
      reason: `本机 Mod 语料目录不存在：${workspaceRoot}`,
      remedy: 'npm run test:real-mod-readonly-preview -w @soulforge/core -- <你的 Mod 目录>',
      skipSemantics: '结构跳过：未声称通过，也不构成 native 完成声明。'
    }));
    return;
  }

  const result = await scanWorkspace({ workspaceRoot });

  const previewCounts: PreviewCounts = {
    text: 0,
    hex: 0,
    empty: 0,
    failed: 0
  };

  const formatCounts = new Map<ResourceFormatKind, number>();
  const failed: Array<{ relativePath: string; diagnostics: unknown[] }> = [];
  const unknownFiles: string[] = [];
  const unknownFormatFiles: Array<{ relativePath: string; extension: string; compoundExtension: string; formatLabel: string }> = [];
  let truncated = 0;
  let structuredPreviews = 0;
  let editableStructuredPreviews = 0;
  let nativeInspections = 0;
  let largest = { relativePath: '', size: 0 };

  for (const file of result.files) {
    if (file.size > largest.size) largest = { relativePath: file.relativePath, size: file.size };
    formatCounts.set(file.formatKind, (formatCounts.get(file.formatKind) ?? 0) + 1);
    if (file.resourceKind === 'unknown') unknownFiles.push(file.relativePath);
    if (file.formatKind === 'unknown') {
      unknownFormatFiles.push({
        relativePath: file.relativePath,
        extension: file.extension,
        compoundExtension: file.compoundExtension,
        formatLabel: file.formatLabel
      });
    }

    const preview = await openResourcePreview({ file });
    previewCounts[preview.previewKind] += 1;
    if (preview.truncated) truncated += 1;
    if (preview.structuredPreview) structuredPreviews += 1;
    if (preview.structuredPreview?.editable) editableStructuredPreviews += 1;
    if (preview.nativeInspection) nativeInspections += 1;

    if (preview.previewKind === 'failed') {
      failed.push({
        relativePath: file.relativePath,
        diagnostics: preview.diagnostics
      });
    }
  }

  const summary = {
    workspaceRoot,
    scannedFiles: result.files.length,
    countsByKind: sortedKindCounts(result.countsByKind),
    formatCounts: Object.fromEntries([...formatCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    scanDiagnostics: result.diagnostics.length,
    previewCounts,
    truncatedPreviews: truncated,
    structuredPreviews,
    editableStructuredPreviews,
    nativeInspections,
    largestFile: largest,
    unknownFiles,
    unknownFormatFiles,
    failedPreviews: failed
  };

  console.log(JSON.stringify(summary, null, 2));

  if (result.files.length === 0) {
    throw new Error('Real mod smoke test scanned zero files.');
  }

  if (failed.length > 0) {
    throw new Error(`Real mod smoke test failed to preview ${failed.length} files.`);
  }
}

function sortedKindCounts(counts: Record<ResourceKind, number>): Record<ResourceKind, number> {
  return Object.fromEntries(ALL_RESOURCE_KINDS.map((kind) => [kind, counts[kind] ?? 0])) as Record<ResourceKind, number>;
}

main().finally(() => disposeBridgeDaemonPool()).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
