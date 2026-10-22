import type { RegisteredTool } from '../toolRegistry.js';
import { asFmgEdits, asOptionalString, asRecord, fail, finalizeCommittedToolResult, ok, requireEditSession } from '../toolRegistrySupport.js';
import { setFmgEntries } from '../../editing/fmgEdit.js';
/** mutate_fmg_entries: one domain tool declaration, schema and handler. */
export function createMutateFmgEntriesTool(): RegisteredTool {
    return {
        name: 'mutate_fmg_entries',
        description: 'Set FMG entry text through Patch Engine (write-fmg mutations[]). '
            + 'edits: [{ table, id, text }]. One table per call. Do not propose_text_patch on .fmg/.msgbnd.',
        permission: 'commit',
        permissionLevel: 'commit',
        inputSchema: {
            edits: 'array',
            containerPath: 'string?',
            lang: 'string?'
        },
        run: async (input, context) => {
            const value = asRecord(input);
            if (value.domain && value.domain !== 'fmg') {
                return fail('DOMAIN_CROSSOVER_REJECTED', `FMG 写入工具不能接收 ${value.domain} 领域的请求。`);
            }
            if (value.fieldKind && value.fieldKind !== 'native_value') {
                return fail('FIELD_KIND_NON_NATIVE', `${value.fieldKind} 不是原生字段类型，不能写入 FMG。`);
            }
            const edits = asFmgEdits(value.edits);
            if (!edits.ok)
                return fail(edits.code, edits.message);
            for (const e of edits.edits) {
                if (/^m\d\d_/i.test(e.table) || /^c\d\d/i.test(e.table) || /#c\d\d/i.test(e.table) || /#A\d\d/i.test(e.table)) {
                    return fail('DOMAIN_CROSSOVER_REJECTED', `FMG 写入工具不能接收地图或 TAE 目标：${e.table}`);
                }
                const record = e as unknown as Record<string, unknown>;
                if (record.valueKind === 'display_label' || record.fieldId === 'displayLabel') {
                    return fail('FIELD_KIND_NON_NATIVE', 'display_label 是界面显示标签，不能作为 FMG 原生文本写入。');
                }
                if (record.valueKind === 'external_metadata' || record.fieldId === 'externalMetadata') {
                    return fail('FIELD_KIND_NON_NATIVE', 'external_metadata 是外部元数据，不能作为 FMG 原生文本写入。');
                }
            }
            const edit = requireEditSession(context, 'write');
            if (!('session' in edit))
                return edit;
            const containerPath = asOptionalString(value.containerPath);
            const lang = asOptionalString(value.lang);
            const result = await setFmgEntries({
                edit: edit.session,
                edits: edits.edits,
                ...(containerPath ? { containerPath } : {}),
                ...(lang ? { lang } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.error.details);
            return finalizeCommittedToolResult({ data: result, changedSources: [result.containerPath], context });
        }
    };
}
