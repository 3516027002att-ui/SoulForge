import { createHash } from 'node:crypto';
import type { NormalizedReferenceQuery, ReferencePageRecord } from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { NativeEditSession } from '../editing/nativeEditSession.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { enrichReferenceContent, type NativeReferenceContentCursor } from './nativeReferenceContent.js';
import type { ReferenceCursorScope, ReferenceCursorStore } from './referenceCursorStore.js';

function scanScope(input: NormalizedReferenceQuery): ReferenceCursorScope {
  const { cursor: _cursor, sourceCursor: _sourceCursor, cursorScopeCheckRequired: _check, ...scope } = input;
  return scope;
}

function scopeKey(scope: ReferenceCursorScope): string {
  return JSON.stringify(Object.entries(scope).sort(([a], [b]) => a.localeCompare(b)));
}

/** Prepare bounded, read-only source content before locking a relation page. */
export async function prepareReferenceContentSearch(options: {
  index: WorkspaceIndex;
  edit: NativeEditSession;
  input: NormalizedReferenceQuery;
  store: ReferenceCursorStore;
  registry?: EmedfRegistry;
  signal?: AbortSignal;
  targetUri?: string;
  prioritySourceUris?: string[];
  persist?: (sourceUris: string[]) => Promise<void>;
}): Promise<{ scan: ReferencePageRecord['scan']; diagnostics: ReferencePageRecord['diagnostics'] }> {
  const scope = scanScope(options.input);
  const hash = createHash('sha256');
  for (const file of options.index.getFiles().sort((a, b) => a.sourceUri.localeCompare(b.sourceUri))) {
    hash.update(JSON.stringify([file.sourceUri, file.sha256, file.mtimeMs, file.size])).update('\0');
  }
  const sourceVersionKey = hash.digest('hex');
  let cursor: NativeReferenceContentCursor | undefined;
  if (options.input.sourceCursor) {
    const stored = options.store.get(options.input.sourceCursor);
    if (!stored || stored.rootUri !== 'reference-source-scan://' || stored.sourceScanState === undefined
      || stored.workspaceId !== options.index.workspaceId || scopeKey(stored.scope) !== scopeKey(scope)) {
      throw Object.assign(new Error('扫描游标已过期或与当前查询、工作区不匹配，请重新查询。'), { code: 'REFERENCE_SCAN_CURSOR_SCOPE_MISMATCH' });
    }
    if (stored.sourceVersionKey !== sourceVersionKey) {
      throw Object.assign(new Error('待扫描来源已变化，请重新查询。'), { code: 'STALE_READ_CURSOR' });
    }
    cursor = stored.sourceScanState as NativeReferenceContentCursor;
  }
  const enriched = await enrichReferenceContent({
    index: options.index, edit: options.edit,
    ...(cursor ? { cursor } : {}),
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.targetUri ? { targetUri: options.targetUri } : {}),
    ...(options.prioritySourceUris ? { prioritySourceUris: options.prioritySourceUris } : {}),
    maxSources: 2, maxScripts: 2, maxBytes: 512 * 1024, timeoutMs: 20000
  });
  if (enriched.updatedSourceUris.length > 0) await options.persist?.(enriched.updatedSourceUris);
  const sourceCursor = enriched.nextCursor ? options.store.issue({
    workspaceId: options.index.workspaceId,
    scope, rootUri: 'reference-source-scan://', relationOffset: 0,
    sourceVersionKey, sourceScanState: enriched.nextCursor,
    dependencySummary: { catalogGeneration: 0, entries: [] }
  }) : undefined;
  return {
    scan: {
      remaining: Boolean(enriched.nextCursor),
      complete: enriched.complete,
      failedCount: enriched.failedSourceKeys.length,
      ...(sourceCursor ? {
        sourceCursor,
        nextAction: { tool: 'find_references', args: { ...scope, sourceCursor }, reason: '继续搜索尚未读取的文件内容，然后刷新关联结果' }
      } : enriched.failedSourceKeys.length > 0 ? {
        nextAction: { tool: 'find_references', args: { ...scope }, reason: '部分来源读取失败；重新查询以重试未完成内容' }
      } : {})
    },
    diagnostics: [...(enriched.failedSourceKeys.length > 0 ? [{ severity: 'warning' as const, code: 'NATIVE_REFERENCE_INCOMPLETE', message: `${enriched.failedSourceKeys.length} 个来源或子项未能读取完整内容，可重新查询重试。` }] : []), ...enriched.diagnostics].slice(0, 8).map(({ severity, code, message, sourceUri }) => ({
      severity: severity === 'error' ? 'error' : severity === 'info' ? 'info' : 'warning',
      code, message, ...(sourceUri ? { sourceUri } : {})
    }))
  };
}
