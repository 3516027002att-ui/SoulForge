import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asString, canonicalScriptSourceUri, fail, nativePathFromFileToken, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { readLuabndScript } from '../../editing/luabndEdit.js';
import { buildLuaStructureIndex, parseLuaStaticSubset } from '../../references/luaStaticSubset.js';
import { projectScriptReadExport } from '../../references/scriptReadProjection.js';
import { metadataPage } from '.././metadataPage.js';
/** analyze_luabnd_script: one domain tool declaration, schema and handler. */
export function createAnalyzeLuabndScriptTool(): RegisteredTool {
    return {
        name: 'analyze_luabnd_script',
        description: 'Read one native LuaBND child and return a bounded structural index: functions, Goal functions, branches, '
            + 'constants, call sites and explicitly unsupported game APIs. This is source/static evidence only; it never executes Lua '
            + 'and never upgrades a test stub or decompiled view to runtime behavior. Select section=functions (default), goals, branches, constants, calls, unsupportedApis or diagnostics. Each section returns items, sectionCounts and a version-bound nextCursor; follow nextActions to finish that section. One completed section does not mean the entire script has been analyzed for runtime behavior.',
        permission: 'analyze',
        permissionLevel: 'analyze',
        inputSchema: { file: 'string', childPath: 'string', section: 'string?', cursor: 'string?', limit: 'safe-integer?' },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            const childPath = asString(value.childPath);
            if (!file || !childPath)
                return fail('INVALID_INPUT', 'analyze_luabnd_script 需要 file 和 childPath。');
            const resolvedFile = resolveIndexedResourceFile(context, file, 'script');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const native = await readLuabndScript({
                edit: edit.session,
                file: nativePathFromFileToken(resolvedFile.path),
                childPath,
                ...(context.signal ? { signal: context.signal } : {})
            });
            if (!native.ok)
                return fail(native.error.code, native.error.message, native.diagnostics);
            if (native.script.sourceText === undefined) {
                return ok({
                    file: canonicalScriptSourceUri(context, native.containerPath),
                    childPath,
                    sourceHash: native.script.sourceHash,
                    structure: { status: 'unsupported', functions: [], goals: [], branches: [], constants: [], unsupportedApis: [], diagnostics: native.script.warnings ?? ['没有可分析的原文源码。'] },
                    evidenceLayers: { resource: 'native-read', relation: 'not-indexed', logic: 'unsupported', runtime: 'not-run' },
                    diagnostics: native.diagnostics
                });
            }
            const parsed = parseLuaStaticSubset(native.script.sourceText);
            const structure = buildLuaStructureIndex(native.script.sourceText, parsed);
            if (context.workspaceIndex) {
                const sourceUri = canonicalScriptSourceUri(context, native.containerPath);
                const existing = context.workspaceIndex.toSymbolBundle().scripts?.find((item) => item.sourceUri === sourceUri);
                const sourceRevision = context.workspaceIndex.getFile(sourceUri)?.mtimeMs;
                const projection = projectScriptReadExport({
                    sourceUri,
                    childPath,
                    script: native.script,
                    ...(sourceRevision === undefined ? {} : { sourceRevision }),
                    ...(existing ? { existing } : {})
                });
                const child = projection.scripts.find((item) => item.uri === `${sourceUri}!/${childPath}`);
                if (child)
                    child.structure = structure;
                context.workspaceIndex.upsertScriptExport(projection);
                context.workspaceIndex.rebuildReferences();
                await context.onSemanticEvidenceUpdated?.([sourceUri]);
            }
            const sections: Record<string, readonly unknown[]> = {
                functions: structure.functions, goals: structure.goals, branches: structure.branches,
                constants: structure.constants, unsupportedApis: structure.unsupportedApis, diagnostics: structure.diagnostics ?? [],
                calls: parsed.calls.map((call) => ({ callee: call.callee, span: call.span, isLocal: call.isLocal, isRequire: call.isRequire }))
            };
            const section = asString(value.section, 'functions');
            const items = sections[section];
            if (!items)
                return fail('INVALID_STRUCTURE_SECTION', 'section 必须为 functions/goals/branches/constants/unsupportedApis/diagnostics/calls。');
            let page;
            try {
                page = metadataPage({ items, domain: 'script', sourceHash: native.script.sourceHash,
                    scope: { workspace: context.workspaceIndex?.workspaceId, file: resolvedFile.path, childPath, section },
                    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
                    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}) });
            }
            catch (error) {
                return fail((error as {
                    code?: string;
                }).code ?? 'STRUCTURE_PAGE_FAILED', String(error), (error as {
                    details?: unknown;
                }).details);
            }
            return ok({
                file: canonicalScriptSourceUri(context, native.containerPath), childPath,
                sourceUri: canonicalScriptSourceUri(context, native.containerPath),
                sourceHash: native.script.sourceHash, outerFileHash: native.script.outerFileHash,
                section, sectionCounts: Object.fromEntries(Object.entries(sections).map(([key, rows]) => [key, rows.length])),
                structureStatus: structure.status,
                ...page,
                nextActions: page.nextCursor ? [{ tool: 'analyze_luabnd_script', args: { file, childPath, section, cursor: page.nextCursor, ...(typeof value.limit === 'number' ? { limit: value.limit } : {}) }, reason: '继续读取同一结构分区。' }] : [],
                evidenceLayers: {
                    resource: 'native-read',
                    relation: 'static-source-index',
                    logic: structure.unsupportedApis.length > 0 ? 'partial-unsupported-api' : 'structural-only',
                    runtime: 'not-run'
                },
                diagnostics: native.diagnostics
            });
        }
    };
}
