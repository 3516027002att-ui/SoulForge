/**
 * S35 — 超长 EMEVD 按视口增量灌入（event-common-load.md §3.2）的单测。
 *
 * 覆盖：
 * - createIncrementalSourceState：token+前缀 → 增量源；无 token → null。
 * - isNearLoadedBottom：视口底行（行号口径）距已加载末尾的判定 —— 专门钉住
 *   「viewport.to 是字符偏移不是行号」的单位 bug（旧公式 doc.lines - viewport.to
 *   会把大文档任何滚动位置都判成近底，打开即级联拉完全文）。
 * - fetchNextSourceSlice / fetchAllRemainingSource：按 SOURCE_SLICE_LINES 推进
 *   nextFromLine，eof / 失败 / 取消的终端态。
 * - appendSourceTail：末尾追加的分隔符口径与选择保留。
 * - 端到端「滚近底部 → 拉片 → 追加」：视口判定 → 拉一片 → 一次追加，文本与
 *   行数与「前缀 + 原样切片」一致，光标不动。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EditorState } from '@codemirror/state';
import {
  INCREMENTAL_NEAR_BOTTOM_LINES,
  appendSourceTail,
  createIncrementalSourceState,
  fetchAllRemainingSource,
  fetchNextSourceSlice,
  isNearLoadedBottom,
  type IncrementalSourceState
} from './incrementalSourceInjection.js';
import {
  SOURCE_PREFIX_LINES,
  SOURCE_SLICE_LINES,
  countSourceLines
} from './assembleEmevdSource.js';

function makeSource(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `L${index.toString().padStart(5, '0')}`).join('\n');
}

/** 模拟 main 侧 EmevdSourceTokens.readSlice：按行区间切片，eof 与 totalLines 权威。 */
function sliceReaderOf(fullText: string) {
  const lines = fullText.split('\n');
  return async (_token: string, fromLine: number, lineCount: number) => {
    const end = Math.min(lines.length, fromLine + lineCount);
    return {
      ok: true,
      fromLine,
      lineCount: Math.max(0, end - fromLine),
      totalLines: lines.length,
      eof: end >= lines.length,
      sliceText: lines.slice(fromLine, end).join('\n')
    };
  };
}

/** 与面板一致的追加方式：appendSourceTail + EditorState.update。 */
function appendToState(state: EditorState, restText: string): EditorState {
  return state.update(appendSourceTail(state, restText)).state;
}

function viewportOf(state: EditorState, toOffset: number) {
  return { state, viewport: { from: 0, to: toOffset } };
}

test('createIncrementalSourceState：token+前缀建增量源，无 token 返回 null', () => {
  const prefix = makeSource(400);
  const state = createIncrementalSourceState({
    sourcePrefix: prefix,
    sourceToken: 'tok-1',
    sourceTotalLines: 70_000
  });
  assert.ok(state);
  assert.equal(state.token, 'tok-1');
  assert.equal(state.nextFromLine, 400);
  assert.equal(state.totalLines, 70_000);
  assert.equal(state.eof, false);
  assert.equal(state.failed, false);

  assert.equal(createIncrementalSourceState({ sourceToken: null }), null);
  assert.equal(createIncrementalSourceState({}), null);
  assert.equal(createIncrementalSourceState({ sourceToken: '', sourcePrefix: '' }), null);
});

test('createIncrementalSourceState：前缀已覆盖全文 → eof', () => {
  const text = makeSource(120);
  const state = createIncrementalSourceState({
    sourcePrefix: text,
    sourceToken: 'tok',
    sourceTotalLines: 120
  });
  assert.ok(state);
  assert.equal(state.nextFromLine, 120);
  assert.equal(state.eof, true);
});

