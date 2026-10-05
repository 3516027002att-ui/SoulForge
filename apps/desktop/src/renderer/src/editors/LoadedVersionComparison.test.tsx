import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadedVersionComparison, LoadedScriptComparison, LoadedFieldComparison } from './LoadedVersionComparison.js';
import { compareLoadedFields, compareLoadedSource } from './loadedVersionDiff.js';

describe('载入版本源码比较', () => {
  it('相同文本没有差异，空文本不是缺失基线', () => {
    assert.deepEqual(compareLoadedSource('', '').lines, []);
    assert.deepEqual(compareLoadedSource('return 1\n', 'return 1\n').lines, []);
    assert.equal(compareLoadedSource('', 'return 1').lines.filter(l => l.kind === 'add')[0]?.text, 'return 1');
    assert.equal(compareLoadedSource('return 1', '').lines.filter(l => l.kind === 'remove')[0]?.text, 'return 1');
  });

  it('替换、连续编辑与撤回每次都取当前文本', () => {
    const loaded = 'a\nb\nc';
    const first = compareLoadedSource(loaded, 'a\nfirst\nc');
    const second = compareLoadedSource(loaded, 'a\nsecond\nc');
    assert.equal(first.lines.find(l => l.kind === 'remove')?.text, 'b');
    assert.equal(second.lines.find(l => l.kind === 'add')?.text, 'second');
    assert.deepEqual(compareLoadedSource(loaded, loaded).lines, []);
  });

  it('真实内容的 ---/+++、引号和空白不当成文件头，不归一换行', () => {
    const change = compareLoadedSource('--- x\n"old"\r\n', '+++ x\n\tnew\n');
    assert.ok(change.lines.some(l => l.kind === 'remove' && l.text === '--- x'));
    assert.ok(change.lines.some(l => l.kind === 'add' && l.text === '+++ x'));
    assert.ok(change.lines.some(l => l.kind === 'remove' && l.text === '"old"\r'));
    assert.ok(change.lines.some(l => l.kind === 'add' && l.text === '\tnew'));
    assert.ok(compareLoadedSource('a', 'a\n').lines.some(l => l.kind === 'add' && l.text === ''));
  });

  it('大文件单行变更只比较公共边缘间的小窗口，行号仍是原文行号', () => {
    const before = Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`);
    const after = [...before]; after[5000] = 'changed';
    const view = compareLoadedSource(before.join('\n'), after.join('\n'));
    assert.equal(view.coarse, false);
    assert.equal(view.lines.find(l => l.kind === 'remove')?.oldLine, 5001);
    assert.equal(view.lines.find(l => l.kind === 'add')?.newLine, 5001);
    assert.ok(view.lines.length < 20);
  });

  it('宽范围修改有明确的整段/截断提示，原文本行不改写', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 1000 }, (_, i) => `new ${i}`);
    const view = compareLoadedSource(before.join('\n'), after.join('\n'));
    assert.equal(view.coarse, true);
    assert.ok(view.omittedLines > 0);
    assert.ok(view.lines.length <= 400);
    assert.equal(view.lines.find(l => l.kind === 'remove')?.text, before[0]);
    assert.equal(view.lines.at(-1)?.text, after.at(-1));
  });
});

describe('载入字段比较投影', () => {
  const fields = [{ id: 'a', name: '强度', type: 'f64' }, { id: 'b', name: '开关', type: 'bool' }];
  const loaded = new Map([
    ['a', { display: '1.2346', comparisonDisplay: '1.23456789' }],
    ['b', { display: 'false' }]
  ]);

  it('未触碰的精确浮点值不会因编辑框四位投影制造差异', () => {
    assert.deepEqual(compareLoadedFields(fields, loaded, {}), []);
    assert.deepEqual(compareLoadedFields(fields, loaded, { a: '1.23456789' }), []);
  });

  it('真实草稿保留空串、非法数值、纯空白和类型，不强制转成数字', () => {
    for (const draft of ['', 'not a number', ' \t ', '1.2346']) {
      assert.deepEqual(compareLoadedFields(fields, loaded, { a: draft }), [
        { id: 'a', name: '强度', type: 'f64', before: '1.23456789', after: draft }
      ]);
    }
    assert.equal(compareLoadedFields(fields, loaded, { b: 'true' })[0]?.before, 'false');
  });

  it('载入 -0/NaN 保持字符串区别，回到准确载入值才清除差异', () => {
    const special = new Map([['a', { display: '0', comparisonDisplay: '-0' }]]);
    assert.equal(compareLoadedFields(fields, special, { a: '0' })[0]?.before, '-0');
    assert.deepEqual(compareLoadedFields(fields, special, { a: '-0' }), []);
    const nan = new Map([['a', { display: 'NaN', comparisonDisplay: 'NaN' }]]);
    assert.deepEqual(compareLoadedFields(fields, nan, { a: 'NaN' }), []);
    assert.equal(compareLoadedFields(fields, nan, { a: '0' })[0]?.before, 'NaN');
  });

  it('重新载入/换行清空草稿后无旧比较；缺失和解码失败不给假前值', () => {
    assert.deepEqual(compareLoadedFields(fields, new Map([['a', { display: '2' }]]), {}), []);
    assert.deepEqual(compareLoadedFields(fields, null, { a: '2' }), []);
    assert.deepEqual(compareLoadedFields(fields, new Map(), { a: '2' }), []);
    assert.deepEqual(compareLoadedFields(fields, new Map([['a', { display: '（解码失败）', diagnostic: '失败' }]]), { a: '2' }), []);
    assert.deepEqual(compareLoadedFields(fields, loaded, { unknown: '2' }), []);
  });
});

describe('载入版本比较只读呈现', () => {
  it('默认收起且不计算/挂载子比较，不加写入按钮', () => {
    let rendered = 0;
    const Child = () => { rendered += 1; return <span>hidden</span>; };
    const html = renderToStaticMarkup(<LoadedVersionComparison><Child /></LoadedVersionComparison>);
    assert.match(html, /<summary>与载入版本比较<\/summary>/);
    assert.doesNotMatch(html, /\bopen=|hidden|<button|<input/);
    assert.equal(rendered, 0);
  });

  it('源码替换有红删除/绿新增、独立符号与可读基线说明，HTML 内容转义', () => {
    const html = renderToStaticMarkup(<LoadedScriptComparison before={'old <script>\n'} after={'new & text\n'} />);
    assert.match(html, /loaded-comparison__line is-remove/);
    assert.match(html, /loaded-comparison__line is-add/);
    assert.match(html, /−|-/);
    assert.match(html, /\+/);
    assert.match(html, /载入版本/);
    assert.match(html, /当前草稿/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /new &amp; text/);
    assert.doesNotMatch(html, /<script>|<button|<input/);
  });

  it('字段旧值/草稿文本及类型原样展示；失焦保存与基线更新文案明确', () => {
    const html = renderToStaticMarkup(<LoadedFieldComparison fields={[{ id: 'v', name: '数值', type: 'f64' }]} loaded={new Map([['v', { display: '0', comparisonDisplay: '-0' }]])} drafts={{ v: '<invalid>' }} />);
    assert.match(html, /f64/);
    assert.match(html, /-0/);
    assert.match(html, /&lt;invalid&gt;/);
    assert.match(html, /失焦/);
    assert.match(html, /重新载入/);
    assert.doesNotMatch(html, /<button|<input/);
  });

  it('空源码和空字段草稿仍显示真实增删，相同文本显示无差异', () => {
    const html = renderToStaticMarkup(<LoadedScriptComparison before="return 1" after="" />);
    assert.match(html, /is-remove/);
    assert.match(renderToStaticMarkup(<LoadedScriptComparison before="" after="" />), /没有草稿差异/);
    const empty = renderToStaticMarkup(<LoadedFieldComparison fields={[{ id: 'v', name: '数值', type: 'u8' }]} loaded={new Map([['v', { display: '1' }]])} drafts={{ v: '' }} />);
    assert.match(empty, /空串/);
  });

  it('大差异/超长行截断向用户明示，不把隐藏内容称为完整比较', () => {
    const old = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join('\n');
    const next = Array.from({ length: 1000 }, (_, i) => `new ${i}`).join('\n');
    const html = renderToStaticMarkup(<LoadedScriptComparison before={old} after={next} />);
    assert.match(html, /整段/);
    assert.match(html, /未显示/);
    const long = renderToStaticMarkup(<LoadedScriptComparison before="a" after={'b'.repeat(5000)} />);
    assert.match(long, /本行.*未显示/);
    assert.ok(long.length < 10000);
  });
});
