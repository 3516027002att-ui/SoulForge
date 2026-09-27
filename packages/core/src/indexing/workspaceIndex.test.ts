import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkspaceIndex } from './workspaceIndex.js';
import { preparePostCommitRefreshBaseline, refreshKnowledgeAfterCommit } from './knowledgeRefresh.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { loadSymbolBundleIntoIndex } from '../workspace/semanticFileCache.js';
import type { IndexedFile, SymbolBundle, TaeExport } from '@soulforge/shared';

function makeTaeExport(): TaeExport {
  const entry = (entryIndex: number, entryId: number, entryName: string, taeGroup: string) => ({
    entryIndex,
    entryId,
    entryName,
    taeGroup,
    animationCount: 1,
    sourceSize: 128,
    sourceHash: `hash-${taeGroup}`
  });
  const animation = (taeEntryIndex: number, taeEntryId: number, taeEntryName: string, taeGroup: string) => ({
    animId: 10,
    taeEntryIndex,
    taeEntryId,
    taeEntryName,
    taeGroup,
    code: 'A0010',
    events: []
  });
  return {
    chrId: 'c0000',
    sourceUri: 'file:///chr/c0000.anibnd.dcx',
    sourceHash: 'aggregate-hash',
    taeEntryCount: 2,
    taeEntries: [
      entry(1, 5000000, 'a00.tae', 'a00'),
      entry(3, 5000050, 'a50.tae', 'a50')
    ],
    animations: [
      animation(1, 5000000, 'a00.tae', 'a00'),
      animation(3, 5000050, 'a50.tae', 'a50')
    ]
  };
}

function makeParamFile(sha256: string, mtimeMs: number): IndexedFile {
  const sourceUri = 'file:///param/gameparam/gameparam.parambnd.dcx';
  return {
    id: sourceUri,
    workspaceId: 'fixture',
    sourceUri,
    sourcePath: 'param/gameparam/gameparam.parambnd.dcx',
    absolutePath: 'C:/fixture/param/gameparam/gameparam.parambnd.dcx',
    relativePath: 'param/gameparam/gameparam.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'parsed',
    diagnostics: [],
    extension: '.dcx',
    compoundExtension: '.parambnd.dcx',
    formatKind: 'param',
    formatLabel: 'PARAM BND DCX',
    size: 1,
    mtimeMs,
    sha256
  };
}

function trackReferenceRebuilds(index: WorkspaceIndex): () => number {
  const rebuild = index.rebuildReferences.bind(index);
  let count = 0;
  index.rebuildReferences = (...args) => {
    count += 1;
    return rebuild(...args);
  };
  return () => count;
}

