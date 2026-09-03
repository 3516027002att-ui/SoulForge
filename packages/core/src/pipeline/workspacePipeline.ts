import { readFile } from 'node:fs/promises';
import type { BridgeCommand } from '../bridge/runBridge.js';
import type { BridgeResult, Diagnostic, IndexedFile, ResourceKind } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { ingestBridgeResult } from '../indexing/ingestBridgeResult.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { parseEventText } from '../parsers/eventTextParser.js';
import { parseMsgText } from '../parsers/msgTextParser.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';

export interface AnalyzeWorkspaceOptions {
  workspaceRoot: string;
  parseTextResources?: boolean;
  parseJsonFixtures?: boolean;
  inspectNativeResources?: boolean;
  exportNativeMsgResources?: boolean;
  exportNativeCandidateResources?: boolean;
  maxFilesToParse?: number;
  maxFilesToInspect?: number;
  bridgeProjectPath?: string;
  /** Optional explicit Bridge executable, primarily for release/runtime verification. */
  bridgeExecutablePath?: string;
  bridgeTimeoutMs?: number;
  /** Main-owned Sekiro installation root used for local Oodle capability. */
  oodleRuntimeRoot?: string;
  signal?: AbortSignal;
  onProgress?: (progress: AnalyzeWorkspaceProgress) => void;
  /**
   * Publish the first searchable semantic slice before the heavyweight
   * inspection pass finishes.  The callback is invoked once after the first
   * useful export, or at the end of parsing when no semantic export could be
   * accepted, so callers can distinguish "still parsing" from "no evidence".
   */
  onSemanticIndexReady?: (input: {
    index: WorkspaceIndex;
    parsedFiles: number;
    total: number;
    diagnostics: readonly Diagnostic[];
  }) => void | Promise<void>;
}

export interface AnalyzeWorkspaceProgress {
  phase: 'scan' | 'parse' | 'inspect' | 'references' | 'done';
  current: number;
  total?: number;
  message?: string;
}

export interface AnalyzeWorkspaceResult {
  index: WorkspaceIndex;
  diagnostics: Diagnostic[];
  parsedFiles: number;
  inspectedFiles: number;
  referenceStats: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers: number;
  };
}

/**
 * Production-shaped v0.1 analysis pipeline.
 *
 * The pipeline has two independent passes:
 * - semantic ingestion for text fixtures, JSON bridge exports, conservative native msg exports,
 *   and low-confidence native semantic candidate exports;
 * - native resource inspection through the C# bridge.
 *
 * Inspect results are evidence only. Native semantic candidates must come from a
 * resource-specific export command and stay low-confidence until fixture-reviewed.
 */
