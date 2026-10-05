import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asString, fail, ok, requireEditSession } from '../toolRegistrySupport.js';
import { loadMapDocument } from '../../editing/mapService.js';
import { exportMapSceneForBlender } from '@soulforge/shared';
/** export_map_for_blender: one domain tool declaration, schema and handler. */
export function createExportMapForBlenderTool(): RegisteredTool {
    return {
        name: 'export_map_for_blender',
        description: 'Export canonical MapDocument to Blender-compatible JSON scene descriptor with stable identifiers and revisions.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { file: 'string' },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            if (!file)
                return fail('INVALID_INPUT', 'export_map_for_blender 需要 file。');
            const loaded = await loadMapDocument(edit.session, file);
            if (!loaded.ok)
                return fail(loaded.error.code, loaded.error.message);
            const blenderScene = exportMapSceneForBlender(loaded.doc);
            return ok(blenderScene);
        }
    };
}
