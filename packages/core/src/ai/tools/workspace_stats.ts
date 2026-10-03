import type { RegisteredTool } from '../toolRegistry.js';
import { fail, ok, resolveRagCorpus } from '../toolRegistrySupport.js';
/** workspace_stats: one domain tool declaration, schema and handler. */
export function createWorkspaceStatsTool(): RegisteredTool {
    return {
        name: 'workspace_stats',
        description: 'Return indexed workspace counts for files, symbols, and references.',
        permission: 'read',
        permissionLevel: 'read',
        run: (_input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const stats = ws.getStats();
            const corpus = resolveRagCorpus(context);
            const hasStructuredSymbols = stats.events > 0 || stats.mapEntities > 0 || stats.mapRegions > 0
                || stats.paramRows > 0 || stats.textEntries > 0;
            const readiness = corpus?.availability === 'available'
                ? 'semantic-index-ready'
                : hasStructuredSymbols
                    ? 'structured-index-ready'
                    : stats.files > 0
                        ? 'catalog-ready'
                        : 'catalog-empty';
            // Statistics expose coverage counts, not every resource identity. The
            // full source list belongs to resource discovery/native evidence tools.
            const coverage = ws.getCoverageSnapshot().map((item) => ({
                scope: item.scope,
                ...(item.domain ? { domain: item.domain } : {}),
                status: item.status,
                coveredResources: item.coveredResources,
                expectedResources: item.expectedResources,
                staleSourceCount: item.staleSources.length,
                sourceVersionCount: item.sourceVersions.length,
                diagnosticCount: item.diagnostics.length,
                predicateCompleteness: {
                    kind: item.predicateCompleteness.kind,
                    status: item.predicateCompleteness.status,
                    exhaustive: item.predicateCompleteness.exhaustive
                },
                detail: 'summary-only'
            }));
            if (!corpus)
                return ok({
                    ...stats,
                    coverage,
                    semanticIndex: {
                        readiness,
                        inMemory: {
                            events: stats.events,
                            mapEntities: stats.mapEntities,
                            mapRegions: stats.mapRegions,
                            paramRows: stats.paramRows,
                            textEntries: stats.textEntries,
                            references: stats.references
                        },
                        rag: null
                    }
                });
            // 轻量索引可能尚未把所有符号投影到内存，但宿主注入的 RAG 快照
            // 仍是带来源的语义语料；不能把内存计数为 0 误报成数据不存在。
            return ok({
                ...stats,
                coverage,
                events: Math.max(stats.events, corpus.stats.byFamily.event),
                mapEntities: Math.max(stats.mapEntities, corpus.stats.byFamily.map_entity),
                mapRegions: Math.max(stats.mapRegions, corpus.stats.byFamily.map_region),
                paramRows: Math.max(stats.paramRows, corpus.stats.byFamily.param_row),
                textEntries: Math.max(stats.textEntries, corpus.stats.byFamily.text_entry),
                references: Math.max(stats.references, corpus.references.length),
                semanticIndex: {
                    readiness,
                    source: stats.events + stats.mapEntities + stats.mapRegions + stats.paramRows + stats.textEntries > 0
                        ? 'workspace-index'
                        : 'rag',
                    inMemory: {
                        events: stats.events,
                        mapEntities: stats.mapEntities,
                        mapRegions: stats.mapRegions,
                        paramRows: stats.paramRows,
                        textEntries: stats.textEntries,
                        references: stats.references
                    },
                    rag: {
                        ...corpus.stats,
                        availability: corpus.availability,
                        diagnostics: corpus.diagnostics
                    }
                }
            });
        }
    };
}
