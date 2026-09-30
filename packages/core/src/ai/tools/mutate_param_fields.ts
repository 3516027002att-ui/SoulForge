import type { RegisteredTool } from '../toolRegistry.js';
import { asOptionalString, asParamEdits, asRecord, fail, finalizeCommittedToolResult, ok, requireEditSession, resolveIndexedResourceFile, verifyCommittedParamFields } from '../toolRegistrySupport.js';
import { setParamFields } from '../../param/containerParamEdit.js';
/** mutate_param_fields: one domain tool declaration, schema and handler. */
export function createMutateParamFieldsTool(): RegisteredTool {
    return {
        name: 'mutate_param_fields',
        description: 'Set absolute PARAM field values through Patch Engine (write-param + write-bnd4). '
            + 'edits: [{ table, rowId, rowIndex, fieldId, expectedDataHash, value }]; copy rowIndex and dataHash '
            + 'from the latest read when present, and pass the returned containerPath when available. Never multiply current values. '
            + 'Do not parse Smithbox XML, scan BND, or write file_replace by hand.',
        permission: 'commit',
        permissionLevel: 'commit',
        inputSchema: {
            edits: 'array',
            containerPath: 'string?'
        },
        run: async (input, context) => {
            const value = asRecord(input);
            if (value.domain && value.domain !== 'param') {
                return fail('DOMAIN_CROSSOVER_REJECTED', `PARAM 写入工具不能接收 ${value.domain} 领域的请求。`);
            }
            if (value.fieldKind && value.fieldKind !== 'native_value') {
                return fail('FIELD_KIND_NON_NATIVE', `${value.fieldKind} 不是原生字段类型，不能写入 PARAM。`);
            }
            const edits = asParamEdits(value.edits);
            if (!edits.ok)
                return fail(edits.code, edits.message);
            for (const e of edits.edits) {
                if (/^m\d\d_/i.test(e.table) || /^c\d\d/i.test(e.table) || /#A\d\d/i.test(e.table)) {
                    return fail('DOMAIN_CROSSOVER_REJECTED', `PARAM 写入工具不能接收地图或 TAE 目标：${e.table}`);
                }
                const record = e as unknown as Record<string, unknown>;
                if (record.valueKind === 'display_label' || record.valueKind === 'external_metadata') {
                    return fail('FIELD_KIND_NON_NATIVE', 'display_label / external_metadata 不能作为 PARAM 原生字段写入。');
                }
            }
            const edit = requireEditSession(context, 'write');
            if (!('session' in edit))
                return edit;
            const containerPath = asOptionalString(value.containerPath);
            const result = await setParamFields({
                edit: edit.session,
                edits: edits.edits,
                ...(containerPath ? { containerPath } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.error.details);
            if (result.changedTables.length === 0)
                return ok(result);
            // 编辑层返回的是物理绝对路径；面向模型的回执必须用逻辑 sourceUri，
            // 否则本机路径透出，且调用方无法把该 containerPath 直接用于下一次
            // read/mutate（工具描述要求传回可复用的 containerPath）。
            const resolvedContainer = resolveIndexedResourceFile(context, result.containerPath, 'param');
            const modelContainerPath = resolvedContainer.ok
                ? resolvedContainer.sourceUri
                : (containerPath ?? result.containerPath);
            return finalizeCommittedToolResult({
                data: { ...result, containerPath: modelContainerPath },
                changedSources: [result.containerPath],
                // Read proofs are keyed on the logical table name (the same value the
                // write requirement carries); the container path alone would leave the
                // stale per-table proofs usable after a commit.
                invalidateProofKeys: result.changedTables,
                context,
                verifyNative: () => verifyCommittedParamFields({
                    edit: edit.session,
                    edits: edits.edits,
                    expected: result.after,
                    containerPath: result.containerPath
                })
            });
        }
    };
}
