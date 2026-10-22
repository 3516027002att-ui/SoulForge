import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord } from '.././toolRegistrySupport.js';
import { boundedContentSearchPage } from '../boundedContentSearchPage.js';
import { fail } from '.././toolRegistrySupport.js';
import { ok } from '.././toolRegistrySupport.js';
import { ragSearchFallback } from '.././toolRegistrySupport.js';
import { TAE_COMPACT_PAGE_SIZE } from '../../editing/taeCompactEvent.js';

// First pages of the best-ranked actions share this. It exceeds the largest measured compact page (29.3 KB), so
// the top action's first page is always delivered, and leaves room for the six items' metadata and the envelope
// inside the 64 KiB tool-result bound.
const SEARCH_EVENT_BUDGET_BYTES = 40_000;

/** search_tae_events: one domain tool declaration, schema and handler. */
export function createSearchTaeEventsTool():RegisteredTool {
 return {
    name: 'search_tae_events',
    description: 'Search native TAE actions by any event field, type or address. A hit returns the action’s events in native order as '
      + `compact events (address, index, type, frames and times, decoded fields; hex only for undecoded bodies) in pages of ${TAE_COMPACT_PAGE_SIZE}. `
      + 'limit counts actions. The best-ranked actions get their whole first page within a shared budget; follow each action pagination.nextRead '
      + 'for its remaining pages and nextCursor for more actions.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', limit: 'safe-integer?', cursor: 'string?', offset: 'safe-integer?', pageSize: 'safe-integer?' },
    run: async (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      try {
        const pageSize = typeof value.pageSize === 'number' && Number.isSafeInteger(value.pageSize) && value.pageSize > 0
          ? Math.min(TAE_COMPACT_PAGE_SIZE, value.pageSize) : TAE_COMPACT_PAGE_SIZE;
        const page = boundedContentSearchPage({tool:'search_tae_events',workspaceId:ws.workspaceId,input:value,
          provider:'indexed-tae-actions-compact-v2',
          readPage:(query,window)=>ws.searchTaeActionGroupsPage(query,{...window,compact:{pageSize,budgetBytes:SEARCH_EVENT_BUDGET_BYTES}})});
        if (page.total > 0 || value.cursor !== undefined) return ok({ ...page,
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
