import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, fail, ok, resolveKnowledgeWorkspaceId } from '../toolRegistrySupport.js';
import { readKnowledgePage } from '../../knowledge/knowledgeQuery.js';
/** read_knowledge_claims: one domain tool declaration, schema and handler. */
export function createReadKnowledgeClaimsTool(): RegisteredTool {
    return {
        name: 'read_knowledge_claims',
        description: '只读读取已登记 claim/page 的完整来源和发布状态；stale/contradicted/quarantined 默认不作为正面依据。',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { workspaceId: 'string?', claimIds: 'array?', pageId: 'string?', includeHistorical: 'boolean?', limit: 'number?' },
        run: (input, context) => {
            if (!context.knowledgeStore)
                return fail('KNOWLEDGE_STORE_UNAVAILABLE', `宿主知识 store 不可用，不能伪装成空知识结果。${context.knowledgeStoreDiagnostic ? ` ${context.knowledgeStoreDiagnostic}` : ''}`);
            const value = asRecord(input);
            const scope = resolveKnowledgeWorkspaceId(value.workspaceId, context);
            if (!scope.ok)
                return scope.result;
            const { workspaceId } = scope;
            const pageId = asOptionalString(value.pageId)?.trim();
            const claimIds = Array.isArray(value.claimIds)
                ? value.claimIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
                : [];
            if (!workspaceId || (!pageId && claimIds.length === 0))
                return fail('INVALID_INPUT', 'read_knowledge_claims 需要 workspaceId 与 claimIds/pageId 之一。');
            const generation = context.knowledgeStore.getCurrent();
            const includeHistorical = value.includeHistorical === true;
            const claims = claimIds
                .map((claimId) => generation.claims[claimId])
                .filter((claim): claim is NonNullable<typeof claim> => Boolean(claim))
                .filter((claim) => includeHistorical || ['draft', 'accepted'].includes(claim.publicationState))
                .filter((claim) => claim.scope.visibility === 'global' || claim.scope.workspaceId === workspaceId)
                .slice(0, Math.max(1, Math.min(64, asNumber(value.limit, 16))));
            const page = pageId ? readKnowledgePage(context.knowledgeStore, pageId, { workspaceId, includeHistorical }) : undefined;
            return ok({
                workspaceId,
                claims,
                ...(page ? { page } : {}),
                ...(pageId && !page ? { pageMissingOrOutOfScope: true } : {}),
                count: claims.length
            });
        }
    };
}
