import { stat } from 'node:fs/promises';
import type { IndexedFile } from '@soulforge/shared';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openResourcePreview } from '../preview/openResourcePreview.js';
import { detectResourceFileType } from '../workspace/resourceFileTypes.js';
import { classifyResourceKind } from '../workspace/resourceKinds.js';
import { makeFileResourceUri, makeWorkspaceId } from '../workspace/resourceUri.js';
import {
  loadRegisteredNativeFixtureRegistry,
  type RegisteredNativeFixture
} from './nativeFixturePaths.js';

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
  const registry = await loadRegisteredNativeFixtureRegistry();
  const indexed = await Promise.all(registry.fixtures.map((fixture) =>
    indexRegisteredFixture(registry.root, fixture)));
  const fixtureByFileId = new Map(indexed.map(({ file, fixture }) => [file.id, fixture]));
  const nativeFiles = indexed.map(({ file }) => file)
    .filter((file) => file.formatKind !== 'text' && file.formatKind !== 'unknown')
    .sort((left, right) => rankNativeFile(left.relativePath) - rankNativeFile(right.relativePath))
    .slice(0, MAX_SAMPLES);

  const summary: NativeInspectSmokeSummary = {
    workspaceRoot: 'registry-bound-private-fixtures',
    sampledFiles: nativeFiles.length,
    nativeInspections: 0,
    containerSummaries: 0,
    totalContainerHints: 0,
    headerSummaries: 0,
    failures: [],
    samples: []
  };

  for (const file of nativeFiles) {
    const fixture = fixtureByFileId.get(file.id);
    if (!fixture) throw new Error('Registered fixture identity was lost before preview.');
    const preview = await openResourcePreview({ file, inspectNative: true, parseStructured: true, bridgeTimeoutMs: 30_000 });
    if (preview.nativeInspection) summary.nativeInspections += 1;
    if (preview.structuredPreview?.container) {
      summary.containerSummaries += 1;
      summary.totalContainerHints += preview.structuredPreview.container.hints.length;
    }
    if (hasHeaderSummary(preview.nativeInspection?.data)) summary.headerSummaries += 1;

    summary.samples.push({
      relativePath: fixture.fixtureId,
      resourceKind: file.resourceKind,
      formatKind: file.formatKind,
      ...(preview.structuredPreview?.container?.rootFormat ? { rootFormat: preview.structuredPreview.container.rootFormat } : {}),
      hints: preview.structuredPreview?.container?.hints.length ?? 0,
      ...(preview.structuredPreview?.parser ? { parser: preview.structuredPreview.parser } : {})
    });

    if (preview.previewKind === 'failed' || preview.nativeInspection?.parseStatus === 'failed') {
      summary.failures.push({ relativePath: fixture.fixtureId, diagnostics: preview.diagnostics });
    }
  }

  const bridgeUnavailable = summary.failures.length > 0 && summary.failures.every((failure) => hasBridgeSpawnFailure(failure.diagnostics));
  console.log(JSON.stringify({ ...summary, bridgeUnavailable }, null, 2));

  if (nativeFiles.length === 0) throw new Error('Native inspect smoke test found no native files to sample.');
  if (bridgeUnavailable) return;
  if (summary.nativeInspections === 0) throw new Error('Native inspect smoke test did not attach any bridge inspection results.');
  if (summary.containerSummaries === 0) throw new Error('Native inspect smoke test did not produce any container summaries.');
  if (summary.headerSummaries === 0) throw new Error('Native inspect smoke test did not produce any header summaries.');
  if (summary.failures.length > 0) throw new Error(`Native inspect smoke test failed on ${summary.failures.length} sampled file(s).`);
}

async function indexRegisteredFixture(
  workspaceRoot: string,
  fixture: RegisteredNativeFixture
): Promise<{ file: IndexedFile; fixture: RegisteredNativeFixture }> {
  const fileStat = await stat(fixture.absolutePath);
  const fileType = detectResourceFileType(fixture.localPath);
  const workspaceId = makeWorkspaceId(workspaceRoot);
  const sourceUri = makeFileResourceUri(fixture.localPath);
  return {
    fixture,
    file: {
      id: `${workspaceId}:${fixture.fixtureId}`,
      workspaceId,
      sourceUri,
      sourcePath: fixture.absolutePath,
      absolutePath: fixture.absolutePath,
      relativePath: fixture.localPath,
      game: fixture.game,
      resourceKind: classifyResourceKind(fixture.localPath),
      extension: fileType.extension,
      compoundExtension: fileType.compoundExtension,
      formatKind: fileType.formatKind,
      formatLabel: fileType.formatLabel,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      parseStatus: 'unparsed',
      diagnostics: []
    }
  };
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
