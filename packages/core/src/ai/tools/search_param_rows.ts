import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asStringList, fail, ok, ragSearchFallback } from '../toolRegistrySupport.js';
import { contentSearchPage } from '.././contentSearchPage.js';
/** search_param_rows: one domain tool declaration, schema and handler. */
export function createSearchParamRowsTool(): RegisteredTool {
    return {
        name: 'search_param_rows',
        description: 'Search parsed PARAM rows by native row name, row id, field id, display name, '
            + 'field description, or value. Use paramNames to search specific tables such as '
            + 'NpcParam, EquipParamGoods, or ItemLotParam. Results are candidates; use '
            + 'read_param_fields for live native values. Example: { query: "鬼庭形部", '
            + 'paramNames: ["NpcParam"] }.',
        permission: 'read',
        permissionLevel: 'read',
        // Row discovery must settle before consumers from the same model turn.
        supportsParallel: false,
        inputSchema: { query: 'string?', limit: 'safe-integer?', paramNames: 'array?', offset: 'safe-integer?', cursor: 'string?' },
        run: (input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const paramState = typeof ws.getParamSemanticState === 'function' ? ws.getParamSemanticState() : 'ready';
            if (paramState === 'warming_up') {
                return ok({
                    status: 'warming_up',
                    directive: 'DEFER_PARAM_QUERY',
                    state: 'warming_up',
                    totalHits: 0,
                    hits: [],
                    message: '【状态机调度】PARAM 语义索引当前正在后台解包预热中（尚未就绪）。请当前循环暂时跳过参数查询流程，优先执行其他可独立推进的任务（如 MSB 地图分析、EMEVD 事件逻辑校验、任务规划等）；请在下一次循环或后续步骤中再重新查询参数。'
                });
            }
            const value = asRecord(input);
            try {
                const page = contentSearchPage({
                    tool: 'search_param_rows', workspaceId: ws.workspaceId, input: value,
                    search: (query, paramNames) => ws.searchParamRows(query, Number.MAX_SAFE_INTEGER, paramNames.length > 0 ? paramNames : undefined),
                    fingerprint: ({ item, score }) => [item.uri, score, item.rowName, item.sourceHash, item.outerFileHash, item.sourceRevision, item.dataHash]
                });
                return page.total > 0 || value.cursor !== undefined
                    ? ok(page)
                    : ragSearchFallback(context, page.query, ['param_row'], page.limit, 'search_param_rows', asStringList(value.paramNames));
            }
            catch (error) {
                return fail((error as {
                    code?: string;
                }).code ?? 'CONTENT_SEARCH_FAILED', error instanceof Error ? error.message : '参数搜索失败。');
            }
        }
    };
}
