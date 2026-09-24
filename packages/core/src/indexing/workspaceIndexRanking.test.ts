import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IndexedFile } from '@soulforge/shared';
import { WorkspaceIndex } from './workspaceIndex.js';

function msgFile(sourceUri: string, relativePath: string): IndexedFile {
  return {
    id: sourceUri,
    workspaceId: 'ranking-fixture',
    sourceUri,
    sourcePath: relativePath,
    absolutePath: `C:/fixture/${relativePath}`,
    relativePath,
    game: 'sekiro',
    resourceKind: 'msg',
    parseStatus: 'parsed',
    diagnostics: [],
    extension: '.dcx',
    compoundExtension: '.msgbnd.dcx',
    formatKind: 'fmg',
    formatLabel: 'MSGBND',
    size: 1,
    mtimeMs: 1
  };
}

describe('WorkspaceIndex lexical search ranking', () => {
  it('ranks an exact item-name phrase above descriptions and conversations', () => {
    const index = new WorkspaceIndex('ranking-fixture');
    const sourceUri = 'file:///msg/zhocn/item.msgbnd.dcx';
    const menuUri = 'file:///msg/zhocn/menu.msgbnd.dcx';
    index.setFiles([
      msgFile(sourceUri, 'msg/zhocn/item.msgbnd.dcx'),
      msgFile(menuUri, 'msg/zhocn/menu.msgbnd.dcx')
    ]);
    index.upsertMsgExport({
      category: 'zhocn/item/アイテム名',
      entries: [
        {
          uri: 'msg://zhocn/item/アイテム名/9011',
          sourceUri,
          category: 'zhocn/item/アイテム名',
          textId: 9011,
          text: '義父的守護鈴'
        },
        {
          uri: 'msg://engus/item/アイテム名/9725',
          sourceUri,
          category: 'engus/item/アイテム名',
          textId: 9725,
          text: 'Bell Demon'
        }
      ]
    });
    index.upsertMsgExport({
      category: 'zhocn/item/アイテム説明',
      entries: [{
        uri: 'msg://zhocn/item/アイテム説明/9812',
        sourceUri,
        category: 'zhocn/item/アイテム説明',
        textId: 9812,
        text: '存于心中的战斗记忆。巨型忍者枭，狼的义父。'
      }]
    });
    index.upsertMsgExport({
      category: 'zhocn/menu/会話',
      entries: [{
        uri: 'msg://zhocn/menu/会話/24000519',
        sourceUri: menuUri,
        category: 'zhocn/menu/会話',
        textId: 24000519,
        text: '这是我担心少主人做的守护铃。'
      }]
    });

    const matches = index.searchTextEntries('义父的铃铛', 3);
    assert.equal(matches[0]?.item.textId, 9011);
    assert.equal(matches[0]?.item.category, 'zhocn/item/アイテム名');
  });

  it('matches simplified and traditional query variants without an ID-specific alias', () => {
    const index = new WorkspaceIndex('ranking-variants');
    const sourceUri = 'file:///msg/zhocn/item.msgbnd.dcx';
    index.setFiles([msgFile(sourceUri, 'msg/zhocn/item.msgbnd.dcx')]);
    index.upsertMsgExport({
      category: 'zhocn/item/アイテム名',
      entries: [{
        uri: 'msg://zhocn/item/アイテム名/9011',
        sourceUri,
        category: 'zhocn/item/アイテム名',
        textId: 9011,
        text: '義父的守護鈴'
      }]
    });

    const matches = index.searchTextEntries('義父的鈴鐺', 1);
    assert.equal(matches[0]?.item.textId, 9011);
  });
});
