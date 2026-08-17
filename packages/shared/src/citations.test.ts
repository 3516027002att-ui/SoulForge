import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCiteHit,
  decodeCiteHits,
  formatCitationLabel,
  formatParamCiteLabel,
  mergeCiteHits,
  type CiteHit,
  type ParamCitation
} from './citations.js';

const rowHit: CiteHit = {
  kind: 'param-row',
  library: 'gameparam',
  table: 'SpEffectParam',
  rowId: 3400,
  name: '噬神'
};
const fieldHit: CiteHit = {
  kind: 'param-field',
  library: 'gameparam',
  table: 'SpEffectParam',
  rowId: 3400,
  fieldId: 'maxHpRate',
  label: '减少百分比生命值',
  value: '-100'
};

test('decodeCiteHit：接受 param-row 与 param-field 的合法命中', () => {
  assert.deepEqual(decodeCiteHit(rowHit), rowHit);
  assert.deepEqual(decodeCiteHit(fieldHit), fieldHit);
});

test('decodeCiteHit：rowId 缺省 / 非数字时拒绝', () => {
  assert.throws(() => decodeCiteHit({ ...rowHit, rowId: undefined }), /行 id/);
  assert.throws(() => decodeCiteHit({ ...rowHit, rowId: '3400' }), /行 id/);
});

test('decodeCiteHit：拒绝未知 kind', () => {
  assert.throws(() => decodeCiteHit({ ...rowHit, kind: 'hex-byte' }), /不支持的引用命中类型/);
});

test('decodeCiteHit：标识符含路径或分隔符时拒绝', () => {
  assert.throws(() => decodeCiteHit({ ...rowHit, table: 'D:\\SpEffectParam' }), /绝对路径|逻辑名/);
  assert.throws(() => decodeCiteHit({ ...rowHit, library: '/etc' }), /绝对路径|逻辑名/);
  assert.throws(() => decodeCiteHit({ ...fieldHit, fieldId: 'a b' }), /逻辑名/);
});

test('decodeCiteHit：param-field 缺 fieldId 时拒绝', () => {
  assert.throws(() => decodeCiteHit({ ...fieldHit, fieldId: '' }), /字段 id/);
});

test('decodeCiteHit：param-row 缺 name 时省略该字段（不报错）', () => {
  const hit = decodeCiteHit({ kind: 'param-row', library: 'gameparam', table: 'T', rowId: 1 });
  assert.deepEqual(hit, { kind: 'param-row', library: 'gameparam', table: 'T', rowId: 1 });
});

test('decodeCiteHits：空数组 / 非数组视为非法（空框选不产生引用）', () => {
  assert.throws(() => decodeCiteHits([]), /为空/);
  assert.throws(() => decodeCiteHits(null), /为空/);
});

test('decodeCiteHits：逐条解码，坏条目报出位置', () => {
  assert.throws(() => decodeCiteHits([rowHit, { ...fieldHit, rowId: 'x' }]), /第 2 条命中无效/);
});

test('mergeCiteHits：行 + 多个字段合并成一条引用，字段按框选顺序', () => {
  const secondField: CiteHit = {
    ...fieldHit,
    fieldId: 'maxHp',
    label: '减少绝对生命值',
    value: '-10000'
  };
  const citation = mergeCiteHits([fieldHit, rowHit, secondField]);
  assert.deepEqual(citation, {
    kind: 'param',
    library: 'gameparam',
    table: 'SpEffectParam',
    rowId: 3400,
    rowName: '噬神',
    fields: [
      { fieldId: 'maxHpRate', label: '减少百分比生命值', value: '-100' },
      { fieldId: 'maxHp', label: '减少绝对生命值', value: '-10000' }
    ]
  });
});

test('mergeCiteHits：同字段重复命中只保留一条（框选重叠）', () => {
  const citation = mergeCiteHits([rowHit, fieldHit, fieldHit]);
  assert.equal(citation?.kind === 'param' ? citation.fields.length : -1, 1);
});

test('mergeCiteHits：只有行 → 合并出无字段引用', () => {
  const citation = mergeCiteHits([rowHit]);
  assert.deepEqual(citation, {
    kind: 'param',
    library: 'gameparam',
    table: 'SpEffectParam',
    rowId: 3400,
    rowName: '噬神',
    fields: []
  });
});

test('mergeCiteHits：只有字段 → 引用保留行 id，rowName 缺省', () => {
  const citation = mergeCiteHits([fieldHit]);
  assert.equal(citation?.kind, 'param');
  assert.equal(citation?.kind === 'param' ? citation.rowId : null, 3400);
  assert.equal(citation?.kind === 'param' ? citation.rowName : 'unset', undefined);
});

test('mergeCiteHits：框选扫到其他行视为误框——字段命中锚定行，其余行丢弃不并入', () => {
  // 字段栏永远显示选中行的字段；框里扫到同表其他行（100 之外）不并入。
  const otherRow: CiteHit = {
    kind: 'param-row', library: 'gameparam', table: 'SpEffectParam', rowId: 3401, name: '别的行'
  };
  const citation = mergeCiteHits([rowHit, otherRow, fieldHit]);
  assert.deepEqual(citation, {
    kind: 'param',
    library: 'gameparam',
    table: 'SpEffectParam',
    rowId: 3400,
    rowName: '噬神',
    fields: [{ fieldId: 'maxHpRate', label: '减少百分比生命值', value: '-100' }]
  });
});