test('isNearLoadedBottom：视口底行近已加载末尾才算近底（行号口径）', () => {
  // 1000 行文档。视口底距已加载末尾超过阈值时不续载；单位必须行号。
  // 旧公式 doc.lines - viewport.to（字符偏移，~15k）得负数，会把这里判成近底
  // —— 单位 bug 的回归靶。
  const text = makeSource(1000);
  const state = EditorState.create({ doc: text, extensions: [] });
  const farBottom = state.doc.line(1000 - INCREMENTAL_NEAR_BOTTOM_LINES - 50).to;
  assert.equal(isNearLoadedBottom(viewportOf(state, farBottom)), false,
    `距末尾还有 ${INCREMENTAL_NEAR_BOTTOM_LINES + 50} 行，超过阈值，不应续载`);

  const atThreshold = state.doc.line(1000 - INCREMENTAL_NEAR_BOTTOM_LINES).to;
  assert.equal(isNearLoadedBottom(viewportOf(state, atThreshold)), true,
    '距末尾正好阈值行数，应续载');

  // 视口底正好在文档末尾（滚到底）→ 0 行剩余 → 续载。
  assert.equal(isNearLoadedBottom(viewportOf(state, state.doc.length)), true);
  // 视口底在文档最末行中间 → 同样近底。
  const lastLineMid = state.doc.line(state.doc.lines).from;
  assert.equal(isNearLoadedBottom(viewportOf(state, lastLineMid)), true);
});

test('isNearLoadedBottom：阈值边界（剩余行 = 阈值 / 阈值+1）', () => {
  const text = makeSource(INCREMENTAL_NEAR_BOTTOM_LINES + 2);
  const state = EditorState.create({ doc: text, extensions: [] });
  // 剩余 INCREMENTAL_NEAR_BOTTOM_LINES 行 → 触发。
  const bottom = state.doc.lines;
  const atThreshold = state.doc.line(bottom - INCREMENTAL_NEAR_BOTTOM_LINES).to;
  assert.equal(isNearLoadedBottom(viewportOf(state, atThreshold)), true);
  // 剩余 阈值+1 行 → 不触发。
  const justOver = state.doc.line(bottom - INCREMENTAL_NEAR_BOTTOM_LINES - 1).to;
  assert.equal(isNearLoadedBottom(viewportOf(state, justOver)), false);
});

test('S35 挂载场景：400 行前缀 + 视口在顶部 → 不近底（打开首帧不得拉片）', () => {
  // 阈值必须小于前缀长度：否则打开即视口 measure 触发拉一片，违背「首帧只有
  // 400 行前缀，用户滚到靠近已加载底部再拉下一片」。
  const prefix = makeSource(SOURCE_PREFIX_LINES);
  const state = EditorState.create({ doc: prefix, extensions: [] });
  // 视口停在文档顶部（底行 ≈ 视口高度内）→ 剩余 ~370 行 > 阈值 → 不续载。
  assert.equal(
    isNearLoadedBottom(viewportOf(state, state.doc.line(50).to)),
    false,
    '前缀 400 行时视口在顶部不应判定近底'
  );
  // 用户滚到前缀末尾（底行 = 400）→ 剩余 0 ≤ 阈值 → 续载。
  assert.equal(
    isNearLoadedBottom(viewportOf(state, state.doc.line(SOURCE_PREFIX_LINES).to)),
    true
  );
});

test('fetchNextSourceSlice：正常拉一片并推进 nextFromLine', async () => {
  const full = makeSource(SOURCE_PREFIX_LINES + SOURCE_SLICE_LINES + 17);
  const prefix = full.split('\n').slice(0, SOURCE_PREFIX_LINES).join('\n');
  const state = createIncrementalSourceState({
    sourcePrefix: prefix,
    sourceToken: 'tok',
    sourceTotalLines: countSourceLines(full)
  })!;
  const step = await fetchNextSourceSlice(state, sliceReaderOf(full));
  assert.equal(step.cancelled, false);
  assert.equal(step.state.failed, false);
  assert.equal(step.state.nextFromLine, SOURCE_PREFIX_LINES + SOURCE_SLICE_LINES);
  assert.equal(step.state.eof, false);
  assert.equal(
    step.sliceText,
    full.split('\n').slice(SOURCE_PREFIX_LINES, SOURCE_PREFIX_LINES + SOURCE_SLICE_LINES).join('\n')
  );
});

