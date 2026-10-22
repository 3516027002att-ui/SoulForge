import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asRecord, asString, fail, ok } from '../toolRegistrySupport.js';
import { EVENT_REFERENCE_SOURCE_URI, searchEventReference } from '.././eventReference.js';
/** search_event_reference: one domain tool declaration, schema and handler. */
export function createSearchEventReferenceTool(): RegisteredTool {
    return {
        name: 'search_event_reference',
        description: 'Search the community-maintained Sekiro event-experience glossary by Chinese behavior, English instruction '
            + 'name, or alias. This is a non-authoritative reference map: it guides semantic planning but never proves an instruction exists '
            + 'in the current EMEVD. Always follow with search_events and read_emevd_event using the returned names, '
            + 'file, eventId, and native source evidence.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { query: 'string', limit: 'number?' },
        run: (input) => {
            const value = asRecord(input);
            const query = asString(value.query, '').trim();
            if (!query)
                return fail('INVALID_INPUT', 'search_event_reference 需要非空 query。');
            const matches = searchEventReference(query, asNumber(value.limit, 20));
            return ok({
                query,
                sourceUri: EVENT_REFERENCE_SOURCE_URI,
                authority: 'community-reference',
                totalHits: matches.length,
                matches,
                note: '社区经验用于语义定位和方案组织；当前事件号、指令签名、参数和写入身份必须由 native EMEVD/EMEDF 复核。'
            });
        }
    };
}
