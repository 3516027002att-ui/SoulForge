import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IndexedFile } from '@soulforge/shared';
import { resolveEntity } from './entityResolution.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

function file(sourceUri: string, relativePath: string, resourceKind: IndexedFile['resourceKind']): IndexedFile {
  return {
    id: sourceUri,
    workspaceId: 'fixture',
    sourceUri,
    sourcePath: relativePath,
    absolutePath: `C:/fixture/${relativePath}`,
    relativePath,
    game: 'sekiro',
    resourceKind,
    parseStatus: 'parsed',
    diagnostics: [],
    extension: '.dcx',
    compoundExtension: resourceKind === 'msg' ? '.fmg.dcx' : '.param.dcx',
    formatKind: resourceKind === 'msg' ? 'fmg' : 'param',
    formatLabel: resourceKind === 'msg' ? 'FMG' : 'PARAM',
    size: 1,
    mtimeMs: 1
  };
}

describe('resolveEntity domain safety', () => {
  it('keeps a matching FMG entry as a clue but never treats it as a PARAM mutation target', async () => {
    const index = new WorkspaceIndex('fixture');
    index.setFiles([
      file('file:///param/gameparam.parambnd.dcx', 'param/gameparam.parambnd.dcx', 'param'),
      file('file:///msg/item.fmg.dcx', 'msg/item.fmg.dcx', 'msg')
    ]);
    index.upsertParamExport({
      paramName: 'NpcParam',
      sourceUri: 'file:///param/gameparam.parambnd.dcx',
      rows: [{
        uri: 'file:///param/gameparam.parambnd.dcx#NpcParam/1',
        sourceUri: 'file:///param/gameparam.parambnd.dcx',
        paramName: 'NpcParam',
        rowId: 1,
        rowName: 'unrelated row'
      }]
    });
    index.upsertMsgExport({
      category: 'Title',
      entries: [{
        uri: 'file:///msg/item.fmg.dcx#text/1',
        sourceUri: 'file:///msg/item.fmg.dcx',
        category: 'Title',
        textId: 1,
        text: '义父的守护铃'
      }]
    });

    const result = await resolveEntity({ index, query: '义父的守护铃', domain: 'param' });
    const clue = result.candidates.find((candidate) => candidate.domain === 'msg');
    assert.ok(clue);
    assert.equal(clue.status, 'excluded');
    assert.equal(clue.nativeVerified, false);
    assert.equal(result.mutationTargets.length, 0);
    assert.notEqual(result.status, 'resolved');
  });

  it('preserves a slash-containing FMG category as the native object key', async () => {
    let observed: { namespace: string; objectKey: string } | undefined;
    await resolveEntity({
      index: new WorkspaceIndex('fixture-msg-handle'),
      domain: 'msg',
      nativeHandle: 'zhocn/item/npc名#902012',
      maxSteps: 1,
      nativeRead: async (request) => {
        observed = { namespace: request.namespace, objectKey: request.objectKey };
        return { ok: false, reason: 'fixture miss' };
      }
    });
    assert.deepEqual(observed, { namespace: 'msg', objectKey: 'zhocn/item/npc名#902012' });
  });

  it('prioritizes the requested PARAM domain when a one-candidate budget also finds an FMG clue', async () => {
    const index = new WorkspaceIndex('fixture-param-priority');
    index.setFiles([
      file('file:///param/gameparam.parambnd.dcx', 'param/gameparam.parambnd.dcx', 'param'),
      file('file:///msg/item.fmg.dcx', 'msg/item.fmg.dcx', 'msg')
    ]);
    index.upsertParamExport({
      paramName: 'EquipParamGoods',
      sourceUri: 'file:///param/gameparam.parambnd.dcx',
      rows: [{
        uri: 'file:///param/gameparam.parambnd.dcx#EquipParamGoods/902012',
        sourceUri: 'file:///param/gameparam.parambnd.dcx',
        paramName: 'EquipParamGoods',
        rowId: 902012,
        rowName: '义父的守护铃',
        sourceHash: 'param-hash',
        sourceRevision: 1
      }]
    });
    index.upsertMsgExport({
      category: 'Title',
      entries: [{
        uri: 'file:///msg/item.fmg.dcx#text/902012',
        sourceUri: 'file:///msg/item.fmg.dcx',
        category: 'Title',
        textId: 902012,
        text: '义父的守护铃'
      }]
    });

    const result = await resolveEntity({ index, query: '义父的守护铃', domain: 'param', maxCandidates: 1 });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.domain, 'param');
    assert.equal(result.mutationTargets.length, 1);
  });

  it('does not resolve or authorize mutation when fuzzy PARAM candidates exceed the budget', async () => {
    const index = new WorkspaceIndex('fixture-param-truncated');
    index.setFiles([file('file:///param/gameparam.parambnd.dcx', 'param/gameparam.parambnd.dcx', 'param')]);
    index.upsertParamExport({
      paramName: 'BehaviorParam',
      sourceUri: 'file:///param/gameparam.parambnd.dcx',
      rows: [
        {
          uri: 'file:///param/gameparam.parambnd.dcx#BehaviorParam/250800475',
          sourceUri: 'file:///param/gameparam.parambnd.dcx',
          paramName: 'BehaviorParam',
          rowId: 250800475,
          rowName: '怨嗟鬼形部现形SFX',
          sourceRevision: 1
        },
        {
          uri: 'file:///param/gameparam.parambnd.dcx#BehaviorParam/250800476',
          sourceUri: 'file:///param/gameparam.parambnd.dcx',
          paramName: 'BehaviorParam',
          rowId: 250800476,
          rowName: '怨嗟鬼形部现形SFX alternate',
          sourceRevision: 1
        }
      ]
    });

    const result = await resolveEntity({
      index,
      query: '怨嗟鬼形部现形SFX',
      domain: 'param',
      maxCandidates: 1
    });
    assert.equal(result.candidateSetComplete, false);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.mutationTargets, []);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.startsWith('CANDIDATE_SET_INCOMPLETE')));
  });
});
