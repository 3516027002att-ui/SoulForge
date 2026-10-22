import type { RegisteredTool } from '../toolRegistry.js';
import type { TaeExport } from '@soulforge/shared';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { asRecord } from '.././toolRegistrySupport.js';
import { asString } from '.././toolRegistrySupport.js';
import { boundedContentSearchPage } from '../boundedContentSearchPage.js';
import { fail } from '.././toolRegistrySupport.js';
import { nativePathFromFileToken } from '.././toolRegistrySupport.js';
import { ok } from '.././toolRegistrySupport.js';
import { ragSearchFallback } from '.././toolRegistrySupport.js';
import { requireEditSession } from '.././toolRegistrySupport.js';
import { resolveIndexedResourceFile } from '.././toolRegistrySupport.js';
import { TAE_COMPACT_PAGE_SIZE } from '../../editing/taeCompactEvent.js';
import { scanTaeExport, type TaeScanResult } from '../../editing/taeEdit.js';

// First pages of the best-ranked actions share this. It exceeds the largest measured compact page (29.3 KB), so
// the top action's first page is always delivered, and leaves room for the six items' metadata and the envelope
// inside the 64 KiB tool-result bound.
const SEARCH_EVENT_BUDGET_BYTES = 40_000;

// Native scans of files the index does not hold, by workspace and physical file, for this process. A scan is reused
// only while the file's sha256 is unchanged. Two entries bound the memory (a c0000 scan is ~74k events).
const SCAN_CACHE_ENTRIES = 2;
const scanCache = new Map<string, { sha256: string; scan: TaeScanResult }>();
const sha256Of = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

