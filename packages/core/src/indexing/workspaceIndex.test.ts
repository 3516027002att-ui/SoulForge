import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkspaceIndex } from './workspaceIndex.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { loadSymbolBundleIntoIndex } from '../workspace/semanticFileCache.js';
import type { SymbolBundle, TaeExport } from '@soulforge/shared';

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
    assert.equal(Array.isArray(result.data), true);
    assert.equal((result.data as any[])[0]?.item?.rowId, 5090000);
  });
});