export async function analyzeWorkspace(options: AnalyzeWorkspaceOptions): Promise<AnalyzeWorkspaceResult> {
  const diagnostics: Diagnostic[] = [];
  const scan = await scanWorkspace({
    workspaceRoot: options.workspaceRoot,
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (progress) => {
      options.onProgress?.({
        phase: 'scan',
        current: progress.scannedFiles,
        ...(progress.currentPath ? { message: progress.currentPath } : {})
      });
    }
  });

  diagnostics.push(...scan.diagnostics);
  const index = new WorkspaceIndex(scan.workspaceId);
  index.setFiles(scan.files);

  const parseCandidates = scan.files.filter((file) => shouldParse(file, options));
  // The first useful semantic slice is what unblocks Agent lookup.  Parse
  // PARAM/MSG before the much larger EVENT/MAP population, while preserving
  // discovery order within one resource family.  This is a scheduling hint,
  // not evidence about any ID or source; every value still comes from Bridge
  // export/ingest below.
  const parseLimited = parseCandidates
    .map((file, order) => ({ file, order }))
    .sort((left, right) => parsePriority(left.file) - parsePriority(right.file) || left.order - right.order)
    .slice(0, options.maxFilesToParse ?? 500)
    .map(({ file }) => file);
  let parsedFiles = 0;
  let semanticIndexNotified = false;

  const hasSearchableSemanticEntries = (): boolean => {
    const stats = index.getStats();
    return stats.events > 0
      || stats.mapEntities > 0
      || stats.paramRows > 0
      || stats.textEntries > 0;
  };

  const notifySemanticIndexReady = async (force: boolean): Promise<void> => {
    if (semanticIndexNotified || !options.onSemanticIndexReady) return;
    if (!force && !hasSearchableSemanticEntries()) return;
    semanticIndexNotified = true;
    await options.onSemanticIndexReady({
      index,
      parsedFiles,
      total: parseLimited.length,
      diagnostics: [...diagnostics]
    });
  };

  for (let i = 0; i < parseLimited.length; i += 1) {
    throwIfAborted(options.signal);
    const file = parseLimited[i]!;
    options.onProgress?.({ phase: 'parse', current: i + 1, total: parseLimited.length, message: file.relativePath });
    const parsed = await parseKnownResource(file, index, options);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.accepted) parsedFiles += 1;
    // PARAM/MSG are ordered first, so on a real game workspace this normally
    // publishes immediately after the first native PARAM/MSG export instead
    // of waiting for every map/event Bridge read.  If those families are
    // absent, the first accepted semantic family still unblocks the same
    // contract.
    await notifySemanticIndexReady(false);
  }

  // Resolve the staged-readiness contract even when every candidate failed or
  // the workspace had no parse candidates.  The caller will keep the corpus
  // fail-closed as unavailable; it must not wait forever for a stage that can
  // never become searchable.
  await notifySemanticIndexReady(true);

  const inspectCandidates = (options.inspectNativeResources ?? true)
    ? scan.files.filter((file) => shouldInspectWithBridge(file, options))
    : [];
  const inspectLimited = inspectCandidates.slice(0, options.maxFilesToInspect ?? 200);
  let inspectedFiles = 0;

  for (let i = 0; i < inspectLimited.length; i += 1) {
    throwIfAborted(options.signal);
    const file = inspectLimited[i]!;
    options.onProgress?.({ phase: 'inspect', current: i + 1, total: inspectLimited.length, message: file.relativePath });
    const inspected = await inspectNativeResource(file, options);
    diagnostics.push(...inspected.diagnostics);
    if (inspected.accepted) inspectedFiles += 1;
  }

  options.onProgress?.({ phase: 'references', current: 0, message: 'Building reference graph' });
  const referenceStats = index.rebuildReferences({ enableNumericFallback: true }).stats;
  options.onProgress?.({ phase: 'done', current: parsedFiles, total: parseLimited.length, message: 'Workspace analysis complete' });

  return { index, diagnostics, parsedFiles, inspectedFiles, referenceStats };
}

function shouldParse(file: IndexedFile, options: AnalyzeWorkspaceOptions): boolean {
  const parseTextResources = options.parseTextResources ?? true;
  const parseJsonFixtures = options.parseJsonFixtures ?? true;
  const exportNativeMsgResources = options.exportNativeMsgResources ?? true;
  const exportNativeCandidateResources = options.exportNativeCandidateResources ?? true;
  if (parseJsonFixtures && file.extension === '.json') return true;
  if (exportNativeMsgResources && isNativeMsgResource(file)) return true;
  if (exportNativeCandidateResources && isNativeCandidateResource(file)) return true;
  if (!parseTextResources) return false;
  if (file.resourceKind === 'event' && (file.relativePath.endsWith('.txt') || file.relativePath.endsWith('.emevd.txt'))) return true;
  if (file.resourceKind === 'msg' && (file.relativePath.endsWith('.tsv') || file.relativePath.endsWith('.csv') || file.relativePath.endsWith('.txt') || file.relativePath.endsWith('.xml') || file.relativePath.endsWith('.json'))) return true;
  return false;
}

// The real Sekiro gameparam container takes longer than the generic 15-second
// Bridge request budget to unwrap and serialize its 131 native PARAM entries.
// Keep the longer budget scoped to semantic exports (still cancellable and
// single-flight); inspection/read tools retain their normal bounded timeout.
const DEFAULT_SEMANTIC_EXPORT_TIMEOUT_MS = 30_000;
const DEFAULT_PARAM_EXPORT_TIMEOUT_MS = 120_000;