describe('WorkspaceIndex TAE section identity', () => {
  it('裸 animId 在跨 section 时返回 AMBIGUOUS', () => {
    const index = new WorkspaceIndex('fixture');
    index.upsertTaeExport(makeTaeExport());
    assert.deepEqual(index.lookupTaeAnimation('file:///chr/c0000.anibnd.dcx', 10), {
      status: 'AMBIGUOUS',
      sourceUri: 'file:///chr/c0000.anibnd.dcx',
      animId: 10,
      matchCount: 2
    });
  });

  it('entry selector 精确命中单个 section，并拒绝不存在的 section', () => {
    const index = new WorkspaceIndex('fixture');
    index.upsertTaeExport(makeTaeExport());
    const selected = index.lookupTaeAnimation('file:///chr/c0000.anibnd.dcx', 10, {
      taeEntryIndex: 3,
      taeEntryId: 5000050,
      taeEntryName: 'a50.tae',
      taeGroup: 'a50'
    });
    assert.equal(selected.status, 'UNIQUE');
    if (selected.status === 'UNIQUE') assert.equal(selected.animation.taeGroup, 'a50');
    assert.equal(
      index.lookupTaeAnimation('file:///chr/c0000.anibnd.dcx', 10, { taeEntryIndex: 25 }).status,
      'NOT_FOUND'
    );
  });

  it('ParamSemanticState 状态机正确流转并在首批数据载入时自动就绪', () => {
    const index = new WorkspaceIndex('fixture-param-state');
    assert.equal(index.getParamSemanticState(), 'uninitialized');

    index.setParamSemanticState('warming_up');
    assert.equal(index.getParamSemanticState(), 'warming_up');

    // 载入参数后自动转为 ready
    index.upsertParamExport({
      paramName: 'NpcParam',
      sourceUri: 'file:///param/gameparam/gameparam.parambnd.dcx',
      rows: [
        {
          uri: 'file:///param/gameparam/gameparam.parambnd.dcx#NpcParam/5090000',
          sourceUri: 'file:///param/gameparam/gameparam.parambnd.dcx',
          paramName: 'NpcParam',
          rowId: 5090000,
          rowName: '鬼刑部',
          fields: []
        }
      ]
    });
    assert.equal(index.getParamSemanticState(), 'ready');
  });

  it('search_param_rows 在 warming_up 状态下返回 DEFER_PARAM_QUERY 状态机调度指令', async () => {
    const index = new WorkspaceIndex('fixture-param-defer');
    index.setParamSemanticState('warming_up');

    const registry = createDefaultToolRegistry();
    const result = await registry.run(
      'search_param_rows',
      { query: '鬼刑部' },
      { workspaceIndex: index, mode: 'plan' }
    );

    assert.equal(result.ok, true);
    assert.equal((result.data as any)?.status, 'warming_up');
    assert.equal((result.data as any)?.directive, 'DEFER_PARAM_QUERY');
    assert.match((result.data as any)?.message, /状态机调度/);
  });

  it('loadSymbolBundleIntoIndex 水合后使 warming_up 状态即时跃迁至 ready 且参数可查', async () => {
    const index = new WorkspaceIndex('fixture-param-hydrate');
    index.setParamSemanticState('warming_up');
    assert.equal(index.getParamSemanticState(), 'warming_up');

    const bundle: SymbolBundle = {
      params: [
        {
          paramName: 'NpcParam',
          sourceUri: 'file:///param/gameparam/gameparam.parambnd.dcx',
          rows: [
            {
              uri: 'file:///param/gameparam/gameparam.parambnd.dcx#NpcParam/5090000',
              sourceUri: 'file:///param/gameparam/gameparam.parambnd.dcx',
              paramName: 'NpcParam',
              rowId: 5090000,
              rowName: '鬼刑部',
              fields: []
            }
          ]
        }
      ]
    };

    loadSymbolBundleIntoIndex(index, bundle);
    index.setParamSemanticState('ready');
    assert.equal(index.getParamSemanticState(), 'ready');

    const registry = createDefaultToolRegistry();
    const result = await registry.run(
      'search_param_rows',
      { query: '鬼刑部', paramNames: ['NpcParam'] },
      { workspaceIndex: index, mode: 'plan' }
    );

    assert.equal(result.ok, true);
    const page = result.data as { matches: Array<{ item: { rowId: number } }>; total: number; returned: number; truncated: boolean };
    assert.equal(page.matches[0]?.item.rowId, 5090000);
    assert.equal(page.total, 1);
    assert.equal(page.returned, 1);
    assert.equal(page.truncated, false);
  });
});

