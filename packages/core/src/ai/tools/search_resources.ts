import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asResourceKinds, fail, ok } from '../toolRegistrySupport.js';
/** search_resources: one domain tool declaration, schema and handler. */
export function createSearchResourcesTool(): RegisteredTool {
    return {
        name: 'search_resources',
        description: 'Search indexed workspace files by path, extension, or resource kind. Returns total and an opaque nextCursor; follow nextActions. Recovery/backup artifacts are excluded unless sourceFilter=all or artifacts is explicit.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { query: 'string?', limit: 'safe-integer?', kinds: 'array?', cursor: 'string?', sourceFilter: 'enum:active|all|artifacts?' },
        run: (input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const value = asRecord(input);
            const kinds = asResourceKinds(value.kinds);
            try {
                const { items: _items, ...page } = ws.searchResourcesPage({
                    ...(typeof value.query === 'string' ? { query: value.query } : {}),
                    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
                    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
                    ...(typeof value.sourceFilter === 'string' ? { sourceFilter: value.sourceFilter as 'active' | 'all' | 'artifacts' } : {}),
                    ...(kinds ? { kinds } : {})
                });
                return ok(page);
            }
            catch (error) {
                return fail((error as {
                    code?: string;
                }).code ?? 'RESOURCE_SEARCH_FAILED', String(error));
            }
        }
    };
}