function parsePriority(file: IndexedFile): number {
  if (file.resourceKind === 'param') return 0;
  if (file.resourceKind === 'msg') return 1;
  if (file.resourceKind === 'event') return 2;
  if (file.resourceKind === 'map') return 3;
  return 4;
}

function shouldInspectWithBridge(file: IndexedFile, options: AnalyzeWorkspaceOptions): boolean {
  if (shouldParse(file, options)) return false;
  if (file.resourceKind === 'unknown') return false;
  if (file.size === 0) return true;
  const path = file.relativePath.toLowerCase();
  return path.endsWith('.dcx')
    || path.includes('.bnd')
    || path.includes('.emevd')
    || path.includes('.msb')
    || path.includes('.param')
    || path.endsWith('.fmg');
}

async function inspectNativeResource(
  file: IndexedFile,
  options: AnalyzeWorkspaceOptions
): Promise<{ accepted: boolean; diagnostics: Diagnostic[] }> {
  const result = await runBridge({
    command: 'inspect',
    filePath: file.absolutePath,
    resourceUri: file.sourceUri,
    allowedRoots: [options.workspaceRoot],
    // Workspace analysis only needs bounded envelope evidence.  KRAK preview
    // decompression is deliberately opt-in: running it for every .dcx file
    // can allocate hundreds of MiB per file and starve the desktop during a
    // full real-game scan.  Explicit preview/read tools keep the default-on
    // behavior for callers that actually need decompressed evidence.
    commandOptions: { includeDcxDecompressionPreview: false },
    ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.bridgeProjectPath ? { bridgeProjectPath: options.bridgeProjectPath } : {}),
    ...(options.bridgeExecutablePath ? { bridgeExecutablePath: options.bridgeExecutablePath } : {}),
    ...(options.bridgeTimeoutMs ? { timeoutMs: options.bridgeTimeoutMs } : {})
  });

  const diagnostics: Diagnostic[] = [...result.diagnostics];
  const inspection = result.data && typeof result.data === 'object'
    ? result.data as Record<string, unknown>
    : null;
  diagnostics.push({
    severity: result.parseStatus === 'failed' ? 'warning' : 'info',
    code: 'BRIDGE_INSPECTION_RECORDED',
    message: `Bridge inspect completed with status '${result.parseStatus}'.`,
    sourceUri: file.sourceUri,
    details: {
      resourceKind: result.resourceKind,
      bridgeSourceUri: result.sourceUri,
      parseStatus: result.parseStatus,
      evidenceCount: Array.isArray(inspection?.evidence) ? inspection.evidence.length : 0,
      layerCount: Array.isArray(inspection?.layers) ? inspection.layers.length : 0
    }
  });

  return { accepted: result.parseStatus !== 'failed', diagnostics };
}

