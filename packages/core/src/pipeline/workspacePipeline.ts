import { readFile } from 'node:fs/promises';
import type { BridgeResult, Diagnostic, IndexedFile, ResourceKind } from '@soulforge/shared';
import { ingestBridgeResult } from '../indexing/ingestBridgeResult.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { parseEventText } from '../parsers/eventTextParser.js';
import { parseMsgText } from '../parsers/msgTextParser.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';

export interface AnalyzeWorkspaceOptions {
  workspaceRoot: string;
  parseTextResources?: boolean;
  parseJsonFixtures?: boolean;
  maxFilesToParse?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AnalyzeWorkspaceProgress) => void;
}

export interface AnalyzeWorkspaceProgress {
  phase: 'scan' | 'parse' | 'references' | 'done';
  current: number;
  total?: number;
  message?: string;
}

export interface AnalyzeWorkspaceResult {
  index: WorkspaceIndex;
  diagnostics: Diagnostic[];
  parsedFiles: number;
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
 * It performs safe scanning, then opportunistically parses text fixtures and
 * JSON exports. Real binary parsing can later be inserted by calling the C#
 * bridge and passing BridgeResult JSON through ingestBridgeResult.
 */
export async function analyzeWorkspace(options: AnalyzeWorkspaceOptions): Promise<AnalyzeWorkspaceResult> {
  const diagnostics: Diagnostic[] = [];
  const scan = await scanWorkspace({
    workspaceRoot: options.workspaceRoot,
    signal: options.signal,
    onProgress: (progress) => options.onProgress?.({ phase: 'scan', current: progress.scannedFiles, message: progress.currentPath })
  });

  diagnostics.push(...scan.diagnostics);
  const index = new WorkspaceIndex(scan.workspaceId);
  index.setFiles(scan.files);

  const candidates = scan.files.filter((file) => shouldParse(file, options));
  const limited = candidates.slice(0, options.maxFilesToParse ?? 500);
  let parsedFiles = 0;

  for (let i = 0; i < limited.length; i += 1) {
    throwIfAborted(options.signal);
    const file = limited[i]!;
    options.onProgress?.({ phase: 'parse', current: i + 1, total: limited.length, message: file.relativePath });
    const parsed = await parseKnownTextOrJson(file, index, options);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.accepted) parsedFiles += 1;
  }

  options.onProgress?.({ phase: 'references', current: 0, message: 'Building reference graph' });
  const referenceStats = index.rebuildReferences({ enableNumericFallback: true }).stats;
  options.onProgress?.({ phase: 'done', current: parsedFiles, total: limited.length, message: 'Workspace analysis complete' });

  return { index, diagnostics, parsedFiles, referenceStats };
}

function shouldParse(file: IndexedFile, options: AnalyzeWorkspaceOptions): boolean {
  const parseTextResources = options.parseTextResources ?? true;
  const parseJsonFixtures = options.parseJsonFixtures ?? true;
  if (parseJsonFixtures && file.extension === '.json') return true;
  if (!parseTextResources) return false;
  if (file.resourceKind === 'event' && (file.relativePath.endsWith('.txt') || file.relativePath.endsWith('.emevd.txt'))) return true;
  if (file.resourceKind === 'msg' && (file.relativePath.endsWith('.tsv') || file.relativePath.endsWith('.csv') || file.relativePath.endsWith('.txt') || file.relativePath.endsWith('.xml') || file.relativePath.endsWith('.json'))) return true;
  return false;
}

async function parseKnownTextOrJson(
  file: IndexedFile,
  index: WorkspaceIndex,
  options: AnalyzeWorkspaceOptions
): Promise<{ accepted: boolean; diagnostics: Diagnostic[] }> {
  try {
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
