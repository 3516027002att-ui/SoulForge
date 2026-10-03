import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asRecord, asString, fail, ok, ragSearchFallback } from '../toolRegistrySupport.js';
/** search_map_entities: one domain tool declaration, schema and handler. */
export function createSearchMapEntitiesTool(): RegisteredTool {
    return {
        name: 'search_map_entities',
        description: 'Search parsed map entities and regions.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { query: 'string', limit: 'number?' },
        run: (input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const value = asRecord(input);
            const query = asString(value.query, '');
            const limit = asNumber(value.limit, 50);
            const nativeResults = ws.searchMapEntities(query, limit);
            return nativeResults.length > 0
                ? ok(nativeResults)
                : ragSearchFallback(context, query, ['map_entity', 'map_region'], limit, 'search_map_entities');
        }
    };
}
