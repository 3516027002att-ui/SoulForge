/**
 * DarkScript 源码原子挂载的单测（完整缓冲路径）。
 *
 * 断言对象不是「分片怎么切」，而是「完整缓冲没有分片态」：一次
 * createCompleteSourceState 之后，doc.length / doc.toString() / doc.lines 立即
 * 等于完整文件。这个测试在 1.3MB / 2.2 万行样本上执行，刻意覆盖真实
 * common_func 级文档。
 *
 * S35（event-common-load.md §3.2）后完整缓冲仍是「拉齐后 / 提交后重读回灌 /
 * 小文档首帧」的挂载方式；超长文档打开首帧的 400 行前缀与按视口续载走
 * incrementalSourceInjection.ts（有独立单测），不在本文件。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCompleteSourceState,
  isCompleteSourceState
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

test('大文档首帧就是完整全文：没有 prefix、没有 rest、没有分片追加', () => {
  const text = makeDarkScript(22_000);
  assert.ok(text.length >= 1_300_000, `需要约 1.3MB 样本，实得 ${text.length}`);

  const state = createCompleteSourceState(text, []);
  assert.equal(state.doc.length, text.length);
  assert.equal(state.doc.toString(), text);
  assert.equal(state.doc.lines, 88_000);
  assert.equal(isCompleteSourceState(state, text), true);
});

test('小文档与空文档同样一次提交', () => {
  for (const text of ['', '$Event(0, Default, function() {\n});']) {
    const state = createCompleteSourceState(text, []);
    assert.equal(isCompleteSourceState(state, text), true);
  }
});

test('传入 extensions 时状态可直接被 EditorView 使用', () => {
  const text = makeDarkScript(2);
  const state = createCompleteSourceState(text, []);
  assert.equal(state.doc.toString(), text);
});
