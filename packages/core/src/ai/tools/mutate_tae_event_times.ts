import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord } from '.././toolRegistrySupport.js';
import { asString } from '.././toolRegistrySupport.js';
import { asTaeTimeEdits } from '.././toolRegistrySupport.js';
import { fail } from '.././toolRegistrySupport.js';
import { finalizeCommittedToolResult } from '.././toolRegistrySupport.js';
import { requireEditSession } from '.././toolRegistrySupport.js';
import { setTaeEventTimes } from '../../editing/taeEdit.js';
import {parseActionAddress} from '@soulforge/shared';

/** mutate_tae_event_times: one domain tool declaration, schema and handler. */
export function createMutateTaeEventTimesTool():RegisteredTool {
 return {
        name: 'mutate_tae_event_times',
        description: 'Set TAE event start/end frames by exact action address through Patch Engine. '
            + 'Ambiguous or missing native events fail closed; no filename or array-index guessing.',
        permission: 'commit',
        permissionLevel: 'commit',
        inputSchema: { file: 'string', edits: 'array' },
        run: async (input, context) => {
            const value = asRecord(input);
            if (value.domain && value.domain !== 'tae') {
                return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 写入工具不能接收 ${value.domain} 领域的请求。`);
            }
            if (value.fieldKind && value.fieldKind !== 'native_value') {
                return fail('FIELD_KIND_NON_NATIVE', `${value.fieldKind} 不是原生字段类型，不能写入 TAE。`);
            }
            const file = asString(value.file);
            const edits = asTaeTimeEdits(value.edits);
            if (!file)
                return fail('INVALID_INPUT', 'mutate_tae_event_times 需要 file。');
            if (!edits.ok)
                return fail(edits.code, edits.message);
            for (const e of edits.edits) {
                const address = parseActionAddress(e.address);
                if (!address || address.animId === undefined || address.eventIndex === undefined) {
                    return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 写入工具只能接收 TAE 动作事件地址（如 cXXXX#AXXXX.eN），不能接收地图或其它领域地址：${e.address}`);
                }
                const record = e as unknown as Record<string, unknown>;
                if (record.valueKind === 'display_label' || record.valueKind === 'external_metadata') {
                    return fail('FIELD_KIND_NON_NATIVE', 'display_label / external_metadata 不能作为 TAE 原生时间写入。');
                }
            }
            const edit = requireEditSession(context, 'write');
            if (!('session' in edit))
                return edit;
            const result = await setTaeEventTimes({ edit: edit.session, file, edits: edits.edits });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath], context,
                verifyNative: async () => result.nativeVerified ? { ok: true, details: { addresses: result.after.map(event => event.address) } }
                    : { ok: false, code: 'TAE_TIME_READBACK_FAILED', message: '写入已提交，但原生时间回读未验证；请按 opId 查询或回滚，禁止自动重放。', details: result.diagnostics } });
        }
    };
}