describe('post-commit reference rebuild bounds', () => {
  it('reuses a clean reference graph and invalidates it after semantic projection changes', () => {
    const index = new WorkspaceIndex('fixture-reference-cache');
    const first = index.rebuildReferences();
    assert.strictEqual(index.rebuildReferences(), first,
      'a deferred refresh must not rebuild the graph after all native reads already published it');

    index.upsertParamExport({
      paramName: 'NpcParam',
      sourceUri: 'file:///param/gameparam/gameparam.parambnd.dcx',
      rows: [{
        uri: 'file:///param/gameparam/gameparam.parambnd.dcx#NpcParam/1',
        sourceUri: 'file:///param/gameparam/gameparam.parambnd.dcx',
        paramName: 'NpcParam',
        rowId: 1,
        rowName: 'updated fixture row',
        fields: []
      }]
    });
    const rebuilt = index.rebuildReferences();
    assert.notStrictEqual(rebuilt, first, 'a new semantic projection must invalidate the cached graph');
    assert.strictEqual(index.rebuildReferences(), rebuilt,
      'the graph remains reusable until the next semantic projection change');
  });

  it('does not expose the old reference graph when rebuilding a dirty graph fails', () => {
    const index = new WorkspaceIndex('fixture-failed-reference-build');
    const sourceUri = 'file:///param/gameparam/gameparam.parambnd.dcx';
    index.upsertParamExport({
      paramName: 'EquipParamGoods',
      entryName: 'EquipParamGoods.param',
      sourceUri,
      rows: [{
        uri: `${sourceUri}#EquipParamGoods/1`,
        sourceUri,
        paramName: 'EquipParamGoods',
        rowId: 1,
        fields: []
      }]
    });
    index.upsertMsgExport({
      category: 'Title_Goods',
      entries: [{
        uri: 'fmg://title-goods/1',
        sourceUri: 'file:///msg/item.msgbnd.dcx',
        category: 'Title_Goods',
        textId: 1,
        text: 'Healing Gourd'
      }]
    });
    const previousReferences = index.rebuildReferences().edges.length;
    assert.ok(previousReferences > 0);

    index.upsertParamExport({
      paramName: 'EquipParamGoods',
      entryName: 'EquipParamGoods.param',
      sourceUri,
      rows: [{
        uri: `${sourceUri}#EquipParamGoods/1`,
        sourceUri,
        paramName: null as unknown as string,
        rowId: 1,
        fields: []
      }]
    });
    assert.equal(index.getStats().references, 0,
      'a changed semantic projection should release its stale reference graph immediately');

    assert.throws(() => index.rebuildReferences());

    assert.equal(index.getStats().references, 0,
      'a failed rebuild must stay fail-closed instead of restoring stale edges');
  });

  it('reuses an already invalidated stale-safe baseline without rebuilding the full graph again', async () => {
    const before = makeParamFile('before-hash', 1);
    const after = makeParamFile('after-hash', 2);
    const active = new WorkspaceIndex('fixture-refresh');
    active.setFiles([before]);
    active.upsertParamExport({
      paramName: 'NpcParam',
      sourceUri: before.sourceUri,
      rows: [{
        uri: `${before.sourceUri}#NpcParam/1`,
        sourceUri: before.sourceUri,
        paramName: 'NpcParam',
        rowId: 1,
        rowName: 'fixture row',
        fields: []
      }]
    });
    const activeRebuildCount = trackReferenceRebuilds(active);
    const initialInvalidation = preparePostCommitRefreshBaseline(active, [before.sourceUri]);
    assert.deepEqual(initialInvalidation.invalidated.sourceUris, [before.sourceUri]);
    assert.equal(activeRebuildCount(), 1);

    const candidate = new WorkspaceIndex('fixture-refresh');
    candidate.setFiles([after]);
    const candidateRebuildCount = trackReferenceRebuilds(candidate);
    const refreshed = await refreshKnowledgeAfterCommit({
      index: active,
      beforeFiles: [before],
      afterFiles: [after],
      requestedSources: [before.sourceUri],
      reanalyze: async () => ({ index: candidate, semanticState: 'reanalyzed' })
    });

    assert.equal(refreshed.result.status, 'converged');
    assert.equal(activeRebuildCount(), 1, 'same changed source must not rebuild the stale baseline twice');
    assert.equal(candidateRebuildCount(), 1, 'publish must build exactly one graph for the fresh snapshot');
  });

  it('ranks an explicit Sekiro name alias above an unrelated row containing the user typo', () => {
    const index = new WorkspaceIndex('fixture-sekiro-typo-search');
    index.upsertParamExport({
      paramName: 'NpcParam',
      rows: [
        {
          uri: 'file:///fixture/gameparam.parambnd.dcx#NpcParam/98500019',
          sourceUri: 'file:///fixture/gameparam.parambnd.dcx',
          paramName: 'NpcParam',
          rowId: 98500019,
          rowName: '怨恨鬼刑部',
          fields: []
        },
        {
          uri: 'file:///fixture/gameparam.parambnd.dcx#NpcParam/50800000',
          sourceUri: 'file:///fixture/gameparam.parambnd.dcx',
          paramName: 'NpcParam',
          rowId: 50800000,
          rowName: '【鬼形部',
          fields: []
        }
      ]
    });

    for (const query of ['鬼刑部', '鬼型部']) {
      const hits = index.searchParamRows(query, 2, ['NpcParam']);
      assert.equal(hits[0]?.item.rowId, 50800000, `${query} should rank the canonical 鬼形部 identity first`);
      assert.ok(hits.some((hit) => hit.item.rowId === 98500019),
        'keep the literal-text competitor visible as a candidate instead of dropping it');
    }
  });
});

