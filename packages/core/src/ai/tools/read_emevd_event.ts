import type { RegisteredTool } from '../toolRegistry.js';
import type { EmevdEventReadFormat } from '../toolRegistrySupport.js';
import { asRecord, asString, fail, nativePathFromFileToken, ok, requireEditSession, resolveIndexedResourceFile, resolveReadEmevdEvent } from '../toolRegistrySupport.js';
/** read_emevd_event: one domain tool declaration, schema and handler. */
export function createReadEmevdEventTool(): RegisteredTool {
    return {
        name: 'read_emevd_event',
        description: 'Read exactly one EMEVD event through the native core readEmevdEvent authority. '
            + 'A complete format=darkscript read from instructionOffset=0 through the native total returns data.record.projection=complete_native_dsl: '
            + 'the full DarkScript, native evidence/provenance and native identity are retained while auxiliary machine DTO is omitted; this is the only event read view that can mint a write receipt. '
            + 'Use format=json or instructionOffset/instructionLimit paging when machine instructions are needed, but JSON, tail, partial, or incomplete windows remain inspect-only and cannot authorize event writes. '
            + 'If file does not directly match an indexed sourceUri/sourcePath/relativePath/absolutePath, the native read may still succeed as inspect-only and cannot mint a write receipt; use search_events to obtain the complete sourceUri and reread. '
            + 'It never uses RAG or an index projection as a native-read substitute. format defaults to darkscript.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            file: 'string',
            eventId: 'safe-integer',
            format: 'enum:darkscript|json?',
            instructionOffset: 'safe-integer?',
            instructionLimit: 'safe-integer?',
            cursor: 'string?'
        },
        run: async (input, context) => {
            const value = asRecord(input);
            const file = asString(value.file).trim();
            const eventId = typeof value.eventId === 'number' && Number.isSafeInteger(value.eventId)
                ? value.eventId
                : undefined;
            if (!file || eventId === undefined) {
                return fail('INVALID_INPUT', 'read_emevd_event 需要 file 与安全整数 eventId。');
            }
            if (!context.session)
                return fail('WORKSPACE_REQUIRED', '这次原生 EMEVD 事件读取需要先打开 Mod 工作区。');
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
            const nativeFile = context.hostResolvedEmevdEventTarget?.sourcePath
                ?? nativePathFromFileToken(resolvedFile.path);
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const reader = resolveReadEmevdEvent();
            if (!reader) {
                return fail('EMEVD_EVENT_READ_UNAVAILABLE', '当前核心尚未提供 readEmevdEvent 原生事件读取门面，已拒绝用索引或 RAG 结果冒充 native read。', { authority: 'core.readEmevdEvent', file, eventId });
            }
            const format = value.format === undefined ? undefined : value.format as EmevdEventReadFormat;
            const instructionOffset = value.instructionOffset === undefined
                ? undefined
                : typeof value.instructionOffset === 'number' && Number.isSafeInteger(value.instructionOffset)
                    ? value.instructionOffset
                    : undefined;
            const instructionLimit = value.instructionLimit === undefined
                ? undefined
                : typeof value.instructionLimit === 'number' && Number.isSafeInteger(value.instructionLimit)
                    ? value.instructionLimit
                    : undefined;
            if (value.instructionOffset !== undefined && instructionOffset === undefined) {
                return fail('INVALID_INPUT', 'instructionOffset 必须是安全整数。');
            }
            if (value.instructionLimit !== undefined && instructionLimit === undefined) {
                return fail('INVALID_INPUT', 'instructionLimit 必须是安全整数。');
            }
            const result = await reader({
                edit: edit.session,
                file: nativeFile,
                eventId,
                ...(format ? { format } : {}),
                ...(instructionOffset !== undefined ? { instructionOffset } : {}),
                ...(instructionLimit !== undefined ? { instructionLimit } : {}),
                ...(context.signal ? { signal: context.signal } : {})
            });
            if (!result.ok) {
                const error = asRecord(result.error);
                return fail(asString(error.code, 'EMEVD_EVENT_READ_FAILED'), asString(error.message, 'EMEVD 事件读取失败。'), result.diagnostics);
            }
            const resultRecord = result as Record<string, unknown>;
            // Bind the model-facing/native receipt to the workspace-indexed URI.
            // The facade's URI is derived from its physical path and may otherwise
            // contain a sanitized-but-user-specific path rather than the canonical
            // resource identity used by search_events.
            const canonicalSourceUri = context.hostResolvedEmevdEventTarget?.sourceUri
                ?? resolvedFile.sourceUri;
            const provenance = {
                ...(asRecord(resultRecord.provenance)),
                authority: 'native-emevd-event',
                sourceUri: canonicalSourceUri,
                ...(typeof resultRecord.sourceHash === 'string' ? { sourceHash: resultRecord.sourceHash } : {}),
                ...(typeof resultRecord.sourceRevision === 'number' || typeof resultRecord.sourceRevision === 'string'
                    ? { sourceRevision: resultRecord.sourceRevision }
                    : {}),
                ...(typeof resultRecord.registryFingerprint === 'string'
                    ? { registryFingerprint: resultRecord.registryFingerprint }
                    : {})
            };
            return ok({ ...resultRecord, sourceUri: canonicalSourceUri, provenance });
        }
    };
}
