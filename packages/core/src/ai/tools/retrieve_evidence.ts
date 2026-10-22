import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asRagFamilies, asRecord, asString, fail, isWorkspaceContextCurrent, ok, prepareRagQueryLookup, resolveRagCorpus, staleRagChunkOption } from '../toolRegistrySupport.js';
import { retrieveEvidence } from '../../rag/retrieve.js';
/** retrieve_evidence: one domain tool declaration, schema and handler. */
export function createRetrieveEvidenceTool(): RegisteredTool {
    return {
        name: 'retrieve_evidence',
        description: 'Hybrid retrieve over the workspace evidence index: exact IDs, lexical text, and one-hop reference expansion. '
            + 'Addresses are param-like: cXXXX / cXXXX#AXXXX(.eN) for actions, MXX / mAA_BB_CC_DD '
            + '(or mAA_BB_CC_DD#partName) for maps. Use this before specialized search_* tools when the '
            + 'question names a flag, entity, event, textId, unknown resource, anim code, or map block.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            query: 'string',
            limit: 'number?',
            families: 'array?',
            expandReferences: 'boolean?'
        },
        run: async (input, context) => {
            const corpus = resolveRagCorpus(context);
            if (corpus === null && context.workspaceIndex === null) {
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            }
            const value = asRecord(input);
            const query = asString(value.query);
            if (!query.trim())
                return fail('INVALID_INPUT', 'retrieve_evidence 需要非空 query。');
            const families = asRagFamilies(value.families);
            await prepareRagQueryLookup(corpus, context.signal);
            if (!isWorkspaceContextCurrent(context)) {
                return fail('RAG_CONTEXT_STALE', '工作区会话或 RAG 语料已切换，已丢弃旧检索结果；请重试。');
            }
            const result = retrieveEvidence(corpus, query, {
                limit: asNumber(value.limit, 8),
                ...(value.expandReferences === undefined ? {} : { expandReferences: value.expandReferences === true }),
                ...(families ? { families } : {}),
                ...staleRagChunkOption(context, corpus)
            });
            if (!result.ok) {
                if (result.code === 'insufficient_evidence')
                    return ok({ query, hits: [], totalHits: 0, note: result.message });
                // A stale injected snapshot may be the only semantic body available
                // while the current catalog has already invalidated its source.  The
                // freshness mask intentionally removes those chunks; report an
                // honest empty/partial result instead of turning a known stale source
                // into a retry loop around RAG_UNAVAILABLE.
                if (result.code === 'RAG_UNAVAILABLE'
                    && context.rag?.chunks.some((chunk) => chunk.family !== 'file')) {
                    return ok({
                        query,
                        hits: [],
                        totalHits: 0,
                        status: 'partial',
                        diagnostics: corpus?.diagnostics ?? [],
                        note: '当前语义快照已因 source revision/hash 失效，未将旧内容作为证据返回。'
                    });
                }
                return fail(result.code, result.message);
            }
            return ok(result);
        }
    };
}
