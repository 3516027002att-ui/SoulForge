/**
 * emevdPendingTab 单测：一次 readEmevdFullDocument 响应 → 工作台标签。
 *
 * 钉住的核心契约是「gutter 判据来自 outline，而不是来自另一次 readEmevdDocument
 * 的采样投影」。旧路径的错误形态在这里作为对照被显式钉住：outline 的
 * unknownCount 与事件在文件里的位置无关，第 256 条指令之后的事件也必须是它自己
 * 的真实计数。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emevdPendingTabFromFullDocument,
  eventWarningRowsFromOutline,
  type EmevdFullDocumentResponseLike
} from './emevdPendingTab.js';
import { eventWarningRowsOf, indexEventLines } from '../editors/EventSourceWorkbenchPanel.js';

function outlineOf(
  rows: Array<{ eventId: number; instructionCount: number; unknownCount: number }>,
  options: { truncated?: boolean; limit?: number; eventCount?: number } = {}
): NonNullable<EmevdFullDocumentResponseLike['outline']> {
  return {
    eventCount: options.eventCount ?? rows.length,
    instructionTotal: rows.reduce((n, row) => n + row.instructionCount, 0),
    truncated: options.truncated ?? false,
    limit: options.limit ?? 4096,
    events: rows
  };
}

function fullOf(
  outline: EmevdFullDocumentResponseLike['outline'],
  extra: Partial<EmevdFullDocumentResponseLike> = {}
): EmevdFullDocumentResponseLike {
  return { ok: true, revision: 0, sourceHash: 'sha256:abc', outline, ...extra };
}

describe('eventWarningRowsFromOutline', () => {
  it('按 outline 顺序给出 (eventId, unknownCount)', () => {
    const rows = eventWarningRowsFromOutline(outlineOf([
      { eventId: 50, instructionCount: 3, unknownCount: 1 },
      { eventId: 60, instructionCount: 2, unknownCount: 0 }
    ]));
    assert.deepEqual(rows, [
      { eventId: 50, warnings: 1 },
      { eventId: 60, warnings: 0 }
    ]);
  });

  it('outline 缺失时是空数组（不是抛错，也不是伪造行）', () => {
    assert.deepEqual(eventWarningRowsFromOutline(null), []);
    assert.deepEqual(eventWarningRowsFromOutline(undefined), []);
  });
});

describe('emevdPendingTabFromFullDocument', () => {
  const full = fullOf(outlineOf([
    { eventId: 50, instructionCount: 3, unknownCount: 1 },
    { eventId: 60, instructionCount: 2, unknownCount: 0 }
  ]), { documentInstanceId: 'doc-9', revision: 7 });

  const tab = emevdPendingTabFromFullDocument({
    tabId: 'file://event/common.emevd',
    title: 'event/common.emevd',
    resourceUri: 'file://event/common.emevd',
    full,
    dslTemplate: '$Event(50, Default, function() {\n});\n$Event(60, Default, function() {\n});',
    dslTemplateTruncated: false,
    dslTemplateTotalLines: 4,
    sourceStyle: 'dark-script'
  });

  it('live 标签的 document 不带指令体，并显式说明原因', () => {
    assert.deepEqual(tab.document.events, []);
    assert.equal(tab.live, true);
    const codes = tab.document.diagnostics.map((d) => d.code);
    assert.ok(codes.includes('EMEVD_INSTRUCTION_BODIES_STAY_IN_MAIN'));
    // document.events 为空 ⇒ eventWarnings 必须存在，否则 eventWarningRowsOf 会
    // 回退到「按空 events 现算」= 一行判据都没有，整个 gutter 静默失效。
    assert.ok(tab.eventWarnings !== undefined, 'live 标签必须自带 eventWarnings');
  });

  it('不伪造 bank/id 占位指令（避免把「没下发」冒充成「已解析」）', () => {
    const serialized = JSON.stringify(tab.document);
    assert.doesNotMatch(serialized, /"bank"/);
    assert.doesNotMatch(serialized, /"argsBase64"/);
  });

  it('透传 sourceHash / revision / documentInstanceId', () => {
    assert.equal(tab.sourceHash, 'sha256:abc');
    assert.equal(tab.document.revision, 7);
    assert.equal(tab.document.documentInstanceId, 'doc-9');
  });

  it('gutter 判据来自 outline，工作台按 $Event( 顺序命中', () => {
    const rows = eventWarningRowsOf(tab);
    assert.deepEqual(rows, [
      { eventId: 50, warnings: 1 },
      { eventId: 60, warnings: 0 }
    ]);
    const lines = indexEventLines(tab.dslTemplate!, rows);
    // 第 1 行是 $Event(50 —— 1 条未知；$Event(60 无未知，不打标记。
    assert.deepEqual([...lines.entries()], [[1, { eventId: 50, warnings: 1 }]]);
  });

  it('第 256 条指令之后的事件仍是自己的真实计数（旧采样路径的错误形态对照）', () => {
    // 旧路径：readEmevdDocument 的 instructionsSample 默认只覆盖前 256 条指令，
    // 做投影的 mapEmevdEnvelopeToDocument（已随本次改动删除）把采样不到的指令一律
    // 记 unknown:true，于是这个起始下标 300 的事件会被标成「3 条全未知」。outline
    // 走完整 registry 判定，真实值是 0。
    const late = emevdPendingTabFromFullDocument({
      tabId: 't',
      title: 't',
      resourceUri: 'file://event/common.emevd',
      full: fullOf(outlineOf([{ eventId: 9000, instructionCount: 3, unknownCount: 0 }])),
      dslTemplate: '$Event(9000, Default, function() {\n});',
      dslTemplateTruncated: false,
      dslTemplateTotalLines: 2,
      sourceStyle: 'dark-script'
    });
    assert.deepEqual(eventWarningRowsOf(late), [{ eventId: 9000, warnings: 0 }]);
    assert.equal(indexEventLines(late.dslTemplate!, eventWarningRowsOf(late)).size, 0);
  });

  it('e2e fixture 的原样形态：patch-dsl 模板 + 缺采样的 event 60 → 只有 event 60 一处标记', () => {
    // 这条钉的是 EVENT-30B（renderer.spec.mjs「diagnostic gutter 标注未知指令」）
    // 依赖的那份数据。之所以在单测里再钉一遍：该 e2e 现在跑不到断言 ——
    // openFixtureWorkspace 等 `.status-bar`，而 App.tsx 的状态栏正被另一路改动摘走
    // 且无人渲染，测试在进入事件工作台之前就超时。那是与本改动无关的外部原因，
    // 但不能因此让这条数据路径没有任何自动化覆盖。
    //
    // 形态取自 apps/desktop/e2e/playwright/fixture-main.mjs 的
    // fixture://event/common.emevd：events 50/60 各 1 条指令，instructionsSample
    // 只有 index 0，于是 bank.outline() 判出 50→0 未知、60→1 未知（注意与上面
    // $Event 用例相反：这里缺的是 event 60 的那条）。模板是 patch-dsl 形状，
    // 事件头写作 `event @e:ev50 {`，与 $Event( 完全不同 —— 正是 indexEventLines
    // 必须同时认的第二种锚形。
    const fixtureTab = emevdPendingTabFromFullDocument({
      tabId: 'fixture://event/common.emevd',
      title: 'event/common.emevd',
      resourceUri: 'fixture://event/common.emevd',
      full: fullOf(outlineOf([
        { eventId: 50, instructionCount: 1, unknownCount: 0 },
        { eventId: 60, instructionCount: 1, unknownCount: 1 }
      ])),
      dslTemplate: [
        'resource "fixture://event/common.emevd"',
        'base revision 0 schema "sekiro"',
        'event @e:ev50 {',
        '  set id = 50',
        '  set rest = 1',
        '  instruction @i:ev50-0 { set arg bank = 0; set arg id = 0; }',
        '}',
        'event @e:ev60 {',
        '  set id = 60',
        '  set rest = 0',
        '  // read-only ev60-0 bank=1 id=20',
        '}',
        ''
      ].join('\n'),
      dslTemplateTruncated: false,
      dslTemplateTotalLines: 13,
      sourceStyle: 'patch-dsl'
    });
    const rows = eventWarningRowsOf(fixtureTab);
    assert.deepEqual(rows, [
      { eventId: 50, warnings: 0 },
      { eventId: 60, warnings: 1 }
    ]);
    const lines = indexEventLines(fixtureTab.dslTemplate!, rows);
    // e2e 断言的是「恰好 1 个 warn marker，title 含 Event 60」。行号 8 =
    // `event @e:ev60 {`（1-based）。event 50 无未知，不打标记。
    assert.deepEqual([...lines.entries()], [[8, { eventId: 60, warnings: 1 }]]);
  });

  it('outline 被截断时挂显式诊断（不静默少打标记）', () => {
    const truncated = emevdPendingTabFromFullDocument({
      tabId: 't',
      title: 't',
      resourceUri: 'file://event/common.emevd',
      full: fullOf(outlineOf(
        [{ eventId: 1, instructionCount: 1, unknownCount: 1 }],
        { truncated: true, limit: 1, eventCount: 5000 }
      )),
      dslTemplate: '$Event(1, Default, function() {\n});',
      dslTemplateTruncated: false,
      dslTemplateTotalLines: 2,
      sourceStyle: 'dark-script'
    });
    const codes = truncated.document.diagnostics.map((d) => d.code);
    assert.ok(codes.includes('EMEVD_OUTLINE_TRUNCATED'));
  });
});

describe('eventWarningRowsOf 回退（只读 demo / 读取失败 / 手搓文档）', () => {
  it('没有 eventWarnings 时按 document.events 现算', () => {
    const rows = eventWarningRowsOf({
      tabId: 't',
      title: 't',
      resourceUri: 'file://event/x.emevd',
      document: {
        schemaVersion: 1,
        resourceUri: 'file://event/x.emevd',
        revision: 0,
        events: [{
          eventUri: 'file://event/x.emevd#event/1',
          eventId: 1,
          restBehavior: 0,
          layer: -1,
          instructions: [
            { instructionUri: 'u0', bank: 9999, id: 1, argsBase64: '', unknown: true },
            { instructionUri: 'u1', bank: 2000, id: 0, argsBase64: '', unknown: false }
          ]
        }],
        bytesBase64: '',
        diagnostics: []
      },
      sourceHash: null,
      live: false,
      dslTemplate: null,
      dslTemplateTruncated: false,
      dslTemplateTotalLines: 0
    });
    assert.deepEqual(rows, [{ eventId: 1, warnings: 1 }]);
  });

  it('renderSource 形态（event @e:<eventId>）按 eventId 命中', () => {
    const lines = indexEventLines(
      'resource "x"\nevent @e:50 {\n  set id = 50\n}\nevent @e:60 {\n}',
      [{ eventId: 50, warnings: 2 }, { eventId: 60, warnings: 0 }]
    );
    assert.deepEqual([...lines.entries()], [[2, { eventId: 50, warnings: 2 }]]);
  });

  it('锚不是 eventId（挂过 stableIdentity 的 localNodeId）时按块顺序命中', () => {
    // 24 位 hex 锚跟 eventId 无关，从 rows 里查不到。原实现在这里直接跳过，
    // 于是「文档挂了锚」反而让整列 gutter 标记消失；现在退回按出现顺序对齐。
    const lines = indexEventLines(
      'resource "x"\n'
      + 'event @e:0f1e2d3c4b5a69788796a5b4 {\n}\n'
      + 'event @e:112233445566778899aabbcc {\n}',
      [{ eventId: 50, warnings: 0 }, { eventId: 60, warnings: 1 }]
    );
    assert.deepEqual([...lines.entries()], [[4, { eventId: 60, warnings: 1 }]]);
  });
});
