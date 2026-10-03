import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, fail, ok, summarizeReferences } from '../toolRegistrySupport.js';
/** find_text_references: one domain tool declaration, schema and handler. */
export function createFindTextReferencesTool(): RegisteredTool {
    return {
        name: 'find_text_references',
        description: 'Find events or other symbols that reference a parsed textId.',
        permission: 'analyze',
        permissionLevel: 'analyze',
        inputSchema: { textId: 'number', category: 'string?' },
        run: (input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const value = asRecord(input);
            const textId = asNumber(value.textId, Number.NaN);
            if (!Number.isFinite(textId))
                return fail('INVALID_INPUT', 'find_text_references requires numeric textId.');
            const category = asOptionalString(value.category);
            const matches = ws.lookupTextEntries(textId, category);
            if (matches.length === 0)
                return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
            // Native/event projections can be published after MSG entries. Rebuild
            // the shared graph here so this reverse query cannot return only the
            // stale container-member edge from the previous index generation.
            ws.rebuildReferences();
            const coverage = ws.getCoverageSnapshot().map((item) => ({
                ...(item.domain ? { domain: item.domain } : {}),
                status: item.status,
                coveredResources: item.coveredResources,
                expectedResources: item.expectedResources,
                staleSourceCount: item.staleSources.length,
                diagnosticCount: item.diagnostics.length
            }));
            const coverageComplete = coverage.every((item) => item.status === 'complete');
            const items = matches.map((entry) => {
                const references = ws.findReferences(entry.uri, 'to');
                const semanticReferences = references.filter((reference) => (reference.kind !== 'contains' && reference.kind !== 'member_of'));
                return {
                    entry,
                    references,
                    semanticReferences,
                    referenceStats: summarizeReferences(references),
                    semanticReferenceStats: summarizeReferences(semanticReferences)
                };
            });
            const totalReferences = items.reduce((sum, item) => sum + item.references.length, 0);
            const totalSemanticReferences = items.reduce((sum, item) => sum + item.semanticReferences.length, 0);
            return ok({
                textId,
                category,
                matches: items,
                totalReferences,
                totalSemanticReferences,
                status: totalSemanticReferences > 0 ? 'found' : coverageComplete ? 'not_found' : 'insufficient_evidence',
                coverage,
                negativeConclusionAllowed: coverageComplete
            });
        }
    };
}
