import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asString, fail, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { inspectMapEntity } from '../../editing/mapService.js';
/** inspect_map_object: one domain tool declaration, schema and handler. */
export function createInspectMapObjectTool(): RegisteredTool {
    return {
        name: 'inspect_map_object',
        description: 'Inspect a specific native map object (Part, Region, Event) by name, ID, or '
            + 'stableKey, showing transform, model, and reverse references. Pass the concrete map file '
            + 'or sourceUri returned by search_map_entities; logical map ids are accepted only when unique.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { file: 'string', identifier: 'string' },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            const identifier = asString(value.identifier);
            if (!file || !identifier)
                return fail('INVALID_INPUT', 'inspect_map_object 需要 file 和 identifier。');
            const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const result = await inspectMapEntity(edit.session, resolvedFile.path, identifier);
            if (!result.ok)
                return fail(result.error?.code ?? 'INSPECT_FAILED', result.error?.message ?? '查看地图对象失败');
            return ok(result);
        }
    };
}
