import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EmedfCompletionItem } from '@soulforge/core';
import {
  classifyArgRole,
  findCatalogContainer,
  indexEventHeaders,
  inspectSourceLine,
  isFmgRole,
  resolveEventJump,
  resolveFmgJump,
  resolveParamJump
} from './eventSourceNavigate.js';

const catalog: EmedfCompletionItem[] = [
  {
    name: 'InitializeEvent',
    bank: 2000,
    id: 6,
    args: [
      { name: 'slotNumber', type: 's32' },
      { name: 'eventId', type: 's32' },
      { name: 'arg', type: 's32' }
    ]
  },
  {
    name: 'IfCharacterHasSpEffect',
    bank: 4,
    id: 0,
    args: [
      { name: 'resultConditionGroup', type: 's8' },
      { name: 'target', type: 's32' },
      { name: 'spEffectId', type: 's32' }
    ]
  },
  {
    name: 'CreateItem',
    bank: 5,
    id: 0,
    args: [
      { name: 'itemNameId', type: 's32' },
      { name: 'messageId', type: 's32' },
      { name: 'placeNameId', type: 's32' },
      { name: 'paramId', type: 's32' },
      { name: 'fmgId', type: 's32' }
    ]
  }
];

test('indexEventHeaders 一遍扫出 $Event id → 行号，不靠 split 出全行数组', () => {
  const text = [
    '$Event(0, Default, function() {',
    '    InitializeEvent(0, 50, 0);',
    '});',
    '',
    '$Event(50, Restart, function() {',
    '    EndEvent();',
    '});'
  ].join('\n');
  const index = indexEventHeaders(text);
  assert.equal(index.get(0), 1);
  assert.equal(index.get(50), 5);
  assert.equal(index.has(99), false);
});

test('classifyArgRole 只认参数名，不猜数字（S31：fmg 细分 + param-id）', () => {
  assert.equal(classifyArgRole('eventId'), 'event-id');
  assert.equal(classifyArgRole('calledEventId'), 'event-id');
  assert.equal(classifyArgRole('slotNumber'), 'none');
  assert.equal(classifyArgRole('spEffectId'), 'param-id');
  assert.equal(classifyArgRole('paramId'), 'param-id');
  assert.equal(classifyArgRole('spEffectParamId'), 'param-id');
  assert.equal(classifyArgRole('messageId'), 'fmg-text-id');
  assert.equal(classifyArgRole('msgId'), 'fmg-text-id');
  assert.equal(classifyArgRole('textId'), 'fmg-text-id');
  assert.equal(classifyArgRole('itemNameId'), 'fmg-item-name-id');
  assert.equal(classifyArgRole('placeNameId'), 'fmg-place-name-id');
  assert.equal(classifyArgRole('fmgId'), 'fmg-id');
  assert.equal(classifyArgRole('fmg'), 'fmg-id');
  // 不误伤：物品/地名 id 不被通用 fmg 分支截胡，普通 id 不升级。
  assert.equal(classifyArgRole('itemLotId'), 'none');
  assert.equal(classifyArgRole('arrowId'), 'none');
});

test('isFmgRole 只认 fmg 系角色', () => {
  assert.equal(isFmgRole('fmg-id'), true);
  assert.equal(isFmgRole('fmg-text-id'), true);
  assert.equal(isFmgRole('fmg-item-name-id'), true);
  assert.equal(isFmgRole('fmg-place-name-id'), true);
  assert.equal(isFmgRole('param-id'), false);
  assert.equal(isFmgRole('event-id'), false);
  assert.equal(isFmgRole('none'), false);
});

test('inspectSourceLine：已知指令给出参数名/类型/eventId 角色', () => {
  const inspection = inspectSourceLine('    InitializeEvent(0, 70000000, 1);', catalog);
  assert.equal(inspection.kind, 'instruction');
  if (inspection.kind !== 'instruction') return;
  assert.equal(inspection.unknown, false);
  assert.equal(inspection.bank, 2000);
  assert.equal(inspection.args[1]?.name, 'eventId');
  assert.equal(inspection.args[1]?.role, 'event-id');
  assert.equal(inspection.args[1]?.eventId, 70000000);
  assert.equal(inspection.args[0]?.role, 'none');
});

test('inspectSourceLine：fmg 系 / param 系实参带 resourceId（S31）', () => {
  const inspection = inspectSourceLine('    CreateItem(1100, 1, 2, 3, 4);', catalog);
  assert.equal(inspection.kind, 'instruction');
  if (inspection.kind !== 'instruction') return;
  const byName = new Map(inspection.args.map((arg) => [arg.name, arg]));
  const item = byName.get('itemNameId')!;
  assert.equal(item.role, 'fmg-item-name-id');
  assert.equal(item.resourceId, 1100);
  const message = byName.get('messageId')!;
  assert.equal(message.role, 'fmg-text-id');
  assert.equal(message.resourceId, 1);
  const place = byName.get('placeNameId')!;
  assert.equal(place.role, 'fmg-place-name-id');
  assert.equal(place.resourceId, 2);
  const param = byName.get('paramId')!;
  assert.equal(param.role, 'param-id');
  assert.equal(param.resourceId, 3);
  const fmg = byName.get('fmgId')!;
  assert.equal(fmg.role, 'fmg-id');
  assert.equal(fmg.resourceId, 4);
  // 非整数不挂 resourceId（不猜）。
  const nonNumeric = inspectSourceLine('    CreateItem(0x100, 0, 0, 0, 0);', catalog);
  if (nonNumeric.kind !== 'instruction') return;
  assert.equal(nonNumeric.args[0]?.resourceId, undefined);
});

