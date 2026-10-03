import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord } from '.././toolRegistrySupport.js';
import { asString } from '.././toolRegistrySupport.js';
import { fail } from '.././toolRegistrySupport.js';
import { nativePathFromFileToken } from '.././toolRegistrySupport.js';
import { ok } from '.././toolRegistrySupport.js';
import { readTaeEvents } from '../../editing/taeEdit.js';
import { requireEditSession } from '.././toolRegistrySupport.js';
import { resolveIndexedResourceFile } from '.././toolRegistrySupport.js';

/** analyze_tae_structure: one domain tool declaration, schema and handler. */
export function createAnalyzeTaeStructureTool():RegisteredTool {
 return {
        name: 'analyze_tae_structure',
        description: 'Read native TAE structure with section/animation/event identity, raw unknown-event preservation and layered '
            + 'evidence. It does not infer an action-to-AtkParam/Bullet chain or runtime behavior from timing/name similarity.',
        permission: 'analyze',
        permissionLevel: 'analyze',
        inputSchema: { file: 'string', cursor: 'string?', pageSize: 'number?' },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            if (!file)
                return fail('INVALID_INPUT', 'analyze_tae_structure 需要 file。');
            const resolvedFile = resolveIndexedResourceFile(context, file, 'chr');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const result = await readTaeEvents({
                edit: edit.session,
                file: nativePathFromFileToken(resolvedFile.path),
                ...(typeof value.cursor === 'string' ? { cursor: value.cursor.trim() } : {}),
                ...(typeof value.pageSize === 'number' ? { pageSize: Math.trunc(value.pageSize) } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            const unknownEvents = result.events.filter((event) => event.decodeStatus !== 'decoded');
            return ok({
                ...result,
                evidenceLayers: {
                    resource: 'native-read',
                    relation: 'section-animation-event-index',
                    logic: unknownEvents.length > 0 ? 'partial-unknown-events' : 'decoded-fields-only',
                    runtime: 'not-run'
                },
                actionChain: {
                    status: 'insufficient_evidence',
                    reason: '当前没有足够证据把招式分支闭合到 Behavior/AtkParam/Bullet；禁止用最大行号、最后时间轴事件或名称相似度代替身份。'
                },
                unknownEvents: unknownEvents.map((event) => ({
                    address: event.address,
                    eventTypeId: event.eventTypeId,
                    raw: event.raw ?? { eventTypeId: event.eventTypeId, startTime: event.startTime, endTime: event.endTime, ...(event.parameterBytesHex ? { parameterBytesHex: event.parameterBytesHex } : {}) }
                }))
            });
        }
    };
}
