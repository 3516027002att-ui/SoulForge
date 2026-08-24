import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeCursorContext,
  getSignatureHelp,
  getCompletions,
  scoreMatch,
  computeDocumentDiagnostics,
  getQuickFixesAt,
  indexDocumentSymbols,
  searchEventSymbols,
  findEventReferences,
  formatEventDocument
} from './index.js';
import type { EmedfCompletionItem } from '../emedfCompletionCatalog.js';
import type { EmedfEnumDef } from '../emedfSchema.js';

const SAMPLE_CATALOG: EmedfCompletionItem[] = [
  {
    name: 'ShootBullet',
    bank: 2003,
    id: 1,
    args: [
      { name: 'ownerEntityId', type: 's32' },
      { name: 'sourceEntityId', type: 's32' },
      { name: 'dummyPolyId', type: 's32' },
      { name: 'bulletId', type: 's32' }
    ]
  },
  {
    name: 'CharacterDead',
    bank: 1003,
    id: 0,
    args: [
      { name: 'characterId', type: 's32' }
    ]
  },
  {
    name: 'CharacterHasSpEffect',
    bank: 1003,
    id: 1,
    args: [
      { name: 'characterId', type: 's32' },
      { name: 'spEffectId', type: 's32' }
    ]
  },
  {
    name: 'IfParameterComparison',
    bank: 0,
    id: 1,
    args: [
      { name: 'resultConditionGroup', type: 's8' },
      { name: 'comparisonType', type: 'u8', enumName: 'ComparisonType' },
      { name: 'value', type: 's32' }
    ]
  },
  {
    name: 'InitializeEvent',
    bank: 2000,
    id: 0,
    args: [
      { name: 'slotNumber', type: 's32' },
      { name: 'eventId', type: 's32' }
    ]
  }
];

const SAMPLE_ENUMS: Record<string, EmedfEnumDef> = {
  ComparisonType: {
    name: 'ComparisonType',
    members: [
      { value: 0, name: 'Equal', label: 'Equal' },
      { value: 1, name: 'NotEqual', label: 'Not Equal' },
      { value: 2, name: 'GreaterThan', label: 'Greater Than' }
    ]
  }
};

describe('1. Cursor-Context Analyzer', () => {
  it('未闭合调用 ShootBullet(10000, | 返回正确的 activeCall 与 activeArgumentIndex', () => {
    const text = `$Event(10000, Default, function() {
    ShootBullet(10000, `;
    const ctx = analyzeCursorContext(text, text.length);

    assert.ok(ctx.activeCall);
    assert.equal(ctx.activeCall.name, 'ShootBullet');
    assert.equal(ctx.activeCall.activeArgumentIndex, 1);
    assert.equal(ctx.activeCall.isClosed, false);
    assert.equal(ctx.enclosingEvent?.eventId, 10000);
  });

  it('跨行嵌套 WaitFor 内未闭合谓词正常工作', () => {
    const text = `$Event(20000, Default, function() {
    WaitFor(
        CharacterDead(X0_4)
        && CharacterHasSpEffect(`;
    const ctx = analyzeCursorContext(text, text.length);

    assert.ok(ctx.activeCall);
    assert.equal(ctx.activeCall.name, 'CharacterHasSpEffect');
    assert.equal(ctx.activeCall.activeArgumentIndex, 0);
    assert.equal(ctx.isInWaitFor, true);
    assert.ok(ctx.enclosingEvent?.parameterSlots.includes('X0_4'));
  });

  it('注释与字符串内正确标记 isInComment / isInString', () => {
    const commentText = '// ShootBullet(10000, ';
    const commentCtx = analyzeCursorContext(commentText, 10);
    assert.equal(commentCtx.isInComment, true);

    const stringText = 'const str = "ShootBullet(";';
    const stringCtx = analyzeCursorContext(stringText, 16);
    assert.equal(stringCtx.isInString, true);
  });
});

