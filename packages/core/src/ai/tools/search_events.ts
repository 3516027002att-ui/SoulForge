import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, eventSearchSnapshotHash, fail, indexedEventSearchCoverage, nativeEventSearchSnapshotHash, ok, ragSearchFallback, requireEditSession, resolveIndexedResourceFile, resolveStatelessCursorPage, searchScopedNativeEvents } from '../toolRegistrySupport.js';
import { readScopedEventSearchCursor } from '.././scopedEventSearchCursor.js';
import { createOpaqueCursor, defaultReadSessionManager, parseOpaqueCursor } from '@soulforge/shared';
import { isActiveSemanticSource } from '../../workspace/resourceKinds.js';
import * as emevdEdit from '../../editing/emevdEdit.js';
import { randomUUID } from 'node:crypto';
/** search_events: one domain tool declaration, schema and handler. */
export function createSearchEventsTool(): RegisteredTool {
    return {
        name: 'search_events',
        description: 'Search parsed native event symbols and instruction names. For exact lookup pass file + eventId; for current native instructions inside a located file pass file + query (instruction name or numeric ID). Global indexed results are candidates with explicit coverage, not exhaustive native search; '
            + 'fuzzy queries return candidates and are not a substitute for native reads. For Chinese behavior terms '
            + 'such as 血条、落雷、掉落 or 不攻击, use search_event_reference in parallel, then verify the '
            + 'candidate instruction against this workspace event and EMEDF.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: { query: 'string?', file: 'string?', eventId: 'number?', limit: 'number?', cursor: 'string?' },
        run: async (input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const value = asRecord(input);
            const file = asOptionalString(value.file);
            const eventId = value.eventId === undefined ? undefined : asNumber(value.eventId, Number.NaN);
            const limit = Math.max(1, Math.min(6, Math.trunc(asNumber(value.limit, 6))));
            const cursor = asOptionalString(value.cursor)?.trim();
            if (cursor && (file !== undefined || eventId !== undefined || value.query !== undefined)) {
                return fail('EVENT_SEARCH_CURSOR_SCOPE_MISMATCH', 'search_events 续页只能携带 host-issued cursor，不能同时更换 query 或 file/eventId。');
            }
            if (cursor) {
                try {
                    const scoped = readScopedEventSearchCursor(cursor, ws.workspaceId);
                    if (scoped)
                        return searchScopedNativeEvents(context, scoped.scope.file, scoped.scope.query, limit, scoped);
                }
                catch (error) {
                    return fail((error as {
                        code?: string;
                    }).code ?? 'INVALID_READ_CURSOR', String(error));
                }
            }
            else if (file && typeof value.query === 'string' && eventId === undefined) {
                return searchScopedNativeEvents(context, file, value.query.trim(), limit);
            }
            if (cursor) {
                let payload;
                try {
                    payload = parseOpaqueCursor(cursor);
                }
                catch (error) {
                    return fail(typeof (error as {
                        code?: unknown;
                    }).code === 'string'
                        ? (error as {
                            code: string;
                        }).code
                        : 'INVALID_READ_CURSOR', error instanceof Error ? error.message : 'search_events cursor 无效。');
                }
                if (payload.domain !== 'emevd'
                    || (!payload.scope.startsWith('search-events:') && !payload.scope.startsWith('native-events:'))) {
                    return fail('EVENT_SEARCH_CURSOR_SCOPE_MISMATCH', 'search_events cursor 不属于当前事件搜索范围。');
                }
                if (payload.scope.startsWith('native-events:')) {
                    let nativeQuery: string;
                    try {
                        const scope = JSON.parse(payload.scope.slice('native-events:'.length)) as {
                            query?: unknown;
                        };
                        nativeQuery = typeof scope.query === 'string' ? scope.query : '';
                    }
                    catch {
                        return fail('INVALID_READ_CURSOR', 'native search_events cursor 的查询范围无法解析。');
                    }
                    if (!nativeQuery)
                        return fail('INVALID_READ_CURSOR', 'native search_events cursor 缺少原始查询范围。');
                    const currentHash = nativeEventSearchSnapshotHash(nativeQuery, ws.getFiles().filter(isActiveSemanticSource));
                    if (payload.sourceHash !== currentHash) {
                        return fail('STALE_READ_CURSOR', 'EMEVD native 搜索来源已变化，请重新执行 search_events。');
                    }
                    if (!context.session)
                        return fail('WORKSPACE_REQUIRED', 'native search_events 续页需要工作区会话。');
                    const edit = requireEditSession(context, 'read');
                    if (!('session' in edit))
                        return edit;
                    const nativeSearch = await emevdEdit.searchEmevdInstructionMatches({
                        edit: edit.session,
                        files: ws.getFiles().filter(isActiveSemanticSource),
                        query: nativeQuery,
                        offset: payload.offset,
                        limit,
                        ...(context.signal ? { signal: context.signal } : {})
                    });
                    if (!nativeSearch.ok)
                        return fail(nativeSearch.error.code, nativeSearch.error.message, nativeSearch.diagnostics);
                    const nextCursor = nativeSearch.truncated
                        ? createOpaqueCursor({
                            sessionId: payload.sessionId,
                            offset: nativeSearch.offset + nativeSearch.returned,
                            sourceHash: currentHash,
                            domain: 'emevd',
                            scope: payload.scope
                        })
                        : undefined;
                    return ok({
                        authority: 'native-read-event-search',
                        coverage: { scope: 'active-workspace-native-scan', status: nativeSearch.complete ? 'complete' : 'partial', negativeConclusionAllowed: nativeSearch.complete },
                        query: nativeQuery,
                        complete: nativeSearch.complete,
                        truncated: nativeSearch.truncated,
                        offset: nativeSearch.offset,
                        limit: nativeSearch.limit,
                        returned: nativeSearch.returned,
                        matches: nativeSearch.matches,
                        scannedFiles: nativeSearch.scannedFiles,
                        scannedEvents: nativeSearch.scannedEvents,
                        diagnostics: nativeSearch.diagnostics,
                        nextActions: !nativeSearch.complete && !nextCursor
                            ? [{ tool: 'search_events', args: { query: nativeQuery, limit }, reason: '原生来源扫描未完整完成；处理 diagnostics 后重试，不能作无匹配结论。' }] : [],
                        ...(nextCursor ? { nextCursor } : {})
                    });
                }
                let query: string;
                try {
                    const scope = JSON.parse(payload.scope.slice('search-events:'.length)) as {
                        query?: unknown;
                    };
                    query = typeof scope.query === 'string' ? scope.query : '';
                }
                catch {
                    return fail('INVALID_READ_CURSOR', 'search_events cursor 的查询范围无法解析。');
                }
                if (!query)
                    return fail('INVALID_READ_CURSOR', 'search_events cursor 缺少原始查询范围。');
                const all = ws.searchEventsPage(query, 0, Number.MAX_SAFE_INTEGER);
                const sourceHash = eventSearchSnapshotHash(query, all.items);
                try {
                    const page = defaultReadSessionManager.resolvePage(cursor, sourceHash, limit);
                    return ok({
                        query,
                        ...indexedEventSearchCoverage(context, query),
                        matches: page.items,
                        total: page.total,
                        totalCount: page.total,
                        offset: page.offset,
                        limit,
                        returned: page.items.length,
                        returnedCount: page.items.length,
                        truncated: page.hasMore,
                        hasMore: page.hasMore,
                        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
                    });
                }
                catch (error) {
                    if (typeof (error as {
                        code?: unknown;
                    }).code === 'string'
                        && (error as {
                            code: string;
                        }).code === 'STALE_READ_CURSOR') {
                        try {
                            const page = resolveStatelessCursorPage(payload, sourceHash, all.items, limit, 'emevd', payload.scope);
                            return ok({
                                query,
                                ...indexedEventSearchCoverage(context, query),
                                matches: page.items,
                                total: page.total,
                                totalCount: page.total,
                                offset: page.offset,
                                limit,
                                returned: page.items.length,
                                returnedCount: page.items.length,
                                truncated: page.hasMore,
                                hasMore: page.hasMore,
                                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
                            });
                        }
                        catch (fallbackError) {
                            error = fallbackError;
                        }
                    }
                    const code = typeof (error as {
                        code?: unknown;
                    }).code === 'string'
                        ? (error as {
                            code: string;
                        }).code
                        : 'INVALID_READ_CURSOR';
                    return fail(code, error instanceof Error ? error.message : 'search_events cursor 无法续页。');
                }
            }
            if (file !== undefined || eventId !== undefined) {
                if (!file || eventId === undefined || !Number.isSafeInteger(eventId)) {
                    return fail('INVALID_INPUT', 'search_events exact lookup 需要 file 与安全整数 eventId。');
                }
                const resolvedFile = resolveIndexedResourceFile(context, file, 'event');
                if (!resolvedFile.ok)
                    return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
                const matches = ws.lookupEvents(eventId, resolvedFile.sourceUri).slice(0, limit);
                if (matches.length === 0) {
                    return fail('EVENT_NOT_FOUND', `未找到 ${file} 中的 eventId ${eventId}。`);
                }
                return ok(matches);
            }
            const query = asOptionalString(value.query)?.trim();
            if (!query)
                return fail('INVALID_INPUT', 'search_events 需要 query，或 file + eventId。');
            const indexedPage = ws.searchEventsPage(query, 0, Number.MAX_SAFE_INTEGER);
            if (indexedPage.items.length > 0) {
                const sourceHash = eventSearchSnapshotHash(query, indexedPage.items);
                const scope = `search-events:${JSON.stringify({ query })}`;
                const session = defaultReadSessionManager.createSession({
                    workspaceId: ws.workspaceId,
                    sourceVersion: { sourceUri: `search://events/${encodeURIComponent(query)}`, sourceHash },
                    domain: 'emevd',
                    queryScope: scope,
                    items: indexedPage.items
                });
                const firstCursor = createOpaqueCursor({ sessionId: session.sessionId, offset: 0, sourceHash, domain: 'emevd', scope });
                const page = defaultReadSessionManager.resolvePage(firstCursor, sourceHash, limit);
                return ok({
                    query,
                    ...indexedEventSearchCoverage(context, query),
                    matches: page.items,
                    total: page.total,
                    totalCount: page.total,
                    offset: page.offset,
                    limit,
                    returned: page.items.length,
                    returnedCount: page.items.length,
                    truncated: page.hasMore,
                    hasMore: page.hasMore,
                    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
                });
            }
            // The index is a bounded semantic projection and may legitimately lack
            // instruction rows after a fresh mount. For a precise instruction name
            // or numeric ID, cross-file native reading is the authority fallback;
            // Chinese behavior phrases continue through reference/RAG discovery.
            if (emevdEdit.isPreciseEmevdInstructionQuery(query) && context.session) {
                const edit = requireEditSession(context, 'read');
                if ('session' in edit) {
                    const nativeSearch = await emevdEdit.searchEmevdInstructionMatches({
                        edit: edit.session,
                        files: ws.getFiles().filter(isActiveSemanticSource),
                        query,
                        limit,
                        ...(context.signal ? { signal: context.signal } : {})
                    });
                    if (!nativeSearch.ok) {
                        return fail(nativeSearch.error.code, nativeSearch.error.message, nativeSearch.diagnostics);
                    }
                    {
                        const sourceHash = nativeEventSearchSnapshotHash(query, ws.getFiles().filter(isActiveSemanticSource));
                        const scope = `native-events:${JSON.stringify({ query })}`;
                        const nextCursor = nativeSearch.truncated
                            ? createOpaqueCursor({
                                sessionId: randomUUID(),
                                offset: nativeSearch.offset + nativeSearch.returned,
                                sourceHash,
                                domain: 'emevd',
                                scope
                            })
                            : undefined;
                        return ok({
                            authority: 'native-read-event-search',
                            coverage: { scope: 'active-workspace-native-scan', status: nativeSearch.complete ? 'complete' : 'partial', negativeConclusionAllowed: nativeSearch.complete },
                            query,
                            complete: nativeSearch.complete,
                            truncated: nativeSearch.truncated,
                            offset: nativeSearch.offset,
                            limit: nativeSearch.limit,
                            returned: nativeSearch.returned,
                            scannedFiles: nativeSearch.scannedFiles,
                            scannedEvents: nativeSearch.scannedEvents,
                            matches: nativeSearch.matches,
                            diagnostics: nativeSearch.diagnostics,
                            nextActions: !nativeSearch.complete && !nextCursor
                                ? [{ tool: 'search_events', args: { query, limit }, reason: '原生来源扫描未完整完成；处理 diagnostics 后重试，不能作无匹配结论。' }] : [],
                            ...(nextCursor ? { nextCursor } : {})
                        });
                    }
                }
            }
            return ragSearchFallback(context, query, ['event'], limit, 'search_events');
        }
    };
}
