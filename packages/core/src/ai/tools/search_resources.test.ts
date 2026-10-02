import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_RESOURCE_KINDS, type IndexedFile, type ResourceKind } from '@soulforge/shared';
import { WorkspaceIndex, type SearchResourcesOptions } from '../../indexing/workspaceIndex.js';
import { createAgentToolBridge } from '../agentToolBridge.js';
import { ToolRegistry, type ToolContext } from '../toolRegistry.js';
import { createSearchResourcesTool } from './search_resources.js';

class ObservedWorkspaceIndex extends WorkspaceIndex {
    readonly searches: SearchResourcesOptions[] = [];

    override searchResourcesPage(options: SearchResourcesOptions) {
        this.searches.push(options);
        return super.searchResourcesPage(options);
    }
}

function indexedFile(kind: ResourceKind, name = 'fixture', backup = false): IndexedFile {
    const relativePath = `${kind}/${name}.txt${backup ? '.bak' : ''}`;
    const sourceUri = `file:///${relativePath}`;
    return {
        id: sourceUri,
        workspaceId: 'resource-kinds',
        sourceUri,
        sourcePath: relativePath,
        absolutePath: `/fixture/${relativePath}`,
        relativePath,
        game: 'sekiro',
        resourceKind: kind,
        parseStatus: 'unparsed',
        diagnostics: [],
        extension: '.txt',
        compoundExtension: '.txt',
        formatKind: 'text',
        formatLabel: 'Text',
        size: 1,
        mtimeMs: 1,
        ...(backup ? { artifactMarkers: { artifactRole: 'backup' as const, sourceLayer: 'overlay' as const } } : {})
    };
}

function fixture(mode: ToolContext['mode'] = 'normal') {
    const workspaceIndex = new ObservedWorkspaceIndex('resource-kinds');
    workspaceIndex.setFiles([
        ...ALL_RESOURCE_KINDS.map((kind) => indexedFile(kind)),
        indexedFile('map', 'second'),
        indexedFile('map', 'recovery', true)
    ]);
    const registry = new ToolRegistry();
    registry.register(createSearchResourcesTool());
    const context: ToolContext = { workspaceIndex, mode };
    return { workspaceIndex, registry, context, bridge: createAgentToolBridge({ registry, context }) };
}

