import type { ResourceKind } from '@soulforge/shared';
import type { WorkspaceIndex, SearchResult } from '../indexing/workspaceIndex.js';
import type { CoverageSnapshot, CoverageStatus } from './types.js';
import { sourceRevisionForFiles } from './sourceRevision.js';

const KIND_BY_SCOPE: Readonly<Record<string, readonly ResourceKind[]>> = {
  event: ['event'],
  map: ['map'],
  param: ['param'],
  text: ['msg', 'menu'],
  action: ['action']
};

export function coverageForScope(
  index: WorkspaceIndex | null,
  scope: string,
  resultCount: number,
  sourceRevision?: string
): CoverageSnapshot {
  if (!index) return {
    status: 'SOURCE_UNAVAILABLE',
    scope,
    indexed: 0,
    expected: 0,
    successful: 0,
    failed: 0,
    completenessRatio: 0,
    resultCount,
    diagnostics: ['工作区未打开，不能判断覆盖率。']
  };

  const stats = index.getStats();
  const kinds = KIND_BY_SCOPE[scope] ?? [];
  const files = scope === 'workspace'
    ? index.getFiles()
    : index.getFiles().filter((file) => kinds.includes(file.resourceKind));
  const failed = files.filter((file) => file.parseStatus === 'failed' || file.parseStatus === 'unsupported').length;
  const partial = files.filter((file) => file.parseStatus === 'partial').length;
  const pending = files.filter((file) => file.parseStatus === 'unparsed').length;
  const successful = Math.max(0, files.length - failed - partial - pending);
  const expected = files.length;
  const indexed = expected;
  const effectiveSourceRevision = sourceRevision ?? sourceRevisionForFiles(files);
  const complete = expected > 0 && failed === 0 && partial === 0 && pending === 0;
  const status: CoverageStatus = resultCount > 0
    ? 'FOUND'
    : complete
      ? 'NOT_FOUND_WITH_COMPLETE_COVERAGE'
      : expected === 0
        ? 'NOT_INDEXED'
        : failed === expected
          ? 'PARSE_FAILED'
          : 'PARTIALLY_INDEXED';
  const scopeCount = scope === 'workspace'
    ? stats.files
    : scope === 'event'
    ? stats.events
    : scope === 'map'
      ? stats.mapEntities + stats.mapRegions
      : scope === 'param'
          ? stats.paramRows
          : scope === 'text'
            ? stats.textEntries
            : scope === 'action'
            ? countActionSymbols(index)
            : stats.files;
  return {
    status,
    scope,
    indexed: scopeCount,
    expected,
    successful,
    failed,
    ...(partial > 0 ? { partial } : {}),
    ...(effectiveSourceRevision ? { sourceRevision: effectiveSourceRevision } : {}),
    completenessRatio: expected === 0 ? 0 : successful / expected,
    resultCount,
    diagnostics: [
      ...(pending > 0 ? [`${pending} 个源文件尚未解析。`] : []),
      ...(failed > 0 ? [`${failed} 个源文件解析失败或不支持。`] : []),
      ...(partial > 0 ? [`${partial} 个源文件只有 partial 投影，不能用于完整否定证据。`] : [])
    ]
  };
}

export function coverageForSearch<T>(
  index: WorkspaceIndex | null,
  scope: string,
  results: readonly SearchResult<T>[]
): CoverageSnapshot {
  const sourceRevision = index
    ? sourceRevisionForFiles(index.getFiles().filter((file) => scope === 'workspace'
      || (KIND_BY_SCOPE[scope] ?? []).includes(file.resourceKind)))
    : undefined;
  return coverageForScope(index, scope, results.length, sourceRevision);
}

export function revisionForFiles(files: readonly { sha256?: string; mtimeMs: number; sourceUri: string }[]): string | undefined {
  return sourceRevisionForFiles(files);
}

function countActionSymbols(index: WorkspaceIndex): number {
  return index.getStats().filesByKind.action > 0 ? index.searchTaeEvents('', Number.MAX_SAFE_INTEGER).length : 0;
}
