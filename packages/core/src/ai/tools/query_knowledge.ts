import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, asString, fail, ok, resolveKnowledgeWorkspaceId } from '../toolRegistrySupport.js';
import { queryKnowledgeClaims } from '../../knowledge/knowledgeQuery.js';
/** query_knowledge: one domain tool declaration, schema and handler. */
export function createQueryKnowledgeTool(): RegisteredTool {
    return {
        name: 'query_knowledge',
        description: '只读查询受版本、游戏 profile 和 workspace scope 约束的知识 claims；知识候选不能替代当前 native 读取或写入授权。',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            query: 'string',
            // The active host session is authoritative.  Keep this optional for
            // model callers so they do not have to guess an opaque workspace id;
            // direct/test callers may still provide one when no host session exists.
            workspaceId: 'string?',
            gameProfile: 'string?',
            namespace: 'string?',
            includeHistorical: 'boolean?',
            limit: 'number?'
        },
        run: (input, context) => {
            if (!context.knowledgeStore)
                return fail('KNOWLEDGE_STORE_UNAVAILABLE', `宿主知识 store 不可用，不能伪装成空知识结果。${context.knowledgeStoreDiagnostic ? ` ${context.knowledgeStoreDiagnostic}` : ''}`);
            const value = asRecord(input);
            const query = asString(value.query).trim();
            if (!query)
                return fail('INVALID_INPUT', 'query_knowledge 需要非空 query。');
            const scope = resolveKnowledgeWorkspaceId(value.workspaceId, context);
            if (!scope.ok)
                return scope.result;
            const { workspaceId } = scope;
            const results = queryKnowledgeClaims(context.knowledgeStore, query, {
                workspaceId,
                ...(asOptionalString(value.gameProfile) ? { gameProfile: asString(value.gameProfile) } : {}),
                ...(asOptionalString(value.namespace) ? { namespace: asString(value.namespace) } : {}),
                includeHistorical: value.includeHistorical === true,
                limit: asNumber(value.limit, 8)
            });
            return ok({
                query,
                scope: { workspaceId, ...(asOptionalString(value.gameProfile) ? { gameProfile: asString(value.gameProfile) } : {}) },
                count: results.length,
                claims: results,
                note: '知识内容仅是候选证据；执行修改前仍需当前 native handle、source version 和独立验证。'
            });
        }
    };
}