/** search_tae_events: one domain tool declaration, schema and handler. */
export function createSearchTaeEventsTool():RegisteredTool {
 return {
    name: 'search_tae_events',
    description: 'Search native TAE actions by any event field, type or address. A hit returns the action’s events in native order as '
      + `compact events (address, index, type, frames and times, decoded fields; hex only for undecoded bodies) in pages of ${TAE_COMPACT_PAGE_SIZE}. `
      + 'limit counts actions. The best-ranked actions get their whole first page within a shared budget; follow each action pagination.nextRead '
      + 'for its remaining pages and nextCursor for more actions. Without file it searches the workspace index (coverage "indexed-snapshot", '
      + 'only actions already read); with file (e.g. chr/c0000.anibnd.dcx) it scans that file natively (coverage "native-scan"; the first scan of '
      + 'a large file can take tens of seconds) and finds actions that were never read.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', file: 'string?', limit: 'safe-integer?', cursor: 'string?', offset: 'safe-integer?', pageSize: 'safe-integer?' },
    run: async (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      try {
        const pageSize = typeof value.pageSize === 'number' && Number.isSafeInteger(value.pageSize) && value.pageSize > 0
          ? Math.min(TAE_COMPACT_PAGE_SIZE, value.pageSize) : TAE_COMPACT_PAGE_SIZE;
        const compact = { pageSize, budgetBytes: SEARCH_EVENT_BUDGET_BYTES };
        let scanned: { file: string; scan: TaeScanResult; cached: boolean } | undefined;
        if (value.file !== undefined) {
          const file = asString(value.file).trim();
          if (!file) return fail('INVALID_INPUT', 'search_tae_events 的 file 必须是非空文件。');
          const edit = requireEditSession(context, 'read');
          if (!('session' in edit)) return edit;
          const resolvedFile = resolveIndexedResourceFile(context, file, 'chr');
          if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
          const nativePath = nativePathFromFileToken(resolvedFile.path);
          const key = `${ws.workspaceId}\0${nativePath}`, sha256 = await sha256Of(nativePath).catch(() => undefined);
          const hit = sha256 === undefined ? undefined : scanCache.get(key);
          if (hit && hit.sha256 === sha256) {
            scanCache.delete(key); scanCache.set(key, hit);
            scanned = { file, scan: hit.scan, cached: true };
          } else {
            const started = Date.now();
            context.onDiagnostic?.({ phase: 'tae-native-scan', status: 'start' });
            const scan = await scanTaeExport({ edit: edit.session, file: nativePath, ...(context.signal ? { signal: context.signal } : {}),
              sourceUri: resolvedFile.canonical === true ? resolvedFile.sourceUri : pathToFileURL(nativePath).href,
              onPage: progress => context.onDiagnostic?.({ phase: 'tae-native-scan', status: 'progress', elapsedMs: Date.now() - started, details: progress }) });
            if (!scan.ok) {
              context.onDiagnostic?.({ phase: 'tae-native-scan', status: 'failed', elapsedMs: Date.now() - started });
              return fail(scan.error.code, scan.error.message, scan.diagnostics);
            }
            context.onDiagnostic?.({ phase: 'tae-native-scan', status: 'complete', elapsedMs: Date.now() - started, details: scan.stats });
            // A file that changed while it was scanned is not cached; the Bridge versions inside the scan already agree.
            if (sha256 !== undefined && await sha256Of(nativePath).catch(() => undefined) === sha256) {
              scanCache.delete(key); scanCache.set(key, { sha256, scan });
              while (scanCache.size > SCAN_CACHE_ENTRIES) scanCache.delete(scanCache.keys().next().value!);
            }
            scanned = { file, scan, cached: false };
          }
        }
        const sources: readonly TaeExport[] | undefined = scanned ? [scanned.scan.export] : undefined;
        const page = boundedContentSearchPage({tool:'search_tae_events',workspaceId:ws.workspaceId,input:value,
          // A scan cursor is bound to its file: following it without that file is a provider mismatch, not an index search.
          provider:scanned ? `tae-native-scan-v1:${scanned.scan.export.sourceUri}` : 'indexed-tae-actions-compact-v2',
          readPage:(query,window)=>sources ? ws.searchTaeActionGroupsPageIn(sources,query,{...window,compact})
            : ws.searchTaeActionGroupsPage(query,{...window,compact})});
        if (page.total > 0 || value.cursor !== undefined || scanned) return ok({ ...page,
          ...(scanned ? { coverage: 'native-scan' as const, scan: { ...scanned.scan.stats, cached: scanned.cached },
            nextActions: page.nextActions.map(action => ({ ...action, args: { ...action.args, file: scanned!.file } })) } : {}),
          matches: page.matches.map((match) => {
            const item = match.item;
            const size = item.eventPageSize;
            const events = item.events;
            const totalCount = item.eventCount ?? null;
            const complete = item.eventsComplete === true;
            // A delivered preview is exactly the first fixed-size page (or the whole action), so the continuation
            // starts on a page boundary and read_tae_events numbers the following pages the same way.
            return { ...match, item: { ...item, events,
              pagination: { totalCount, returnedCount: events.length, offset: 0, pageSize: size,
                pageNumber: complete || events.length > 0 ? 1 : null,
                totalPages: totalCount === null ? null : Math.max(1, Math.ceil(totalCount / size)), hasMore: !complete,
                ...(complete ? {} : { nextRead: { tool: 'read_tae_events', args: {
                  file: item.sourceUri, addresses: [item.address], projection: 'compact', offset: events.length, pageSize: size,
                  ...(item.sourceHash ? { expectedSourceHash: item.sourceHash } : {}),
                  ...(item.readerSchemaRevision === undefined ? {} : { expectedReaderSchemaRevision: item.readerSchemaRevision }) } } }) } } };
          }) });
        return ragSearchFallback(context, page.query, ['tae_event'], page.limit, 'search_tae_events');
      } catch (error) {
        return fail((error as { code?: string }).code ?? 'TAE_SEARCH_FAILED', error instanceof Error ? error.message : '动作搜索失败。');
      }
    }
  };
}