describe('search_resources resource kind contract', () => {
    it('advertises every supported kind as an optional array item enum', () => {
        const { bridge } = fixture();
        const schema = bridge.tools[0]!.parametersJsonSchema as {
            properties: Record<string, unknown>;
            required?: string[];
        };
        assert.deepEqual(schema.properties.kinds, {
            type: 'array', items: { type: 'string', enum: [...ALL_RESOURCE_KINDS] }
        });
        assert.equal(schema.required?.includes('kinds') ?? false, false);
        assert.deepEqual(schema.properties.sourceFilter, { type: 'string', enum: ['active', 'all', 'artifacts'] });
    });

    for (const kinds of [['map', 'emevd', 'tae', 'luabnd'], ['emevd', 'tae', 'luabnd']]) {
        it(`rejects unsupported kinds ${JSON.stringify(kinds)} before a workspace search`, async () => {
            const { bridge, workspaceIndex } = fixture();
            const result = await bridge.executeTool({
                id: 'invalid-resource-kinds', name: 'search_resources',
                argumentsJson: JSON.stringify({ query: '', limit: 100, kinds })
            });
            assert.equal(result.ok, false, result.content);
            assert.equal(result.code, 'INVALID_INPUT');
            const error = JSON.parse(result.content).error as { code: string; message: string };
            assert.equal(error.code, 'INVALID_INPUT');
            for (const [index, kind] of kinds.entries()) {
                assert.equal(error.message.includes(`kinds[${index}]`), !(ALL_RESOURCE_KINDS as readonly string[]).includes(kind));
            }
            for (const kind of ALL_RESOURCE_KINDS) assert.ok(error.message.includes(kind), kind);
            assert.deepEqual(workspaceIndex.searches, []);
        });
    }

    it('rejects non-string members and invalid array values before a workspace search', async () => {
        const { registry, context, workspaceIndex } = fixture();
        for (const invalid of [null, 7, false, {}, [], '', 'Map']) {
            const result = await registry.run('search_resources', { kinds: ['map', invalid] }, context);
            assert.equal(result.ok, false, JSON.stringify(invalid));
            assert.equal(result.error?.code, 'INVALID_INPUT');
            assert.ok(result.error?.message.includes('kinds[1]'), result.error?.message);
        }
        for (const kinds of [null, 'map', {}, 7]) {
            const result = await registry.run('search_resources', { kinds }, context);
            assert.equal(result.error?.code, 'INVALID_INPUT');
        }
        assert.deepEqual(workspaceIndex.searches, []);
    });

    it('passes every supported kind and valid arrays unchanged to the workspace search', async () => {
        const { registry, context, workspaceIndex } = fixture();
        for (const kinds of [...ALL_RESOURCE_KINDS.map((kind) => [kind]), [...ALL_RESOURCE_KINDS], ['map', 'event', 'map']]) {
            const result = await registry.run('search_resources', { query: '', limit: 100, kinds, sourceFilter: 'all' }, context);
            assert.equal(result.ok, true, JSON.stringify(result));
            assert.deepEqual(workspaceIndex.searches.at(-1), { query: '', limit: 100, kinds, sourceFilter: 'all' });
            const page = result.data as { matches: Array<{ item: IndexedFile }> };
            assert.ok(page.matches.length > 0);
            assert.ok(page.matches.every(({ item }) => kinds.includes(item.resourceKind)));
        }
    });

    it('preserves omitted and empty kinds as an unfiltered search in every permission mode', async () => {
        for (const mode of ['plan', 'normal', 'fullPermission'] as const) {
            const { registry, context, workspaceIndex } = fixture(mode);
            for (const input of [{ query: '', limit: 100 }, { query: '', limit: 100, kinds: [] }]) {
                const result = await registry.run('search_resources', input, context);
                assert.equal(result.ok, true, JSON.stringify(result));
                assert.deepEqual(workspaceIndex.searches.at(-1), { query: '', limit: 100 });
                const page = result.data as { total: number; matches: Array<{ item: IndexedFile }> };
                assert.equal(page.total, ALL_RESOURCE_KINDS.length + 1);
                assert.ok(page.matches.every(({ item }) => !item.artifactMarkers));
            }
        }
    });

    it('preserves source filters and cursor continuation options', async () => {
        const { registry, context, workspaceIndex, bridge } = fixture();
        const firstInput = { query: 'map/', limit: 1, kinds: ['map'], sourceFilter: 'all' };
        const first = await registry.run('search_resources', firstInput, context);
        assert.equal(first.ok, true);
        assert.deepEqual(workspaceIndex.searches.at(-1), firstInput);
        const firstPage = first.data as { total: number; nextCursor: string };
        assert.equal(firstPage.total, 3);
        assert.ok(firstPage.nextCursor);
        const continuation = { cursor: firstPage.nextCursor };
        const next = await bridge.executeTool({
            id: 'resource-kind-continuation', name: 'search_resources', argumentsJson: JSON.stringify(continuation)
        });
        assert.equal(next.ok, true, next.content);
        assert.deepEqual(workspaceIndex.searches.at(-1), continuation);
        const nextPage = JSON.parse(next.content).data.record as { total: number; offset: number };
        assert.equal(nextPage.total, 3);
        assert.equal(nextPage.offset, 1);
        const artifactsInput = { kinds: ['map'], sourceFilter: 'artifacts' };
        const artifacts = await registry.run('search_resources', artifactsInput, context);
        assert.equal(artifacts.ok, true);
        assert.deepEqual(workspaceIndex.searches.at(-1), artifactsInput);
        assert.equal((artifacts.data as { total: number }).total, 1);
    });
});