async function parseKnownResource(
  file: IndexedFile,
  index: WorkspaceIndex,
  options: AnalyzeWorkspaceOptions
): Promise<{ accepted: boolean; diagnostics: Diagnostic[] }> {
  try {
    if (isNativeMsgResource(file) || isNativeCandidateResource(file)) {
      const command = exportCommandFor(file);
      if (!command) return { accepted: false, diagnostics: [] };
      const semanticTimeoutMs = options.bridgeTimeoutMs
        ?? (command === 'export-param' ? DEFAULT_PARAM_EXPORT_TIMEOUT_MS : DEFAULT_SEMANTIC_EXPORT_TIMEOUT_MS);
      const result = await runBridge({
        command,
        filePath: file.absolutePath,
        resourceUri: file.sourceUri,
        allowedRoots: [options.workspaceRoot],
        ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.bridgeProjectPath ? { bridgeProjectPath: options.bridgeProjectPath } : {}),
        ...(options.bridgeExecutablePath ? { bridgeExecutablePath: options.bridgeExecutablePath } : {}),
        timeoutMs: semanticTimeoutMs
      });
      // Bridge emits an absolute file URI because it is also used by native
      // diagnostics. WorkspaceIndex/RAG uses the workspace-relative URI as
      // its stable source key. Rebind only equal-to-envelope sourceUri
      // fields; never rewrite unrelated evidence from a nested payload.
      const ingest = ingestBridgeResult(index, canonicalizeBridgeSource(result, file.sourceUri));
      return { accepted: ingest.accepted, diagnostics: ingest.diagnostics };
    }

    const text = await readFile(file.absolutePath, 'utf8');

    if (file.resourceKind === 'event' && (file.relativePath.endsWith('.txt') || file.relativePath.endsWith('.emevd.txt'))) {
      const parsed = parseEventText({ sourceUri: file.sourceUri, sourcePath: file.relativePath, text });
      index.upsertEventExport(parsed.export);
      return { accepted: true, diagnostics: parsed.diagnostics };
    }

    if (file.resourceKind === 'msg') {
      const parsed = parseMsgText({ sourceUri: file.sourceUri, sourcePath: file.relativePath, text });
      index.upsertMsgExport(parsed.export);
      return { accepted: true, diagnostics: parsed.diagnostics };
    }

    if (file.extension === '.json') {
      const data = JSON.parse(text) as unknown;
      const kind = inferJsonFixtureKind(file);
      if (!kind) return { accepted: false, diagnostics: [] };
      const bridgeResult: BridgeResult<unknown> = {
        sourceUri: file.sourceUri,
        sourcePath: file.absolutePath,
        game: file.game,
        resourceKind: kind,
        parseStatus: 'parsed',
        diagnostics: [],
        data
      };
      const ingest = ingestBridgeResult(index, bridgeResult);
      return { accepted: ingest.accepted, diagnostics: ingest.diagnostics };
    }

    return { accepted: false, diagnostics: [] };
  } catch (error) {
    return {
      accepted: false,
      diagnostics: [
        {
          severity: 'warning',
          code: 'WORKSPACE_PIPELINE_PARSE_SKIPPED',
          message: error instanceof Error ? error.message : 'Failed to parse workspace resource.',
          sourceUri: file.sourceUri
        }
      ]
    };
  }
}

function canonicalizeBridgeSource(result: BridgeResult<unknown>, sourceUri: string): BridgeResult<unknown> {
  const nativeSourceUri = result.sourceUri;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = key === 'sourceUri' && child === nativeSourceUri ? sourceUri : rewrite(child);
    }
    return output;
  };
  return {
    ...result,
    sourceUri,
    diagnostics: result.diagnostics.map((diagnostic) => (
      diagnostic.sourceUri === nativeSourceUri ? { ...diagnostic, sourceUri } : diagnostic
    )),
    ...(result.data === undefined ? {} : { data: rewrite(result.data) })
  };
}

function isNativeMsgResource(file: IndexedFile): boolean {
  if (file.resourceKind !== 'msg') return false;
  const path = file.relativePath.toLowerCase();
  return path.endsWith('.fmg') || path.endsWith('.fmg.dcx') || path.includes('msgbnd') || path.includes('.msgbnd');
}

function isNativeCandidateResource(file: IndexedFile): boolean {
  const path = file.relativePath.toLowerCase();
  if (file.resourceKind === 'event') return path.includes('.emevd');
  if (file.resourceKind === 'map') return path.includes('.msb');
  if (file.resourceKind === 'param') return path.includes('.param');
  return false;
}

function exportCommandFor(file: IndexedFile): BridgeCommand | null {
  if (isNativeMsgResource(file)) return 'export-msg';
  if (file.resourceKind === 'event') return 'export-event';
  if (file.resourceKind === 'map') return 'export-map';
  if (file.resourceKind === 'param') return 'export-param';
  return null;
}

function inferJsonFixtureKind(file: IndexedFile): ResourceKind | null {
  const path = file.relativePath.toLowerCase();
  if (file.resourceKind === 'map' || path.includes('mockmap')) return 'map';
  if (file.resourceKind === 'param' || path.includes('mockparam')) return 'param';
  if (file.resourceKind === 'msg' || path.includes('mockmsg')) return 'msg';
  if (file.resourceKind === 'event' || path.includes('mockevent')) return 'event';
  return null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Workspace analysis aborted.');
}