test('fetchNextSourceSlice：最后一片 eof；空片不追加', async () => {
  const full = makeSource(SOURCE_PREFIX_LINES + 5);
  const prefix = full.split('\n').slice(0, SOURCE_PREFIX_LINES).join('\n');
  const state = createIncrementalSourceState({
    sourcePrefix: prefix,
    sourceToken: 'tok',
    sourceTotalLines: countSourceLines(full)
  })!;
  const step = await fetchNextSourceSlice(state, sliceReaderOf(full));
  assert.equal(step.state.eof, true);
  assert.equal(step.state.nextFromLine, countSourceLines(full));
  assert.equal(step.sliceText, full.split('\n').slice(SOURCE_PREFIX_LINES).join('\n'));

  // eof 后再拉：直接短路，不触发 readSlice。
  let calls = 0;
  const again = await fetchNextSourceSlice(step.state, async () => {
    calls += 1;
    return { ok: true, sliceText: '', lineCount: 0, eof: true };
  });
  assert.equal(calls, 0);
  assert.equal(again.sliceText, null);
});

test('fetchNextSourceSlice：失败 / 取消置终端态', async () => {
  const prefix = makeSource(SOURCE_PREFIX_LINES);
  const base = createIncrementalSourceState({
    sourcePrefix: prefix,
    sourceToken: 'tok',
    sourceTotalLines: 5000
  })!;

  const failed = await fetchNextSourceSlice(base, async () => ({ ok: false }));
  assert.equal(failed.state.failed, true);

  const cancelled = await fetchNextSourceSlice(base, async () => ({ cancelled: true }));
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.state.failed, true);
});

test('fetchAllRemainingSource：一次拉齐剩余全部并单段拼回', async () => {
  const total = SOURCE_PREFIX_LINES + SOURCE_SLICE_LINES * 3 + 23;
  const full = makeSource(total);
  const prefix = full.split('\n').slice(0, SOURCE_PREFIX_LINES).join('\n');
  const state = createIncrementalSourceState({
    sourcePrefix: prefix,
    sourceToken: 'tok',
    sourceTotalLines: total
  })!;
  const all = await fetchAllRemainingSource(state, sliceReaderOf(full));
  assert.equal(all.cancelled, false);
  assert.equal(all.state.eof, true);
  assert.equal(all.state.nextFromLine, total);
  assert.equal(
    all.restText,
    full.split('\n').slice(SOURCE_PREFIX_LINES).join('\n'),
    'restText = 未加载部分按 \'\\n\' 拼接'
  );
  // 拉齐后拼回原文（与 assembleEmevdSource 的拼接口径一致）。
  const reassembled = [prefix, all.restText].join('\n');
  assert.equal(reassembled, full);
});

test('appendSourceTail：末尾追加、分隔符口径、选择保留', () => {
  // 文档不以 \n 结尾 → 补一个分隔符；光标/选择保持原位置。
  const state = EditorState.create({
    doc: 'L0\nL1',
    selection: { anchor: 2, head: 2 },
    extensions: []
  });
  const spec = appendSourceTail(state, 'L2\nL3');
  assert.deepEqual(spec.changes, { from: state.doc.length, insert: '\nL2\nL3' });
  assert.deepEqual(spec.selection, { anchor: 2, head: 2 });
  const next = appendToState(state, 'L2\nL3');
  assert.equal(next.doc.toString(), 'L0\nL1\nL2\nL3');
  assert.equal(next.doc.lines, 4);

  // 文档已以 \n 结尾（用户编辑过末尾）→ 不重复补分隔符。
  const newlineEnded = EditorState.create({ doc: 'L0\nL1\n', extensions: [] });
  const noExtra = appendSourceTail(newlineEnded, 'L2');
  assert.equal(noExtra.changes.insert, 'L2');
  assert.equal(appendToState(newlineEnded, 'L2').doc.toString(), 'L0\nL1\nL2');

  // 空文档 → 直接插入。
  const empty = EditorState.create({ doc: '', extensions: [] });
  assert.equal(appendSourceTail(empty, 'L0').changes.insert, 'L0');
});

