import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asString, asStringList, fail, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { readMsbParts } from '../../editing/msbEdit.js';
/** read_msb_parts: one domain tool declaration, schema and handler. */
export function createReadMsbPartsTool(): RegisteredTool {
    return {
        name: 'read_msb_parts',
        description: 'Read native MSB Parts by exact map address (for example '
            + 'm10_00_00_00#c1150_0006). file accepts a concrete .msb/.msb.dcx path, a sourceUri '
            + 'returned by search_map_entities, or a unique logical map id. The result includes '
            + 'nativeOffset, model/transform data, sourceUri, and sourceHash; use nativeOffset plus '
            + 'the expected name for later writes.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { file: 'string', addresses: 'array?', cursor: 'string?' },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            if (!file)
                return fail('INVALID_INPUT', 'read_msb_parts 需要 file。');
            const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const addresses = value.addresses === undefined ? [] : asStringList(value.addresses);
            if (value.addresses !== undefined && addresses.length === 0) {
                return fail('INVALID_INPUT', 'read_msb_parts 的 addresses 必须是非空字符串数组。');
            }
            const result = await readMsbParts({
                edit: edit.session,
                file: resolvedFile.path,
                ...(addresses.length > 0 ? { addresses } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            return ok(result);
        }
    };
}
