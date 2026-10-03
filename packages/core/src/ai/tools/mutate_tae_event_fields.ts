import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord } from '.././toolRegistrySupport.js';
import { asString } from '.././toolRegistrySupport.js';
import { asTaeFieldEdits } from '.././toolRegistrySupport.js';
import { fail } from '.././toolRegistrySupport.js';
import { finalizeCommittedToolResult } from '.././toolRegistrySupport.js';
import { requireEditSession } from '.././toolRegistrySupport.js';
import { setTaeEventFields } from '../../editing/taeEdit.js';

/** mutate_tae_event_fields: one domain tool declaration, schema and handler. */
export function createMutateTaeEventFieldsTool():RegisteredTool {
 return {
        name: 'mutate_tae_event_fields',
        description: 'Set first-party decoded TAE event fields by exact action address through Patch Engine. '
            + 'Use fieldIndex for stable schema fields or fieldName for named fields; padding/assert fields are rejected.',
        permission: 'commit',
        permissionLevel: 'commit',
        inputSchema: { file: 'string', edits: 'array' },
        run: async (input, context) => {
            const value = asRecord(input);
            if (value.domain && value.domain !== 'tae') {
                return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 写入工具不能接收 ${value.domain} 领域的请求。`);
            }
            const file = asString(value.file);
            const edits = asTaeFieldEdits(value.edits);
            if (!file)
                return fail('INVALID_INPUT', 'mutate_tae_event_fields 需要 file。');
            if (!edits.ok)
                return fail(edits.code, edits.message);
            for (const edit of edits.edits) {
                if (/^m\d\d_/i.test(edit.address) || !/^[a-z0-9_]+#A/i.test(edit.address)) {
                    return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 字段写入工具只能接收 TAE 动作事件地址：${edit.address}`);
                }
            }
            const session = requireEditSession(context, 'write');
            if (!('session' in session))
                return session;
            const result = await setTaeEventFields({ edit: session.session, file, edits: edits.edits });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath], context });
        }
    };
}
