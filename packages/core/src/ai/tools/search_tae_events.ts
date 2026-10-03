import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord } from '.././toolRegistrySupport.js';
import { contentSearchPage } from '.././contentSearchPage.js';
import { fail } from '.././toolRegistrySupport.js';
import { ok } from '.././toolRegistrySupport.js';
import { ragSearchFallback } from '.././toolRegistrySupport.js';

/** search_tae_events: one domain tool declaration, schema and handler. */
export function createSearchTaeEventsTool():RegisteredTool {
 return {
    name: 'search_tae_events',
    description: 'Search native TAE actions by any event field, type or address. A hit returns the action’s sibling events in native order. '
      + 'limit counts actions. Follow nextCursor for more actions and each action pagination.nextRead for remaining events.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', limit: 'safe-integer?', cursor: 'string?', offset: 'safe-integer?', pageSize: 'safe-integer?' },
    run: async (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      try {
        const page = contentSearchPage({ tool: 'search_tae_events', workspaceId: ws.workspaceId, input: value,
          search: (query) => ws.searchTaeActionGroups(query, Number.MAX_SAFE_INTEGER),
          fingerprint: (match) => [match.item.sourceUri, match.item.address, match.item.sourceHash, match.item.sourceRevision, match.item.events] });
        const pageSize = typeof value.pageSize === 'number' && Number.isSafeInteger(value.pageSize) && value.pageSize > 0
          ? Math.min(128, value.pageSize) : 16;
        if (page.total > 0 || value.cursor !== undefined) return ok({ ...page,
          matches: page.matches.map((match) => {
            const item = match.item;
            const maximumBytes = Math.max(1, ...item.events.map((event) => Buffer.byteLength(JSON.stringify(event), 'utf8')));
            const size = Math.max(1, Math.min(pageSize, Math.floor(20000 / maximumBytes)));
            const events = item.events.slice(0, size);
            const totalCount = item.eventCount ?? null;
            const complete = item.eventsComplete === true;
            const hasMore = !complete || events.length < (totalCount ?? item.events.length);
            const prefix = events.every((event, index) => event.index === index);
            return { ...match, item: { ...item, events,
              pagination: { totalCount, returnedCount: events.length, offset: 0,
                pageNumber: 1, totalPages: totalCount === null ? null : Math.ceil(totalCount / size), hasMore,
                ...(hasMore ? { nextRead: { tool: 'read_tae_events', args: {
                  file: item.sourceUri, addresses: [item.address], offset: prefix ? events.length : 0, pageSize: size,
                  ...(item.sourceHash ? { expectedSourceHash: item.sourceHash } : {}),
                  ...(item.readerSchemaRevision === undefined ? {} : { expectedReaderSchemaRevision: item.readerSchemaRevision }) } } } : {}) } } };
          }) });
        return ragSearchFallback(context, page.query, ['tae_event'], page.limit, 'search_tae_events');
      } catch (error) {
        return fail((error as { code?: string }).code ?? 'TAE_SEARCH_FAILED', error instanceof Error ? error.message : '动作搜索失败。');
      }
    }
  };
}
