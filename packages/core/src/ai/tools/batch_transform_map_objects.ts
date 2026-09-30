import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asString, asStringList, fail, finalizeCommittedToolResult, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { batchTransformMapParts } from '../../editing/mapService.js';
/** batch_transform_map_objects: one domain tool declaration, schema and handler. */
export function createBatchTransformMapObjectsTool(): RegisteredTool {
    return {
        name: 'batch_transform_map_objects',
        description: 'Batch transform multiple map parts (translate, rotate, scale) in a single atomic transaction through Patch Engine.',
        permission: 'commit',
        permissionLevel: 'commit',
        inputSchema: {
            file: 'string',
            targets: 'array',
            deltaX: 'number?',
            deltaY: 'number?',
            deltaZ: 'number?',
            rotDeltaX: 'number?',
            rotDeltaY: 'number?',
            rotDeltaZ: 'number?',
            scaleMultiplier: 'number?'
        },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'write');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            const targets = asStringList(value.targets);
            if (!file || targets.length === 0)
                return fail('INVALID_INPUT', 'batch_transform_map_objects 需要 file 和非空 targets 数组。');
            const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const result = await batchTransformMapParts(edit.session, resolvedFile.path, {
                targets,
                ...(typeof value.deltaX === 'number' ? { deltaX: Number(value.deltaX) } : {}),
                ...(typeof value.deltaY === 'number' ? { deltaY: Number(value.deltaY) } : {}),
                ...(typeof value.deltaZ === 'number' ? { deltaZ: Number(value.deltaZ) } : {}),
                ...(typeof value.rotDeltaX === 'number' ? { rotDeltaX: Number(value.rotDeltaX) } : {}),
                ...(typeof value.rotDeltaY === 'number' ? { rotDeltaY: Number(value.rotDeltaY) } : {}),
                ...(typeof value.rotDeltaZ === 'number' ? { rotDeltaZ: Number(value.rotDeltaZ) } : {}),
                ...(typeof value.scaleMultiplier === 'number' ? { scaleMultiplier: Number(value.scaleMultiplier) } : {})
            });
            if (!result.ok)
                return fail(result.error?.code ?? 'BATCH_TRANSFORM_FAILED', result.error?.message ?? '批量变换失败');
            return finalizeCommittedToolResult({ data: result, changedSources: [resolvedFile.path], context });
        }
    };
}
