import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SOURCE_PREFIX_LINES,
  SOURCE_SLICE_LINES,
  assembleEmevdSource,
  countSourceLines
} from './assembleEmevdSource.js';

function makeSource(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `L${index}`).join('\n');
}

test('前缀已覆盖全文时不再拉 slice', async () => {
  const text = makeSource(12);
  let calls = 0;
  const assembled = await assembleEmevdSource({
    sourcePrefix: text,
    sourceToken: 'tok',
    sourceTotalLines: 12,
    readSlice: async () => {
      calls += 1;
      return { ok: true, sliceText: '', lineCount: 0, eof: true };
    }
  });
  assert.equal(assembled.cancelled, false);
  assert.equal(assembled.text, text);
  assert.equal(calls, 0);
});

test('按 SOURCE_SLICE_LINES 拉齐后得到原文', async () => {
  const text = makeSource(SOURCE_PREFIX_LINES + SOURCE_SLICE_LINES + 17);
  const lines = text.split('\n');
  const prefix = lines.slice(0, SOURCE_PREFIX_LINES).join('\n');
  let calls = 0;
  const assembled = await assembleEmevdSource({
    sourcePrefix: prefix,
    sourceToken: 'tok',
    sourceTotalLines: lines.length,
    readSlice: async (_token, fromLine, lineCount) => {
      calls += 1;
      const slice = lines.slice(fromLine, fromLine + lineCount);
      return {
        ok: true,
        fromLine,
        lineCount: slice.length,
        totalLines: lines.length,
        eof: fromLine + slice.length >= lines.length,
        sliceText: slice.join('\n')
      };
    }
  });
  assert.equal(assembled.text, text);
  assert.equal(calls, 2);
  assert.equal(countSourceLines(assembled.text ?? ''), lines.length);
});

test('无 token 时回退 dslTemplate', async () => {
  const assembled = await assembleEmevdSource({
    dslTemplate: '$Event(1, Default, function() {\n});',
    readSlice: async () => ({ ok: false })
  });
  assert.equal(assembled.text, '$Event(1, Default, function() {\n});');
});

test('取消中途停止', async () => {
  const lines = makeSource(SOURCE_PREFIX_LINES + 80).split('\n');
  let cancelled = false;
  const assembled = await assembleEmevdSource({
    sourcePrefix: lines.slice(0, SOURCE_PREFIX_LINES).join('\n'),
    sourceToken: 'tok',
    sourceTotalLines: lines.length,
    isCancelled: () => cancelled,
    readSlice: async () => {
      cancelled = true;
      return { ok: true, sliceText: 'x', lineCount: 1, eof: false };
    }
  });
  assert.equal(assembled.cancelled, true);
  assert.equal(assembled.text, null);
});
