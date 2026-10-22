import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, asString, fail, finalizeEmevdDslApplyResult, nativePathFromFileToken, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import * as emevdEdit from '../../editing/emevdEdit.js';
/** apply_emevd_dsl: one domain tool declaration, schema and handler. */
export function createApplyEmevdDslTool(): RegisteredTool {
    return {
        name: 'apply_emevd_dsl',
        description: 'Compile and commit EMEVD DSL through the native Bridge four-view path. '
            + '完整文件模式 scope=file 可提交文件内 DSL；event-only 模式 scope=event 必须同时给出安全整数 eventId，核心只允许该事件作用域，禁止误删其他事件。'
            + ' event-scope 还必须回传最近一次完整 read_emevd_event 的 sourceHash、outerFileHash、sourceRevision 与 darkScriptComplete=true；读取必须是 offset=0 到 native total 的完整 darkscript 事件视图，底层会做 source identity CAS。JSON、tail、分页或缺少任一 identity 字段都不能写回。'
            + ' The DSL is not a binary text patch; unknown/ambiguous parameter bindings and invalid scope inputs fail closed.',
        permission: 'commit',
        permissionLevel: 'commit',
        inputSchema: {
            file: 'string',
            dsl: 'string',
            mode: 'enum:patch|dark-script?',
            eventId: 'safe-integer?',
            scope: 'enum:file|event?',
            sourceHash: 'string?',
            outerFileHash: 'string?',
            sourceRevision: 'number?',
            darkScriptComplete: 'boolean?'
        },
        run: async (input, context) => {
            const value = asRecord(input);
            if (value.emedfPath !== undefined || value.emedfLocator !== undefined) {
                return fail('EMEVD_EXTERNAL_SCHEMA_FORBIDDEN', '生产 EMEVD 链不接受外部 EMEDF schema；请使用 SoulForge 内置 schema。');
            }
            const file = asString(value.file).trim();
            const dsl = asString(value.dsl);
            if (!file || !dsl.trim())
                return fail('INVALID_INPUT', 'apply_emevd_dsl 需要 file 与非空 dsl。');
            const scope = value.scope === undefined ? 'file' : value.scope as 'file' | 'event';
            const eventId = value.eventId;
            const safeEventId = typeof eventId === 'number' && Number.isSafeInteger(eventId) ? eventId : undefined;
            if (eventId !== undefined && safeEventId === undefined) {
                return fail('INVALID_INPUT', 'apply_emevd_dsl 的 eventId 必须是安全整数。');
            }
            if (scope === 'event' && safeEventId === undefined) {
                return fail('INVALID_INPUT', 'apply_emevd_dsl 的 scope=event 必须同时提供 eventId。');
            }
            if (scope === 'file' && safeEventId !== undefined) {
                return fail('INVALID_INPUT', 'apply_emevd_dsl 的完整文件模式不能带 eventId；请使用 scope=event。');
            }
            const sourceHash = asOptionalString(value.sourceHash);
            const outerFileHash = asOptionalString(value.outerFileHash);
            const sourceRevision = value.sourceRevision === undefined
                ? undefined
                : asNumber(value.sourceRevision, Number.NaN);
            const darkScriptComplete = value.darkScriptComplete === undefined
                ? undefined
                : typeof value.darkScriptComplete === 'boolean'
                    ? value.darkScriptComplete
                    : undefined;
            if (value.sourceHash !== undefined && sourceHash === undefined) {
                return fail('INVALID_INPUT', 'apply_emevd_dsl 的 sourceHash 必须是非空字符串。');
            }
            if (value.outerFileHash !== undefined && outerFileHash === undefined) {
                return fail('INVALID_INPUT', 'apply_emevd_dsl 的 outerFileHash 必须是非空字符串。');
            }
            if (value.darkScriptComplete !== undefined && darkScriptComplete === undefined) {
                return fail('INVALID_INPUT', 'apply_emevd_dsl 的 darkScriptComplete 必须是布尔值。');
            }
            if (scope === 'event' && (sourceHash === undefined
                || outerFileHash === undefined
                || sourceRevision === undefined
                || !Number.isFinite(sourceRevision)
                || darkScriptComplete !== true)) {
                return fail('EMEVD_DSL_READ_RECEIPT_REQUIRED', `event-scope 写回必须携带最近一次完整 read_emevd_event 的 sourceHash、outerFileHash、sourceRevision 与 darkScriptComplete=true；当前缺少或不满足：${[
                    sourceHash === undefined ? 'sourceHash' : null,
                    outerFileHash === undefined ? 'outerFileHash' : null,
                    sourceRevision === undefined || !Number.isFinite(sourceRevision) ? 'sourceRevision' : null,
                    darkScriptComplete !== true ? 'darkScriptComplete=true' : null
                ].filter((item): item is string => item !== null).join('、') || '完整 native DarkScript 视图'}。`);
            }
            const edit = requireEditSession(context, 'write');
            if (!('session' in edit))
                return edit;
            const resolvedFile = context.hostResolvedEmevdEventTarget
                ? {
                    ok: true as const,
                    path: context.hostResolvedEmevdEventTarget.sourcePath,
                    sourceUri: context.hostResolvedEmevdEventTarget.sourceUri,
                    canonical: context.hostResolvedEmevdEventTarget.canonical
                }
                : resolveIndexedResourceFile(context, file, 'event');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const mode = value.mode === 'dark-script' ? 'dark-script' : 'patch';
            const applyInput: Parameters<typeof emevdEdit.applyEmevdDsl>[0] = {
                edit: edit.session,
                file: context.hostResolvedEmevdEventTarget?.sourcePath
                    ?? nativePathFromFileToken(resolvedFile.path),
                dsl,
                mode,
                ...(safeEventId === undefined ? {} : { eventId: safeEventId }),
                ...(scope === 'event' && safeEventId !== undefined
                    ? { scope: { eventId: safeEventId } }
                    : {}),
                ...(sourceHash ? { sourceHash } : {}),
                ...(outerFileHash ? { outerFileHash } : {}),
                ...(sourceRevision !== undefined ? { sourceRevision } : {}),
                ...(darkScriptComplete !== undefined ? { darkScriptComplete } : {})
            };
            const result = await emevdEdit.applyEmevdDsl(applyInput);
            // 编辑层回吐物理绝对路径；回执面向模型，只给逻辑 sourceUri
            //（mutate_param_fields 同类问题已同法治）。
            const modelResult = (result.ok || result.transactionStatus === 'committed') && resolvedFile.ok
                ? {
                    ...result,
                    ...(typeof (result as {
                        filePath?: unknown;
                    }).filePath === 'string'
                        ? { filePath: resolvedFile.sourceUri } : {}),
                    ...((result as {
                        committedPath?: unknown;
                    }).committedPath !== undefined
                        ? { committedPath: resolvedFile.sourceUri } : {})
                }
                : result;
            return finalizeEmevdDslApplyResult(modelResult, file, context);
        }
    };
}
