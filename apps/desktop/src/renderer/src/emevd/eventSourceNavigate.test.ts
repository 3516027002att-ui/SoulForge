import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EmedfCompletionItem } from '@soulforge/core';
import {
  classifyArgRole,
  indexEventHeaders,
  inspectSourceLine,
  resolveEventJump
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

test('classifyArgRole 只认参数名，不猜数字', () => {
  assert.equal(classifyArgRole('eventId'), 'event-id');
  assert.equal(classifyArgRole('calledEventId'), 'event-id');
  assert.equal(classifyArgRole('slotNumber'), 'none');
  assert.equal(classifyArgRole('spEffectId'), 'none');
  assert.equal(classifyArgRole('messageId'), 'fmg-id');
  assert.equal(classifyArgRole('itemNameId'), 'fmg-id');
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
