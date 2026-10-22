import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asString, fail, nativePathFromFileToken, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import * as emevdEdit from '../../editing/emevdEdit.js';
import { basename } from 'node:path';
/** read_emevd_outline: one domain tool declaration, schema and handler. */
export function createReadEmevdOutlineTool(): RegisteredTool {
    return {
        name: 'read_emevd_outline',
        description: 'Read event IDs and instruction counts from an overlay EMEVD file. '
            + 'Pass offset (default 0) and limit (default 8, maximum 16) to page through all events using nextOffset. '
            + 'The outline is read-only metadata, not a complete DarkScript write receipt. '
            + 'Does not parse a second native format; uses Bridge read-emevd-document.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { file: 'string', offset: 'safe-integer?', limit: 'safe-integer?' },
        run: async (input, context) => {
            const value = asRecord(input);
            const offset = value.offset ?? 0;
            const limit = value.limit ?? 8;
            if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
                || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
                return fail('INVALID_INPUT', 'read_emevd_outline 的 offset 必须是非负安全整数，limit 必须是 1 到 16 的安全整数。');
            }
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const file = asString(value.file);
            if (!file)
                return fail('INVALID_INPUT', 'read_emevd_outline 需要 file。');
            const resolvedFile = resolveIndexedResourceFile(context, file, 'event');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const result = await emevdEdit.readEmevdOutline({
                edit: edit.session,
                file: nativePathFromFileToken(resolvedFile.path)
            });
            if (!result.ok)
                return fail(result.error?.code ?? 'EMEVD_READ_FAILED', result.error?.message ?? '读取失败。');
            if (context.workspaceIndex && result.events) {
                const indexedFile = context.workspaceIndex.getFiles().find((candidate) => candidate.absolutePath === result.filePath);
                const sourceUri = indexedFile?.sourceUri ?? result.filePath ?? file;
                const sourceHash = result.sourceHash;
                const sourceRevision = indexedFile?.mtimeMs;
                const mapId = basename(sourceUri).replace(/\.emevd(?:\.dcx)?$/i, '');
                context.workspaceIndex.upsertEventExport({
                    mapId,
                    ...(sourceHash ? { sourceHash } : {}),
                    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
                    events: result.events.map((event) => ({
                        uri: `${sourceUri}#event/${event.eventId}`,
                        sourceUri,
                        mapId,
                        eventId: event.eventId,
                        ...(sourceHash ? { sourceHash } : {}),
                        ...(sourceRevision !== undefined ? { sourceRevision } : {}),
                        instructions: [],
                        raw: {
                            authority: 'native-read-outline',
                            instructionCount: event.instructionCount,
                            restBehavior: event.restBehavior,
                            semanticArgsDecoded: false
                        }
                    }))
                });
                context.workspaceIndex.rebuildReferences();
                await context.onSemanticEvidenceUpdated?.([sourceUri]);
            }
            // The index above always consumes the complete native outline. Only the
            // model-facing result is paged; no event disappears from future windows.
            const allEvents = result.events ?? [];
            const events = allEvents.slice(offset, offset + limit);
            const truncated = offset + events.length < allEvents.length;
            return ok({
                ...result,
                events,
                total: allEvents.length,
                totalCount: allEvents.length,
                offset,
                limit,
                returned: events.length,
                returnedCount: events.length,
                truncated,
                darkScriptComplete: false,
                ...(truncated ? {
                    nextOffset: offset + events.length,
                    continuationParams: { file, offset: offset + events.length, limit }
                } : {})
            });
        }
    };
}
