import type { RegisteredTool } from '../toolRegistry.js';
import { asOptionalString, asRecord, asString, fail, ok } from '../toolRegistrySupport.js';
/** write_memory: one domain tool declaration, schema and handler. */
export function createWriteMemoryTool(): RegisteredTool {
    return {
        name: 'write_memory',
        proofPolicy: 'none',
        description: 'Store or update a persistent long-term memory entry (topic, summary, details, tags) across sessions.',
        permission: 'propose',
        permissionLevel: 'propose',
        inputSchema: { topic: 'string', summary: 'string', details: 'string?', tags: 'array?' },
        run: (input, context) => {
            if (context.allowMemoryWrite === false) {
                return fail('AGENT_MEMORY_WRITE_FORBIDDEN', 'Agent 运行禁止写入长期记忆。');
            }
            const store = context.memoryStore;
            if (!store)
                return fail('MEMORY_STORE_REQUIRED', '宿主未提供持久记忆存储，拒绝伪装为已保存。');
            const value = asRecord(input);
            const topic = asString(value.topic).trim();
            const summary = asString(value.summary).trim();
            if (!topic || !summary) {
                return fail('INVALID_INPUT', 'write_memory requires non-empty topic and summary.');
            }
            const details = asOptionalString(value.details);
            const tags = Array.isArray(value.tags) ? value.tags.map(String).filter(Boolean) : [];
            const saved = store.save({ topic, summary, ...(details ? { details } : {}), tags });
            return ok({ saved: true, entry: saved });
        }
    };
}
