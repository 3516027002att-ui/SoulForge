/**
 * S18-E：增量灌入纯函数单测。
 *
 * 断言对象：splitSourceForInjection（首帧前缀 + 剩余）、takeSourceSlice（分片）、
 * appendEventLineInfo（增量 gutter 索引，行号与块顺序映射）。分片拼接的结果必须
 * 与一次全量索引逐行一致 —— 这是「增量不改变输出」的判据。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendEventLineInfo,
  isEventBlockLine,
  splitSourceForInjection,
  takeSourceSlice,
  type SourceInjectionSplit
} from './incrementalSourceInjection.js';

function makeEventRows(): Array<{ eventId: number; warnings: number }> {
  return [
    { eventId: 50, warnings: 0 },
    { eventId: 60, warnings: 2 },
    { eventId: 70, warnings: 1 },
    { eventId: 80, warnings: 0 }
  ];
}

/** 构造「每个事件 3 行」的 DarkScript 文本。 */
function makeSource(eventCount: number): string {
  const blocks: string[] = [];
  for (let i = 0; i < eventCount; i += 1) {
    blocks.push(`$Event(${100 + i}, Default, function() {`);
    blocks.push('    WaitFixedTimeFrames(1);');
    blocks.push('});');
  }
  return blocks.join('\n') + '\n';
}

describe('isEventBlockLine', () => {
  it('识别 $Event( 与 event @e: 两种块锚形态', () => {
    assert.equal(isEventBlockLine('$Event(50, Default, function() {'), true);
    assert.equal(isEventBlockLine('event @e:abc {'), true);
    assert.equal(isEventBlockLine('    $Event(50, ...'), false, '缩进的 $Event 不是块首行');
    assert.equal(isEventBlockLine('    WaitFixedTimeFrames(1);'), false);
    assert.equal(isEventBlockLine(''), false);
  });
});

describe('splitSourceForInjection', () => {
  it('小文档：全文即前缀，rest 为空（行为与全量建树一致）', () => {
    const source = makeSource(2);
    const split = splitSourceForInjection(source, makeEventRows(), 10);
    assert.equal(split.prefix, source);
    assert.equal(split.rest, '');
    assert.equal(split.prefixLines, 7);
    assert.equal(split.prefixBlocks, 2);
  });

  it('大文档：前缀恰好 prefixLines 行且带尾换行，剩余从下一行开始', () => {
    const source = makeSource(10); // 31 行
    const split: SourceInjectionSplit = splitSourceForInjection(source, makeEventRows(), 7);
    assert.equal(split.prefixLines, 7);
    assert.equal(split.prefix.endsWith('\n'), true);
    // prefix + rest 拼接逐字节还原原文（追加不会错位）。
    assert.equal(split.prefix + split.rest, source);
    // 前缀 7 行 = 两个完整事件块（$Event + 指令 + }); ）+ $Event 头行。
    assert.equal(split.prefixBlocks, 3);
    assert.ok(split.rest.startsWith('    WaitFixedTimeFrames(1);'), '剩余从第 8 行开始');
  });

  it('行数恰等于前缀上限时 rest 为空', () => {
    const source = makeSource(10); // 31 行
    const split = splitSourceForInjection(source, makeEventRows(), 31);
    assert.equal(split.rest, '');
    assert.equal(split.prefix, source);
  });
});

describe('takeSourceSlice', () => {
  it('按行边界切片，拼接还原', () => {
    const source = makeSource(10); // 31 行
    const first = takeSourceSlice(source, 7);
    const second = takeSourceSlice(first.rest, 7);
    const third = takeSourceSlice(second.rest, 7);
    assert.equal(first.chunk + second.chunk + third.chunk + third.rest, source);
    assert.ok(first.rest.startsWith('    WaitFixedTimeFrames(1);'));
  });

  it('剩余不足一片时全给，rest 为空', () => {
    const taken = takeSourceSlice('a\nb\nc', 5);
    assert.equal(taken.chunk, 'a\nb\nc');
    assert.equal(taken.rest, '');
  });
});

describe('appendEventLineInfo（增量索引与全量索引逐行一致）', () => {
  it('分片增量拼接的行号/块顺序与一次性全量索引相同', () => {
    const rows = makeEventRows();
    const source = makeSource(4); // 13 行，4 个事件块

    // 全量参考：indexEventLines 同规则（这里直接模拟：每块行首若 warnings>0 入 map）。
    const reference = new Map<number, { eventId: number; warnings: number }>();
    {
      let blockIndex = 0;
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!isEventBlockLine(lines[i]!)) continue;
        const row = rows[blockIndex]!;
        blockIndex += 1;
        if (row.warnings > 0) reference.set(i + 1, { eventId: row.eventId, warnings: row.warnings });
      }
    }

    // 增量：前缀 5 行（事件 0 完整 + 事件 1 的头行），再两片补齐。
    const split = splitSourceForInjection(source, rows, 5);
    const incremental = new Map<number, { eventId: number; warnings: number }>();
    let blockIndex = split.prefixBlocks;
    appendEventLineInfo(incremental, split.prefix, 1, 0, rows);
    const slices = [
      takeSourceSlice(split.rest, 4),
      takeSourceSlice(takeSourceSlice(split.rest, 4).rest, 4)
    ];
    let line = split.prefixLines + 1;
    for (const { chunk } of slices) {
      const consumed = appendEventLineInfo(incremental, chunk, line, blockIndex, rows);
      blockIndex += consumed;
      line += chunk.split('\n').length - 1;
    }

    assert.deepEqual([...incremental.entries()], [...reference.entries()]);
  });

  it('event @e: 锚形态按 eventId 命中（含顺序计数前进，与 indexEventLines 一致）', () => {
    const rows = makeEventRows();
    const text = [
      'event @e:60 {', // 锚命中 eventId 60（warnings=2）
      '  set id = 60',
      '}',
      '$Event(70, Default, function() {', // 顺序计数已前进 → rows[1]（60，warnings=2）
      '});',
      ''
    ].join('\n');
    // 与全量 indexEventLines 逐行同判据：锚行命中 byEventId，且块顺序计数同样前进。
    const byEventId = new Map(rows.map((row) => [String(row.eventId), row]));
    const reference = new Map<number, { eventId: number; warnings: number }>();
    {
      let blockIndex = 0;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!isEventBlockLine(lines[i]!)) continue;
        const anchorMatch = /^event\s+@e:(\S+)/.exec(lines[i]!);
        const row = (anchorMatch ? byEventId.get(anchorMatch[1]!) : undefined) ?? rows[blockIndex];
        blockIndex += 1;
        if (row && row.warnings > 0) reference.set(i + 1, { eventId: row.eventId, warnings: row.warnings });
      }
    }
    const map = new Map<number, { eventId: number; warnings: number }>();
    appendEventLineInfo(map, text, 1, 0, rows);
    assert.deepEqual([...map.entries()], [...reference.entries()]);
    // 锚命中路径确实走了 byEventId：行 1 的事件是 60 而不是 rows[0] 的 50。
    assert.deepEqual(map.get(1), { eventId: 60, warnings: 2 });
  });
});