describe('WorkspaceIndex live PARAM row merge', () => {
  it('reports identical native field readbacks as unchanged', () => {
    const index = new WorkspaceIndex('fixture-param-live-merge');
    const sourceUri = 'file:///param/gameparam/gameparam.parambnd.dcx';
    const initial = {
      paramName: 'NpcParam',
      sourceUri,
      entryIndex: 4,
      entryName: 'NpcParam.param',
      sourceHash: 'source-hash',
      sourceRevision: 123,
      rows: [{
        uri: `${sourceUri}#NpcParam/50800000@1463`,
        sourceUri,
        paramName: 'NpcParam',
        entryIndex: 4,
        entryName: 'NpcParam.param',
        rowId: 50800000,
        rowIndex: 1463,
        dataHash: 'row-hash',
        sourceHash: 'source-hash',
        sourceRevision: 123,
        fields: [
          { fieldId: 'ninsatuNum', name: 'health bars', value: 3 },
          { fieldId: 'itemLotId_1', name: 'drop lot', value: -1 }
        ]
      }]
    };
    index.upsertParamExport(initial);
    const originalExport = index.toSymbolBundle().params?.[0];

    const changed = index.mergeParamRows({
      ...initial,
      rows: [{
        ...initial.rows[0]!,
        // Native field reads return only the selected cells, not every cached field.
        fields: [{ fieldId: 'ninsatuNum', name: 'health bars', value: 3 }]
      }]
    });

    assert.equal(changed, false, 'an identical partial native read must not publish a new projection');
    assert.strictEqual(index.toSymbolBundle().params?.[0], originalExport, 'a no-op read keeps the existing PARAM export object');
  });

  it('reports a changed trusted field as changed while preserving sibling fields', () => {
    const index = new WorkspaceIndex('fixture-param-live-merge-change');
    const sourceUri = 'file:///param/gameparam/gameparam.parambnd.dcx';
    const initial = {
      paramName: 'NpcParam',
      sourceUri,
      entryIndex: 4,
      entryName: 'NpcParam.param',
      sourceHash: 'source-hash',
      sourceRevision: 123,
      rows: [{
        uri: `${sourceUri}#NpcParam/50800000@1463`,
        sourceUri,
        paramName: 'NpcParam',
        entryIndex: 4,
        entryName: 'NpcParam.param',
        rowId: 50800000,
        rowIndex: 1463,
        dataHash: 'row-hash',
        sourceHash: 'source-hash',
        sourceRevision: 123,
        fields: [
          { fieldId: 'ninsatuNum', name: 'health bars', value: 3 },
          { fieldId: 'itemLotId_1', name: 'drop lot', value: -1 }
        ]
      }]
    };
    index.upsertParamExport(initial);

    const changed = index.mergeParamRows({
      ...initial,
      rows: [{
        ...initial.rows[0]!,
        fields: [{ fieldId: 'ninsatuNum', name: 'health bars', value: 2 }]
      }]
    });

    assert.equal(changed, true, 'a new value must be published so reference and RAG projections can refresh');
    const row = index.toSymbolBundle().params?.[0]?.rows[0];
    assert.equal(row?.fields?.find((field) => field.fieldId === 'ninsatuNum')?.value, 2);
    assert.equal(row?.fields?.find((field) => field.fieldId === 'itemLotId_1')?.value, -1);
  });
});
