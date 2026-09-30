import type { RegisteredTool } from '../toolRegistry.js';
import { fail, ok, requireEditSession } from '../toolRegistrySupport.js';
import { decodeReferenceQueryInput } from '@soulforge/shared';
import { loadFirstPartyEmedfRegistry } from '../../schema/sekiro/firstPartySchema.js';
import { createReferenceQueryService } from '../../references/referenceQueryService.js';
import type { ReferenceQueryServiceOptions } from '../../references/referenceQueryService.js';
import { resolveEntity } from '.././entityResolution.js';
import { defaultReferenceCursorStore } from '../../references/referenceCursorStore.js';
import { prepareReferenceContentSearch } from '../../references/referenceContentSearch.js';
/** find_references: one domain tool declaration, schema and handler. */
export function createFindReferencesTool(): RegisteredTool {
    return {
        name: 'find_references',
        description: 'Find related content and actual usages: parameter fields, text, event instructions, and script calls, '
            + 'with file/table/event/function locations, snippets, relationship reasons, and continuation actions. Provide exactly one of '
            + 'uri (logical symbol uri), target (precise native selector, e.g. '
            + '{domain:"param",sourceUri,entryIndex,rowId} / {domain:"emevd",sourceUri,eventId}) or '
            + 'query (delegated to resolveEntity). Optional: direction (from|to|both), detail '
            + '(edges|context), fieldIds (param root only), depth (1-4), limit (1-32), '
            + 'includeHypotheses, cursor (next result page) or sourceCursor (continue scanning unread sources with the original query).',
        permission: 'analyze',
        permissionLevel: 'analyze',
        inputSchema: {
            uri: 'string?',
            target: 'object?',
            query: 'string?',
            domain: 'string?',
            direction: 'enum:from|to|both?',
            detail: 'enum:edges|context?',
            fieldIds: 'array?',
            depth: 'number?',
            limit: 'number?',
            includeHypotheses: 'boolean?',
            cursor: 'string?',
            sourceCursor: 'string?'
        },
        run: async (input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const decoded = decodeReferenceQueryInput(input);
            if (!decoded.ok)
                return fail(decoded.code, decoded.message);
            const emedf = loadFirstPartyEmedfRegistry();
            const resolveQuery: NonNullable<ReferenceQueryServiceOptions['resolveQuery']> = async (query, domain) => {
                const resolved = await resolveEntity({
                    index: ws,
                    query,
                    ...(domain ? { domain: domain === 'fmg' ? 'msg' : domain === 'emevd' ? 'event' : domain } : {}),
                    maxCandidates: 8
                });
                if (resolved.status === 'ambiguous' || resolved.candidates.length > 1) {
                    return {
                        resolution: 'ambiguous' as const,
                        candidates: resolved.candidates.slice(0, 8).map((candidate) => ({
                            uri: candidate.candidateId,
                            label: candidate.label ?? candidate.nativeHandle,
                            discriminators: { nativeHandle: candidate.nativeHandle, route: candidate.route }
                        }))
                    };
                }
                if (resolved.status === 'resolved' && resolved.candidates.length === 1) {
                    const candidate = resolved.candidates[0]!;
                    return { resolution: 'resolved' as const, uri: candidate.candidateId };
                }
                return {
                    resolution: resolved.status === 'not_found' || resolved.status === 'not_found_complete_coverage'
                        ? 'not_found' as const : 'insufficient_evidence' as const
                };
            };
            try {
                const normalized = decoded.input;
                const resolved = normalized.query ? await resolveQuery(normalized.query, normalized.domain) : undefined;
                const cursorStore = context.referenceCursorStore ?? defaultReferenceCursorStore;
                let preparation: Awaited<ReturnType<typeof prepareReferenceContentSearch>> | undefined;
                if (!normalized.cursor && context.session && (!resolved || resolved.resolution === 'resolved')) {
                    const edit = requireEditSession(context, 'read');
                    if (!('session' in edit))
                        return edit;
                    const targetSource = normalized.target && 'sourceUri' in normalized.target ? normalized.target.sourceUri : undefined;
                    const targetUri = resolved?.uri ?? normalized.uri;
                    const contentStartedAt = Date.now();
                    context.onDiagnostic?.({
                        phase: 'reference.content-scan',
                        status: 'start',
                        details: { sourceCursor: normalized.sourceCursor ?? null }
                    });
                    try {
                        preparation = await prepareReferenceContentSearch({
                            index: ws, edit: edit.session, input: normalized, store: cursorStore,
                            ...(emedf.ok ? { registry: emedf.registry } : {}),
                            ...(context.signal ? { signal: context.signal } : {}),
                            ...(targetUri ? { targetUri } : {}),
                            ...(targetSource ? { prioritySourceUris: [targetSource] } : {}),
                            ...(context.onSemanticEvidenceUpdated ? { persist: context.onSemanticEvidenceUpdated } : {}),
                            ...(context.onDiagnostic ? { onDiagnostic: context.onDiagnostic } : {})
                        });
                        context.onDiagnostic?.({
                            phase: 'reference.content-scan',
                            status: 'complete',
                            elapsedMs: Date.now() - contentStartedAt,
                            details: { scan: preparation.scan }
                        });
                    }
                    catch (error) {
                        context.onDiagnostic?.({
                            phase: 'reference.content-scan',
                            status: 'failed',
                            elapsedMs: Date.now() - contentStartedAt,
                            details: { message: error instanceof Error ? error.message : String(error) }
                        });
                        throw error;
                    }
                }
                const service = createReferenceQueryService({
                    bundle: ws.toSymbolBundle(), workspaceId: ws.workspaceId,
                    coverageStates: ws.getCoverageSnapshot(),
                    providerRegistryDigest: 'soulforge-reference-providers-content-v3',
                    ...(emedf.ok ? { registry: emedf.registry } : {}),
                    cursorStore,
                    ...(preparation?.scan ? { scan: preparation.scan } : {}),
                    ...(preparation ? { sourceDiagnostics: preparation.diagnostics } : {}),
                    resolveQuery: async (query, domain) => resolved ?? resolveQuery(query, domain)
                });
                const relationStartedAt = Date.now();
                context.onDiagnostic?.({
                    phase: 'reference.relation-page',
                    status: 'start',
                    details: { cursor: normalized.cursor ?? null, limit: normalized.limit }
                });
                let page;
                try {
                    page = await service.query(input as Parameters<typeof service.query>[0]);
                    context.onDiagnostic?.({
                        phase: 'reference.relation-page',
                        status: 'complete',
                        elapsedMs: Date.now() - relationStartedAt,
                        details: {
                            resolution: page.resolution,
                            returnedCount: page.page.returnedCount,
                            hasMore: page.page.hasMore,
                            scan: page.scan
                        }
                    });
                }
                catch (error) {
                    context.onDiagnostic?.({
                        phase: 'reference.relation-page',
                        status: 'failed',
                        elapsedMs: Date.now() - relationStartedAt,
                        details: { message: error instanceof Error ? error.message : String(error) }
                    });
                    throw error;
                }
                return ok(page);
            }
            catch (error) {
                const code = typeof (error as {
                    code?: unknown;
                }).code === 'string'
                    ? (error as {
                        code: string;
                    }).code : 'REFERENCE_QUERY_FAILED';
                return fail(code, (error as Error).message ?? '关联查询失败。');
            }
        }
    };
}
