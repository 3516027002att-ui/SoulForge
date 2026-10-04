import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord } from '.././toolRegistrySupport.js';
import { asString } from '.././toolRegistrySupport.js';
import { asTaeFieldEdits } from '.././toolRegistrySupport.js';
import { fail } from '.././toolRegistrySupport.js';
import { finalizeCommittedToolResult } from '.././toolRegistrySupport.js';
import { requireEditSession } from '.././toolRegistrySupport.js';
import { setTaeEventFields } from '../../editing/taeEdit.js';
import {parseActionAddress} from '@soulforge/shared';

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
                const address = parseActionAddress(edit.address);
                if (!address || address.animId === undefined || address.eventIndex === undefined) {
                    return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 字段写入工具只能接收 TAE 动作事件地址：${edit.address}`);
                }
            }
            const session = requireEditSession(context, 'write');
            if (!('session' in session))
                return session;
            const result = await setTaeEventFields({ edit: session.session, file, edits: edits.edits });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath], context,
                verifyNative: async () => result.nativeVerified ? { ok: true, details: { addresses: result.after.map(event => event.address) } }
                    : { ok: false, code: 'TAE_FIELD_READBACK_FAILED', message: '写入已提交，但原生字段回读未验证；请按 opId 查询或回滚，禁止自动重放。', details: result.diagnostics } });
        }
    };
}
