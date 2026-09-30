import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, fail, ok } from '../toolRegistrySupport.js';
/** read_memory: one domain tool declaration, schema and handler. */
export function createReadMemoryTool(): RegisteredTool {
    return {
        name: 'read_memory',
        description: 'Read or search long-term memory entries by topic/query, or retrieve all project memories if query is omitted.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { query: 'string?', limit: 'number?' },
        run: (input, context) => {
            const store = context.memoryStore;
            if (!store)
                return fail('MEMORY_STORE_REQUIRED', '宿主未提供持久记忆存储，拒绝伪装为已读取。');
            const value = asRecord(input);
            const query = asOptionalString(value.query);
            const limit = asNumber(value.limit, 10);
            if (query) {
                const results = store.search(query, limit);
                return ok({ query, count: results.length, entries: results });
            }
            const all = store.list().slice(0, limit);
            return ok({ count: all.length, entries: all });
        }
    };
}