describe('2. Signature Help / Parameter Info', () => {
  it('输入 ShootBullet( 立即返回第 0 个参数 ownerEntityId', () => {
    const text = 'ShootBullet(';
    const ctx = analyzeCursorContext(text, text.length);
    const sig = getSignatureHelp(ctx, SAMPLE_CATALOG, SAMPLE_ENUMS);

    assert.ok(sig);
    assert.equal(sig.instructionName, 'ShootBullet');
    assert.equal(sig.activeParameterIndex, 0);
    assert.equal(sig.activeParameter?.name, 'ownerEntityId');
    assert.equal(sig.activeParameter?.type, 's32');
  });

  it('输入 ShootBullet(10000, 推进到第 1 个参数 sourceEntityId', () => {
    const text = 'ShootBullet(10000, ';
    const ctx = analyzeCursorContext(text, text.length);
    const sig = getSignatureHelp(ctx, SAMPLE_CATALOG, SAMPLE_ENUMS);

    assert.ok(sig);
    assert.equal(sig.activeParameterIndex, 1);
    assert.equal(sig.activeParameter?.name, 'sourceEntityId');
  });

  it('Enum 参数提供结构化 enumMembers', () => {
    const text = 'IfParameterComparison(0, ';
    const ctx = analyzeCursorContext(text, text.length);
    const sig = getSignatureHelp(ctx, SAMPLE_CATALOG, SAMPLE_ENUMS);

    assert.ok(sig);
    assert.equal(sig.activeParameterIndex, 1);
    assert.equal(sig.activeParameter?.enumName, 'ComparisonType');
    assert.ok(sig.activeParameter?.enumMembers);
    assert.equal(sig.activeParameter?.enumMembers?.length, 3);
    assert.equal(sig.activeParameter?.enumMembers?.[0]?.name, 'Equal');
  });
});

describe('3. Ranking Autocomplete & Snippets', () => {
  it('Ranking 算法优先 Exact > Prefix > CamelCase > Subsequence', () => {
    assert.ok(scoreMatch('ShootBullet', 'ShootBullet') > scoreMatch('Shoot', 'ShootBullet'));
    assert.ok(scoreMatch('Shoot', 'ShootBullet') > scoreMatch('ShtBul', 'ShootBullet'));
    assert.ok(scoreMatch('ShtBul', 'ShootBullet') > scoreMatch('shbu', 'ShootBullet'));
  });

  it('输入 Sho 时 ShootBullet 出现在补全候选并包含 Snippet 骨架', () => {
    const text = 'Sho';
    const ctx = analyzeCursorContext(text, text.length);
    const candidates = getCompletions({
      context: ctx,
      catalog: SAMPLE_CATALOG,
      enums: SAMPLE_ENUMS
    });

    assert.ok(candidates.length > 0);
    const top = candidates.find((c) => c.label === 'ShootBullet');
    assert.ok(top);
    assert.equal(top.kind, 'function');
    assert.equal(top.snippet, 'ShootBullet(${1:ownerEntityId}, ${2:sourceEntityId}, ${3:dummyPolyId}, ${4:bulletId})$0');
  });

  it('在 Enum 参数位自动建议 Enum Members', () => {
    const text = 'IfParameterComparison(0, ';
    const ctx = analyzeCursorContext(text, text.length);
    const candidates = getCompletions({
      context: ctx,
      catalog: SAMPLE_CATALOG,
      enums: SAMPLE_ENUMS
    });

    const enumCandidate = candidates.find((c) => c.label === 'ComparisonType.Equal');
    assert.ok(enumCandidate);
    assert.equal(enumCandidate.kind, 'enum-member');
  });

  it('当前 Event 有 X0_4 时在参数位提供建议，另一个没有的 Event 不提供', () => {
    const eventWithParams = `$Event(10000, Default, function() {
    ShootBullet(X0_4, 1, 2, 3);
    ShootBullet(`;
    const ctx1 = analyzeCursorContext(eventWithParams, eventWithParams.length);
    const cands1 = getCompletions({ context: ctx1, catalog: SAMPLE_CATALOG });
    assert.ok(cands1.some((c) => c.label === 'X0_4'));

    const eventWithoutParams = `$Event(20000, Default, function() {
    ShootBullet(`;
    const ctx2 = analyzeCursorContext(eventWithoutParams, eventWithoutParams.length);
    const cands2 = getCompletions({ context: ctx2, catalog: SAMPLE_CATALOG });
    assert.ok(!cands2.some((c) => c.label === 'X0_4'));
  });
});

