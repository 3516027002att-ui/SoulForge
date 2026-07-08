import { resolve } from 'node:path';
import type { ResourceFormatKind, ResourceKind } from '@soulforge/shared';
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
