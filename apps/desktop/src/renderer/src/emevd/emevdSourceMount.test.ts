import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';

import {
  appendSourceSlices,
  emptyEventLineScan,
  FIRST_FRAME_CHARS,
  indexEventLinesIncremental,
  splitSourceForFirstFrame
} from './emevdSourceMount.js';

function makeDarkScript(events: number): string {
  const parts: string[] = [];
  for (let i = 0; i < events; i += 1) {
    parts.push(`$Event(${i}, Default, function() {`);
    parts.push(`    InitializeEvent(0, ${70000000 + i}, 0);`);
    parts.push('});');
    parts.push('');
  }
  return parts.join('\n');
}

test('首帧只切前缀，其余留给追加', () => {
  const text = 'x'.repeat(FIRST_FRAME_CHARS + 50) + '\n$Event(1, Default, function() {\n});\n';
  const { head, rest } = splitSourceForFirstFrame(text);
  assert.ok(head.length < text.length);
  assert.equal(head + rest, text);
  assert.ok(head.length <= FIRST_FRAME_CHARS + 1);
});

test('增量灌入后的文档与全文逐字节相同，取消不返回半成品状态给调用方以外', async () => {
  const text = makeDarkScript(4000);
  assert.ok(text.length > 80_000, '样本必须明显大于首帧预算');
  const { head, rest } = splitSourceForFirstFrame(text);
  let state = EditorState.create({ doc: head });
  const clock = { nowMs: 0, yields: 0 };
  const filled = await appendSourceSlices({
    state,
    rest,
    sliceBudgetMs: 8,
    scheduler: {
      now: () => clock.nowMs,
      yieldSlice: async () => {
        clock.yields += 1;
        clock.nowMs += 8;
      }
    }
  });
  assert.equal(filled.cancelled, false);
  assert.ok(clock.yields > 0, '必须确定性让出，不能一次灌完');
  assert.equal(filled.state.doc.toString(), text);
});

test('让出期间取消：调用方拿 cancelled，不得把半成品当成完成', async () => {
  const text = makeDarkScript(4000);
  const { head, rest } = splitSourceForFirstFrame(text);
  const controller = new AbortController();
  let yields = 0;
  const filled = await appendSourceSlices({
    state: EditorState.create({ doc: head }),
    rest,
    sliceBudgetMs: 1,
    signal: controller.signal,
    scheduler: {
      now: () => yields * 10,
      yieldSlice: async () => {
        yields += 1;
        if (yields === 1) controller.abort();
      }
    }
  });
  assert.equal(yields, 1);
  assert.equal(filled.cancelled, true);
  assert.notEqual(filled.state.doc.toString(), text);
  assert.ok(filled.state.doc.length < text.length);
});

test('indexEventLines 增量扫描与全文扫描一致', () => {
  const rows = [
    { eventId: 0, warnings: 1 },
    { eventId: 1, warnings: 2 },
    { eventId: 2, warnings: 0 }
  ];
  const text = makeDarkScript(3);
  const full = indexEventLinesIncremental(emptyEventLineScan(), text, rows);
  const { head, rest } = splitSourceForFirstFrame(text, 40);
  const first = indexEventLinesIncremental(emptyEventLineScan(), head, rows);
  const next = indexEventLinesIncremental(first, rest, rows);
  assert.deepEqual([...next.map.entries()], [...full.map.entries()]);
  assert.equal(next.blockIndex, full.blockIndex);
});

test('生产 onSlice 只接收新增 chunk，不得对累计全文 split', async () => {
  const text = makeDarkScript(200);
  const { head, rest } = splitSourceForFirstFrame(text, 80);
  const chunks: string[] = [];
  await appendSourceSlices({
    state: EditorState.create({ doc: head }),
    rest,
    sliceBudgetMs: 1,
    scheduler: {
      now: () => 0,
      yieldSlice: async () => undefined
    },
    onSlice: (_state, appended) => {
      chunks.push(appended);
    }
  });
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    assert.ok(chunk.length < text.length, 'onSlice 不得拿到整份累计文本');
  }
  assert.equal(head + chunks.join(''), text);
});

test('真实 1.3MB DarkScript 文本的 CodeMirror 挂载：首帧不是全文 create', async () => {
  const text = makeDarkScript(22_000);
  assert.ok(text.length >= 1_300_000, `需要约 1.3MB 样本，实得 ${text.length}`);
  const { head, rest } = splitSourceForFirstFrame(text);
  assert.ok(head.length < text.length / 4, '首帧必须远小于全文');
  const first = EditorState.create({ doc: head });
  assert.equal(first.doc.length, head.length);
  let now = 0;
  const mounted = await appendSourceSlices({
    state: first,
    rest,
    sliceBudgetMs: 8,
    scheduler: {
      now: () => now,
      yieldSlice: async () => { now += 8; }
    }
  });
  assert.equal(mounted.cancelled, false);
  assert.equal(mounted.state.doc.toString(), text);
  assert.ok(mounted.slices > 5, `1.3MB 必须分多片，实得 ${mounted.slices}`);
});
