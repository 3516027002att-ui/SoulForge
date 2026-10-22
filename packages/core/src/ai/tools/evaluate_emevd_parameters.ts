import type { RegisteredTool } from '../toolRegistry.js';
import { asOptionalString, asRecord, fail, ok } from '../toolRegistrySupport.js';
import { loadFirstPartyEmedfRegistry } from '../../schema/sekiro/firstPartySchema.js';
import { evaluateEmevdParameters } from '../../references/emevdParameterEvaluator.js';
/** evaluate_emevd_parameters: one domain tool declaration, schema and handler. */
export function createEvaluateEmevdParametersTool(): RegisteredTool {
    return {
        name: 'evaluate_emevd_parameters',
        description: 'Evaluate bounded EMEVD InitializeEvent/InitializeCommonEvent parameter bindings from native event bytes. '
            + 'Returns caller/callee instance traces and explicit unbound/ambiguous/unsupported/stale states; it never guesses dynamic IDs '
            + 'and does not claim death/reward causality merely because AwardItemLot is reachable.',
        permission: 'analyze',
        permissionLevel: 'analyze',
        inputSchema: {
            rootUri: 'string',
            maxDepth: 'number?',
            maxNodes: 'number?',
            maxExpansionEdges: 'number?',
            expectedSourceHashes: 'object?'
        },
        run: (input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const value = asRecord(input);
            const rootUri = asOptionalString(value.rootUri)?.trim() ?? asOptionalString(value.uri)?.trim();
            if (!rootUri)
                return fail('INVALID_INPUT', 'evaluate_emevd_parameters 需要 rootUri。');
            const emedf = loadFirstPartyEmedfRegistry();
            if (!emedf.ok)
                return fail('EMEDF_REGISTRY_UNAVAILABLE', '当前没有可验证的 first-party EMEDF registry。');
            const parameterBytesByEventUri: Record<string, string> = {};
            for (const eventExport of ws.toSymbolBundle().events ?? []) {
                for (const event of eventExport.events) {
                    const raw = event.raw && typeof event.raw === 'object' && !Array.isArray(event.raw)
                        ? event.raw as Record<string, unknown> : {};
                    if (typeof raw.parameterBytesBase64 === 'string')
                        parameterBytesByEventUri[event.uri] = raw.parameterBytesBase64;
                }
            }
            const expectedSourceHashes = value.expectedSourceHashes && typeof value.expectedSourceHashes === 'object'
                && !Array.isArray(value.expectedSourceHashes)
                ? Object.fromEntries(Object.entries(value.expectedSourceHashes as Record<string, unknown>)
                    .filter((entry): entry is [
                    string,
                    string
                ] => typeof entry[0] === 'string' && typeof entry[1] === 'string'))
                : undefined;
            return ok(evaluateEmevdParameters({
                eventExports: ws.toSymbolBundle().events ?? [],
                rootUri,
                registry: emedf.registry,
                ...(Object.keys(parameterBytesByEventUri).length > 0 ? { parameterBytesByEventUri } : {}),
                ...(expectedSourceHashes && Object.keys(expectedSourceHashes).length > 0 ? { expectedSourceHashes } : {}),
                ...(typeof value.maxDepth === 'number' ? { maxDepth: Math.trunc(value.maxDepth) } : {}),
                ...(typeof value.maxNodes === 'number' ? { maxNodes: Math.trunc(value.maxNodes) } : {}),
                ...(typeof value.maxExpansionEdges === 'number' ? { maxExpansionEdges: Math.trunc(value.maxExpansionEdges) } : {})
            }));
        }
    };
}
