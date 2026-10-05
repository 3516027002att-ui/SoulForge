import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asString, fail, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { queryMapEntities } from '../../editing/mapService.js';
/** query_map_objects: one domain tool declaration, schema and handler. */
export function createQueryMapObjectsTool(): RegisteredTool {
    return {
        name: 'query_map_objects',
        description: 'Read and query native semantic map objects (Parts, Regions, Models, Events) by '
            + 'modelName, entityId, kind, or name. file accepts a concrete .msb/.msb.dcx path, a '
            + 'sourceUri returned by search_map_entities, or a unique logical map id. Results include '
            + 'sourceUri/sourceHash and are bounded; use returned stable IDs for follow-up inspection.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            file: 'string',
            modelName: 'string?',
            entityId: 'number?',
            kind: 'string?',
            nameContains: 'string?',
            regionName: 'string?'
        },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            if (!file)
                return fail('INVALID_INPUT', 'query_map_objects 需要 file。');
            const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const result = await queryMapEntities(edit.session, resolvedFile.path, {
                ...(value.modelName ? { modelName: asString(value.modelName) } : {}),
                ...(typeof value.entityId === 'number' ? { entityId: Number(value.entityId) } : {}),
                ...(value.kind ? { kind: asString(value.kind) as any } : {}),
                ...(value.nameContains ? { nameContains: asString(value.nameContains) } : {}),
                ...(value.regionName ? { regionName: asString(value.regionName) } : {})
            });
            if (!result.ok)
                return fail(result.error?.code ?? 'QUERY_FAILED', result.error?.message ?? '查询地图实体失败');
            return ok(result);
        }
    };
}