test('mergeCiteHits：只有行时取第一行为锚，其余行丢弃（一次框选一条 chip）', () => {
  const secondRow: CiteHit = {
    kind: 'param-row', library: 'gameparam', table: 'SpEffectParam', rowId: 3401, name: '别的行'
  };
  const citation = mergeCiteHits([rowHit, secondRow]);
  assert.deepEqual(citation, {
    kind: 'param',
    library: 'gameparam',
    table: 'SpEffectParam',
    rowId: 3400,
    rowName: '噬神',
    fields: []
  });
});

test('mergeCiteHits：完全没有行也没有字段返回 null', () => {
  assert.equal(mergeCiteHits([]), null);
});

test('formatParamCiteLabel：行 + 字段，S10 拍死格式', () => {
  const citation: ParamCitation = {
    kind: 'param',
    library: 'gameparam',
    table: 'SpEffectParam',
    rowId: 3400,
    rowName: '噬神',
    fields: [
      { fieldId: 'maxHpRate', label: '减少百分比生命值', value: '-100' },
      { fieldId: 'maxHp', label: '减少绝对生命值', value: '-10000' }
    ]
  };
  assert.equal(
    formatParamCiteLabel(citation),
    'param/gameparam/SpEffectParam/3400-噬神【减少百分比生命值：-100】【减少绝对生命值：-10000】'
  );
});

test('formatParamCiteLabel：只有行 → 只到行名', () => {
  assert.equal(
    formatParamCiteLabel({ kind: 'param', library: 'gameparam', table: 'SpEffectParam', rowId: 3400, rowName: '噬神', fields: [] }),
    'param/gameparam/SpEffectParam/3400-噬神'
  );
});

test('formatParamCiteLabel：行无名字 → 省略行名段', () => {
  assert.equal(
    formatParamCiteLabel({ kind: 'param', library: 'gameparam', table: 'SpEffectParam', rowId: 3400, fields: [] }),
    'param/gameparam/SpEffectParam/3400'
  );
});

test('formatParamCiteLabel：标签不含磁盘路径形态', () => {
  const label = formatParamCiteLabel({
    kind: 'param',
    library: 'gameparam',
    table: 'ActionGuideParam',
    rowId: 100,
    rowName: '引导-基础',
    fields: [{ fieldId: 'f_atk', label: '攻击力', value: '0' }]
  });
  // 标签里的 / 是逻辑路径分隔符；禁止的是反斜杠、盘符、前导分隔符与 .. 段。
  assert.ok(!label.includes('\\'));
  assert.ok(!/^[a-zA-Z]:/.test(label));
  assert.ok(!label.startsWith('/'));
  assert.ok(!label.includes('..'));
});

/* ── S10 扩展：text-entry / event-script ─────────────────────────── */

const textHit: CiteHit = {
  kind: 'text-entry',
  library: 'text',
  table: 'text:ja:item:item.msgbnd:6',
  entryId: 1000,
  text: '龙泉河畔 平田宅邸'
};
const eventHit: CiteHit = {
  kind: 'event-script',
  library: 'event',
  script: 'file://workspace/event/common.emevd.dcx',
  label: 'common'
};

test('decodeCiteHit：接受 text-entry（table 带冒号 stableId）与 event-script（逻辑 URI script）', () => {
  assert.deepEqual(decodeCiteHit(textHit), textHit);
  assert.deepEqual(decodeCiteHit(eventHit), eventHit);
});

test('decodeCiteHit：text-entry 缺 entryId / table 空时拒绝；table 含盘符拒绝', () => {
  assert.throws(() => decodeCiteHit({ ...textHit, entryId: undefined }), /条目 id/);
  assert.throws(() => decodeCiteHit({ ...textHit, table: '' }), /table/);
  assert.throws(() => decodeCiteHit({ ...textHit, table: 'D:\\x' }), /绝对路径|盘符/);
});

test('decodeCiteHit：event-script 缺 label 拒绝；script 含盘符拒绝', () => {
  assert.throws(() => decodeCiteHit({ ...eventHit, label: '' }), /脚本标签/);
  assert.throws(() => decodeCiteHit({ ...eventHit, script: 'D:\\x\\common' }), /绝对路径|盘符/);
});

test('mergeCiteHits：text-entry 命中 → text 引用（重复命中去重）', () => {
  assert.deepEqual(mergeCiteHits([textHit]), {
    kind: 'text',
    library: 'text',
    table: 'text:ja:item:item.msgbnd:6',
    entryId: 1000,
    text: '龙泉河畔 平田宅邸'
  });
  const dup = mergeCiteHits([textHit, textHit]);
  assert.equal(dup?.kind === 'text' ? dup.entryId : null, 1000);
});

test('mergeCiteHits：event-script 命中 → event 引用', () => {
  assert.deepEqual(mergeCiteHits([eventHit]), {
    kind: 'event',
    library: 'event',
    script: 'file://workspace/event/common.emevd.dcx',
    label: 'common'
  });
});

test('mergeCiteHits：混合 kind 不跨类合并，取第一组', () => {
  const citation = mergeCiteHits([textHit, eventHit]);
  assert.equal(citation?.kind, 'text');
});

test('formatCitationLabel：text/event 形态，param 走原格式', () => {
  assert.equal(formatCitationLabel({
    kind: 'text', library: 'text', table: 'text:ja:item:item.msgbnd:6', entryId: 1000
  }), 'text/text/text:ja:item:item.msgbnd:6/1000');
  assert.equal(formatCitationLabel({
    kind: 'event', library: 'event', script: 'file://workspace/event/common.emevd.dcx', label: 'common'
  }), 'event/event/file://workspace/event/common.emevd.dcx');
  assert.equal(
    formatCitationLabel({ kind: 'param', library: 'gameparam', table: 'T', rowId: 1, fields: [] }),
    'param/gameparam/T/1'
  );
});