describe('4. Live Diagnostics & Quick Fix', () => {
  it('识别拼写错误 ShootBulelt 并提供 Quick Fix 建议', () => {
    const text = `$Event(10000, Default, function() {
    ShootBulelt(1, 2, 3, 4);
});`;
    const diags = computeDocumentDiagnostics(text, SAMPLE_CATALOG, SAMPLE_ENUMS);
    assert.ok(diags.some((d) => d.code === 'EMEVD_UNKNOWN_INSTRUCTION' && d.message.includes('ShootBullet')));

    const fixes = getQuickFixesAt(text.indexOf('ShootBulelt') + 2, diags, text, SAMPLE_CATALOG, SAMPLE_ENUMS);
    assert.ok(fixes.some((f) => f.replacement === 'ShootBullet'));
  });

  it('检测参数数量不匹配', () => {
    const text = `$Event(10000, Default, function() {
    ShootBullet(1, 2);
});`;
    const diags = computeDocumentDiagnostics(text, SAMPLE_CATALOG, SAMPLE_ENUMS);
    assert.ok(diags.some((d) => d.code === 'EMEVD_ARG_COUNT_MISMATCH'));
  });

  it('检测整数溢出 (s8 传入 300)', () => {
    const text = `$Event(10000, Default, function() {
    IfParameterComparison(300, 0, 0);
});`;
    const diags = computeDocumentDiagnostics(text, SAMPLE_CATALOG, SAMPLE_ENUMS);
    assert.ok(diags.some((d) => d.code === 'EMEVD_INTEGER_OVERFLOW'));
  });

  it('检测重复 Event ID', () => {
    const text = `$Event(10000, Default, function() {});
$Event(10000, Restart, function() {});`;
    const diags = computeDocumentDiagnostics(text, SAMPLE_CATALOG, SAMPLE_ENUMS);
    assert.ok(diags.some((d) => d.code === 'EMEVD_DUPLICATE_EVENT_ID'));
  });
});

describe('5. Symbol Indexer & Navigation', () => {
  it('索引事件大纲与引用关系', () => {
    const text = `$Event(10000, Default, function() {
    ShootBullet(X0_4, 1, 2, 3);
});

$Event(20000, Restart, function() {
    InitializeEvent(0, 10000);
});`;
    const index = indexDocumentSymbols(text);
    assert.equal(index.symbols.length, 2);
    assert.equal(index.symbols[0]?.eventId, 10000);
    assert.deepEqual(index.symbols[0]?.parameterSlots, ['X0_4']);

    const refs = findEventReferences(10000, index);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.callingEventId, 20000);
  });

  it('Ctrl+Shift+O 模糊搜索 Event 符号', () => {
    const text = `$Event(10000, Default, function() {});
$Event(20000, Restart, function() {});`;
    const index = indexDocumentSymbols(text);
    const searchRes = searchEventSymbols('20000', index.symbols);
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0]?.eventId, 20000);
  });
});

describe('6. Deterministic Formatter', () => {
  it('格式化事件与指令缩进', () => {
    const unformatted = `$Event(10000,Default,function(){
ShootBullet(1,2,3,4);
});`;
    const formatted = formatEventDocument(unformatted);
    const expected = `$Event(10000, Default, function() {
    ShootBullet(1, 2, 3, 4);
});
`;
    assert.equal(formatted, expected);
  });
});
