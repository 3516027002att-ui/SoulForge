import { readFile } from 'node:fs/promises';
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
  maxFilesToParse?: number;
  maxFilesToInspect?: number;
  bridgeProjectPath?: string;
  bridgeTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AnalyzeWorkspaceProgress) => void;
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
 * - semantic ingestion for text fixtures, JSON bridge exports, and conservative native msg exports;
 * - native resource inspection through the C# bridge.
 *
 * Inspect results are evidence only. They are deliberately not ingested as
 * event/map/param/msg symbols until a resource-specific export command returns
 * a reviewed semantic BridgeResult.
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
  const parseLimited = parseCandidates.slice(0, options.maxFilesToParse ?? 500);
  let parsedFiles = 0;

  for (let i = 0; i < parseLimited.length; i += 1) {
    throwIfAborted(options.signal);
    const file = parseLimited[i]!;
    options.onProgress?.({ phase: 'parse', current: i + 1, total: parseLimited.length, message: file.relativePath });
    const parsed = await parseKnownResource(file, index, options);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.accepted) parsedFiles += 1;
  }

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
  if (parseJsonFixtures && file.extension === '.json') return true;
  if (exportNativeMsgResources && isNativeMsgResource(file)) return true;
  if (!parseTextResources) return false;
  if (file.resourceKind === 'event' && (file.relativePath.endsWith('.txt') || file.relativePath.endsWith('.emevd.txt'))) return true;
  if (file.resourceKind === 'msg' && (file.relativePath.endsWith('.tsv') || file.relativePath.endsWith('.csv') || file.relativePath.endsWith('.txt') || file.relativePath.endsWith('.xml') || file.relativePath.endsWith('.json'))) return true;
  return false;
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
    ...(options.bridgeProjectPath ? { bridgeProjectPath: options.bridgeProjectPath } : {}),
    ...(options.bridgeTimeoutMs ? { timeoutMs: options.bridgeTimeoutMs } : {})
  });

  const diagnostics: Diagnostic[] = [...result.diagnostics];
  diagnostics.push({
    severity: result.parseStatus === 'failed' ? 'warning' : 'info',
    code: 'BRIDGE_INSPECTION_RECORDED',
    message: `Bridge inspect completed with status '${result.parseStatus}'.`,
    sourceUri: file.sourceUri,
    details: {
      resourceKind: result.resourceKind,
      bridgeSourceUri: result.sourceUri,
      data: result.data
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
    if (isNativeMsgResource(file)) {
      const result = await runBridge({
        command: 'export-msg',
        filePath: file.absolutePath,
        ...(options.bridgeProjectPath ? { bridgeProjectPath: options.bridgeProjectPath } : {}),
        ...(options.bridgeTimeoutMs ? { timeoutMs: options.bridgeTimeoutMs } : {})
      });
      const ingest = ingestBridgeResult(index, result);
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

function isNativeMsgResource(file: IndexedFile): boolean {
  if (file.resourceKind !== 'msg') return false;
  const path = file.relativePath.toLowerCase();
  return path.endsWith('.fmg') || path.endsWith('.fmg.dcx') || path.includes('msgbnd') || path.includes('.msgbnd');
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
