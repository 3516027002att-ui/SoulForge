import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, fail, ok, ragSearchFallback } from '../toolRegistrySupport.js';
import { contentSearchPage } from '.././contentSearchPage.js';
/** search_text_entries: one domain tool declaration, schema and handler. */
export function createSearchTextEntriesTool(): RegisteredTool {
    return {
        name: 'search_text_entries',
        description: 'Search parsed MSG/FMG text entries by visible text or text id. '
            + 'Use this in parallel with search_param_rows when resolving a character or item; '
            + 'textId is not automatically a PARAM rowId.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { query: 'string?', limit: 'safe-integer?', offset: 'safe-integer?', cursor: 'string?' },
        run: (input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const value = asRecord(input);
            try {
                const page = contentSearchPage({
                    tool: 'search_text_entries', workspaceId: ws.workspaceId, input: value,
                    search: (query) => ws.searchTextEntries(query, Number.MAX_SAFE_INTEGER),
                    fingerprint: ({ item, score }) => [item.uri, score, item.text, item.sourceHash, item.outerFileHash, item.sourceRevision]
                });
                return page.total > 0 || value.cursor !== undefined
                    ? ok(page)
                    : ragSearchFallback(context, page.query, ['text_entry'], page.limit, 'search_text_entries');
            }
            catch (error) {
                return fail((error as {
                    code?: string;
                }).code ?? 'CONTENT_SEARCH_FAILED', error instanceof Error ? error.message : '文本搜索失败。');
            }
        }
    };
}
