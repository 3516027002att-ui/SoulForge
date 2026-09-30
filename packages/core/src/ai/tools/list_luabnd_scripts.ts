import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, asString, canonicalScriptSourceUri, fail, ok, requireEditSession, resolveStatelessCursorPage, scriptCatalogSnapshotHash } from '../toolRegistrySupport.js';
import { listLuabndScripts } from '../../editing/luabndEdit.js';
import { createOpaqueCursor, defaultReadSessionManager, parseOpaqueCursor } from '@soulforge/shared';
import type { ScriptSymbol } from '@soulforge/shared';
/** list_luabnd_scripts: one domain tool declaration, schema and handler. */
export function createListLuabndScriptsTool(): RegisteredTool {
    return {
        name: 'list_luabnd_scripts',
        description: 'List all Lua AI scripts inside a *.luabnd.dcx container (such as script/m11_01_00_00.luabnd.dcx or script/aicommon.luabnd.dcx). '
            + 'Returns script filenames (e.g. 540000_battle.lua for Genichiro, 508000_battle.lua for Gyoubu) to identify the target AI script before calling read_luabnd_script.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            file: 'string',
            cursor: 'string?',
            pageSize: 'number?'
        },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            if (!file)
                return fail('INVALID_INPUT', 'list_luabnd_scripts ��Ҫ file��');
            const cursor = asOptionalString(value.cursor)?.trim();
            const pageSize = Math.max(1, Math.min(100, Math.trunc(asNumber(value.pageSize, 32))));
            const result = await listLuabndScripts({ edit: edit.session, file });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            const sourceUriForPaging = context.workspaceIndex
                ? canonicalScriptSourceUri(context, result.containerPath, result.sourceUri)
                : result.sourceUri;
            const catalogHash = scriptCatalogSnapshotHash(sourceUriForPaging, result.outerFileHash, result.scripts);
            const catalogScope = `luabnd-scripts:${sourceUriForPaging}`;
            let page;
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
                        : 'INVALID_READ_CURSOR', error instanceof Error ? error.message : 'LuaBND 目录 cursor 无效。');
                }
                if (payload.domain !== 'script' || payload.scope !== catalogScope) {
                    return fail('LUABND_CURSOR_SCOPE_MISMATCH', 'LuaBND 目录 cursor 与当前容器不匹配，请重新列出脚本。');
                }
                try {
                    page = defaultReadSessionManager.resolvePage(cursor, catalogHash, pageSize);
                }
                catch (error) {
                    if (typeof (error as {
                        code?: unknown;
                    }).code === 'string'
                        && (error as {
                            code: string;
                        }).code === 'STALE_READ_CURSOR') {
                        try {
                            page = resolveStatelessCursorPage(payload, catalogHash, result.scripts, pageSize, 'script', catalogScope);
                        }
                        catch (fallbackError) {
                            error = fallbackError;
                        }
                    }
                    if (page) {
                        // The stateless fallback above recovered a valid page after a CLI
                        // process restart; continue through the same bounded projection.
                    }
                    else {
                        const code = typeof (error as {
                            code?: unknown;
                        }).code === 'string'
                            ? (error as {
                                code: string;
                            }).code
                            : 'INVALID_READ_CURSOR';
                        return fail(code, error instanceof Error ? error.message : 'LuaBND 目录 cursor 无法续页。');
                    }
                }
            }
            else {
                const session = defaultReadSessionManager.createSession({
                    workspaceId: context.workspaceIndex?.workspaceId ?? edit.session.session.meta.workspaceId,
                    sourceVersion: { sourceUri: sourceUriForPaging, sourceHash: catalogHash },
                    domain: 'script',
                    queryScope: catalogScope,
                    items: result.scripts
                });
                const firstCursor = createOpaqueCursor({
                    sessionId: session.sessionId,
                    offset: 0,
                    sourceHash: catalogHash,
                    domain: 'script',
                    scope: catalogScope
                });
                page = defaultReadSessionManager.resolvePage(firstCursor, catalogHash, pageSize);
            }
            let publicResult: Record<string, unknown> = {
                ...result,
                sourceUri: sourceUriForPaging,
                scripts: page.items as typeof result.scripts,
                total: page.total,
                totalCount: page.total,
                offset: page.offset,
                limit: pageSize,
                returned: page.items.length,
                returnedCount: page.items.length,
                truncated: page.hasMore,
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
            };
            if (context.workspaceIndex) {
                const sourceUri = sourceUriForPaging;
                const scripts: ScriptSymbol[] = result.scripts.map((script, index) => ({
                    uri: `${sourceUri}!/${script.sanitizedName}`,
                    sourceUri,
                    childChain: [script.sanitizedName],
                    entryIndex: index,
                    entryName: script.sanitizedName,
                    contentKind: script.contentKind,
                    ...(script.contentHash ? { sourceHash: script.contentHash } : {}),
                    ...(result.outerFileHash ? { outerFileHash: result.outerFileHash } : {}),
                    sourceRevision: result.sourceRevision
                }));
                context.workspaceIndex.upsertScriptExport({
                    sourceUri,
                    containerKind: 'luabnd',
                    outerFileHash: result.outerFileHash,
                    sourceRevision: result.sourceRevision,
                    catalogComplete: result.catalogComplete,
                    scripts
                });
                context.workspaceIndex.rebuildReferences();
                await context.onSemanticEvidenceUpdated?.([sourceUri]);
                publicResult = { ...publicResult, sourceUri };
            }
            return ok(publicResult);
        }
    };
}
