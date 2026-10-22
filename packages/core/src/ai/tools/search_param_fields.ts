import type { RegisteredTool } from '../toolRegistry.js';
import { asIdList, asOptionalString, asRecord, asString, fail, ok, requireEditSession } from '../toolRegistrySupport.js';
import { searchParamFieldDefinitions } from '../../param/containerParamEdit.js';
/** search_param_fields: one domain tool declaration, schema and handler. */
export function createSearchParamFieldsTool(): RegisteredTool {
    return {
        name: 'search_param_fields',
        description: 'Search the trusted native PARAM definition for field IDs on an already located table/row. '
            + 'Pass table, non-empty rowIds, and a semantic query such as health/hp, elite/boss, hostile/team/target, '
            + 'lightning/effect, or drop/reward/item. This returns metadata candidates only; use the returned real fieldId '
            + 'in read_param_fields, which requires a non-empty explicit fieldIds array. Follow nextActions with the original query and opaque cursor to read all fields; limit is a maximum, not a total. Do not parse Smithbox XML yourself.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            table: 'string',
            rowIds: 'array',
            query: 'string',
            limit: 'number?',
            cursor: 'string?',
            containerPath: 'string?'
        },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const table = asString(value.table);
            const rowIds = asIdList(value.rowIds);
            const query = asString(value.query);
            if (!table || rowIds.length === 0 || !query.trim()) {
                return fail('PARAM_FIELD_QUERY_REQUIRED', 'search_param_fields 需要 table、非空 rowIds 和 query。');
            }
            const containerPath = asOptionalString(value.containerPath);
            const result = await searchParamFieldDefinitions({
                edit: edit.session,
                table,
                rowIds,
                query,
                ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
                ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
                ...(containerPath ? { containerPath } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.error.details);
            return ok({ ...result, nextActions: result.nextCursor ? [{ tool: 'search_param_fields', args: { ...value, cursor: result.nextCursor }, reason: '继续读取字段定义。' }] : [] });
        }
    };
}