test('inspectSourceLine：未知指令诚实标未解码', () => {
  const inspection = inspectSourceLine('    NotInCatalog(1, 2);', catalog);
  assert.equal(inspection.kind, 'instruction');
  if (inspection.kind !== 'instruction') return;
  assert.equal(inspection.unknown, true);
});

test('inspectSourceLine：unknown 注释是未解码', () => {
  const inspection = inspectSourceLine('    // unknown bank=9 id=1', catalog);
  assert.equal(inspection.kind, 'undecoded');
});

test('resolveEventJump：命中当前 tab，否则找已打开的另一份，找不到 insufficient_evidence', () => {
  const common = indexEventHeaders('$Event(10, Default, function() {\n});\n$Event(20, Default, function() {\n});');
  const func = indexEventHeaders('$Event(70000000, Default, function() {\n});');
  const indexes = [
    { tabId: 'common', title: 'common', headers: common },
    { tabId: 'func', title: 'common_func', headers: func }
  ];
  const local = resolveEventJump(20, indexes, 'common');
  assert.equal(local.kind, 'hit');
  if (local.kind === 'hit') {
    assert.equal(local.tabId, 'common');
    assert.equal(local.line, 3);
  }
  const other = resolveEventJump(70000000, indexes, 'common');
  assert.equal(other.kind, 'hit');
  if (other.kind === 'hit') {
    assert.equal(other.tabId, 'func');
    assert.equal(other.title, 'common_func');
  }
  const missing = resolveEventJump(999, indexes, 'common');
  assert.equal(missing.kind, 'insufficient_evidence');
  if (missing.kind === 'insufficient_evidence') {
    assert.equal(missing.code, 'insufficient_evidence');
  }
});

test('findCatalogContainer 按容器 sourceUri 找表集合，找不到返回 null', () => {
  const catalogLike = {
    languages: [
      {
        containers: [
          {
            sourceUri: 'fixture://msg/zhocn/item.msgbnd.dcx',
            tables: [{ tableId: 't1', entryName: 'Item Name' }]
          }
        ]
      }
    ]
  };
  const found = findCatalogContainer(catalogLike, 'fixture://msg/zhocn/item.msgbnd.dcx');
  assert.equal(found?.tables.length, 1);
  assert.equal(findCatalogContainer(catalogLike, 'fixture://msg/en/menu.msgbnd.dcx'), null);
});

test('resolveFmgJump：语义匹配已打开文本表，零/多命中都 insufficient_evidence', () => {
  const containers = [
    {
      sourceUri: 'fixture://msg/zhocn/item.msgbnd.dcx',
      title: 'item',
      tables: [
        { tableId: 'zh:item:Item Name', entryName: 'Item Name' },
        { tableId: 'zh:item:Item Info', entryName: 'Item Info' }
      ]
    }
  ];
  const hit = resolveFmgJump('item-name', 1100, containers);
  assert.equal(hit.kind, 'hit');
  if (hit.kind === 'hit') {
    assert.equal(hit.resourceUri, 'fixture://msg/zhocn/item.msgbnd.dcx');
    assert.equal(hit.tableId, 'zh:item:Item Name');
    assert.equal(hit.detail, 'Item Name');
  }
  // 多命中：不许猜哪一张表。
  const ambiguous = resolveFmgJump('item-name', 1100, [
    ...containers,
    {
      sourceUri: 'fixture://msg/en/item.msgbnd.dcx',
      title: 'item_en',
      tables: [{ tableId: 'en:item:Item Name', entryName: 'Item Name' }]
    }
  ]);
  assert.equal(ambiguous.kind, 'insufficient_evidence');
  // 零命中。
  const none = resolveFmgJump('place-name', 1100, containers);
  assert.equal(none.kind, 'insufficient_evidence');
});

test('resolveParamJump：恰好一个已打开 PARAM 才 hit，零/多都是 insufficient_evidence', () => {
  const openParams = [{ sourceUri: 'fixture://param/SpEffectParam.param', title: 'SpEffectParam' }];
  const hit = resolveParamJump(3300, openParams);
  assert.equal(hit.kind, 'hit');
  if (hit.kind === 'hit') {
    assert.equal(hit.title, 'SpEffectParam');
    assert.equal(hit.detail, 'PARAM 行 3300');
  }
  const none = resolveParamJump(3300, []);
  assert.equal(none.kind, 'insufficient_evidence');
  const many = resolveParamJump(3300, [
    ...openParams,
    { sourceUri: 'fixture://param/BehaviorParam.param', title: 'BehaviorParam' }
  ]);
  assert.equal(many.kind, 'insufficient_evidence');
});
