import type { RegisteredTool } from '../toolRegistry.js';
import { fail, ok } from '../toolRegistrySupport.js';
/** list_memories: one domain tool declaration, schema and handler. */
export function createListMemoriesTool(): RegisteredTool {
    return {
        name: 'list_memories',
        description: 'List all topics and summaries stored in the long-term memory system.',
        permission: 'read',
        permissionLevel: 'read',
        run: (_input, context) => {
            const store = context.memoryStore;
            if (!store)
                return fail('MEMORY_STORE_REQUIRED', '宿主未提供持久记忆存储，拒绝返回临时空列表。');
            const list = store.list();
            return ok({ count: list.length, topics: list.map((e) => ({ id: e.id, topic: e.topic, summary: e.summary, updatedAt: e.updatedAt })) });
        }
    };
}