test('端到端：滚近底部 → 拉一片 → 一次追加，光标不动，全文可逐片拼回', async () => {
  const total = SOURCE_PREFIX_LINES + SOURCE_SLICE_LINES * 2 + 7;
  const full = makeSource(total);
  const prefix = full.split('\n').slice(0, SOURCE_PREFIX_LINES).join('\n');
  const readSlice = sliceReaderOf(full);

  let incremental = createIncrementalSourceState({
    sourcePrefix: prefix,
    sourceToken: 'tok',
    sourceTotalLines: total
  })!;
  let editor = EditorState.create({
    doc: prefix,
    selection: { anchor: 5, head: 5 },
    extensions: []
  });
  const originalCursor = { anchor: editor.selection.main.anchor, head: editor.selection.main.head };

  let slices = 0;
  while (!incremental.eof) {
    // 视口停在已加载末尾（滚到底）→ 近底判定必须为真。
    assert.equal(
      isNearLoadedBottom(viewportOf(editor, editor.doc.length)),
      true,
      `第 ${slices + 1} 片前视口应在已加载底部`
    );
    const step = await fetchNextSourceSlice(incremental, readSlice);
    incremental = step.state;
    if (step.sliceText) {
      const spec = appendSourceTail(editor, step.sliceText);
      editor = editor.update(spec).state;
      // 追加后光标仍在原位置（追加发生在文档末尾，不扰动选择）。
      assert.equal(editor.selection.main.anchor, originalCursor.anchor);
      assert.equal(editor.selection.main.head, originalCursor.head);
    }
    slices += 1;
  }

  assert.ok(slices >= 3, '70000 行量级样本应拉至少 3 片');
  assert.equal(editor.doc.toString(), full, '增量拼回必须与原样文本一致');
  assert.equal(editor.doc.lines, total);
  assert.equal(incremental.nextFromLine, total);
});

test('追加填充后行数推进与 nextFromLine 严格一致（400 行/片）', async () => {
  const full = makeSource(SOURCE_PREFIX_LINES + SOURCE_SLICE_LINES);
  const prefix = full.split('\n').slice(0, SOURCE_PREFIX_LINES).join('\n');
  const readSlice = sliceReaderOf(full);
  let incremental = createIncrementalSourceState({
    sourcePrefix: prefix,
    sourceToken: 'tok',
    sourceTotalLines: countSourceLines(full)
  })!;
  let editor = EditorState.create({ doc: prefix, extensions: [] });

  const step = await fetchNextSourceSlice(incremental, readSlice);
  incremental = step.state;
  editor = editor.update(appendSourceTail(editor, step.sliceText!)).state;

  assert.equal(editor.doc.lines, SOURCE_PREFIX_LINES + SOURCE_SLICE_LINES);
  assert.equal(incremental.nextFromLine, editor.doc.lines,
    'nextFromLine 推进量必须等于文档实际增长行数，否则下一片起点与内容错位');
  assert.equal(incremental.eof, true);
});

test('增量源状态推进契约：slice 取回后才推进（失败不推进）', async () => {
  const prefix = makeSource(SOURCE_PREFIX_LINES);
  const base = createIncrementalSourceState({
    sourcePrefix: prefix,
    sourceToken: 'tok',
    sourceTotalLines: 2000
  })!;
  const failed = await fetchNextSourceSlice(base, async () => ({ ok: false }));
  assert.equal(failed.state.nextFromLine, SOURCE_PREFIX_LINES, '失败不得推进 nextFromLine');
  assert.equal(failed.state.failed, true);
});
