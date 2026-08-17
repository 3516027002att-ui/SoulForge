import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EmevdSourceTokens,
  SOURCE_PREFIX_LINES,
  takeSourcePrefix
} from './emevdSourceTokens.js';

function makeSource(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `$Event(${index}, Default, function() {`).join('\n');
}

test('put 只回前缀，全文留在 token 里', () => {
  const store = new EmevdSourceTokens();
  const text = makeSource(900);
  const put = store.put(1, 'file://event/common.emevd', text);
  assert.equal(put.totalLines, 900);
  assert.equal(put.prefix.split('\n').length, SOURCE_PREFIX_LINES);
  assert.equal(put.prefix, takeSourcePrefix(text.split('\n')));
  assert.doesNotMatch(put.prefix, /\$Event\(400,/);
});

test('切片按 fromLine/lineCount 取，eof 在末尾为真', () => {
  const store = new EmevdSourceTokens();
  const put = store.put(1, 'file://event/common.emevd', makeSource(450));
  const first = store.readSlice(put.token, 1, SOURCE_PREFIX_LINES, 40);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.fromLine, SOURCE_PREFIX_LINES);
    assert.equal(first.lineCount, 40);
    assert.equal(first.eof, false);
    assert.match(first.sliceText, /^\$Event\(400,/);
  }
  const rest = store.readSlice(put.token, 1, 440, 20);
  assert.equal(rest.ok, true);
  if (rest.ok) {
    assert.equal(rest.lineCount, 10);
    assert.equal(rest.eof, true);
  }
});

test('同窗口新 put 作废旧 token；跨窗口互不读', () => {
  const store = new EmevdSourceTokens();
  const first = store.put(1, 'file://event/a.emevd', makeSource(10));
  store.put(1, 'file://event/b.emevd', makeSource(12));
  const stale = store.readSlice(first.token, 1, 0, 4);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'EMEVD_SOURCE_TOKEN_EXPIRED');

  const windowA = store.put(1, 'file://event/a.emevd', makeSource(8));
  const windowB = store.put(2, 'file://event/b.emevd', makeSource(8));
  const stolen = store.readSlice(windowA.token, 2, 0, 2);
  assert.equal(stolen.ok, false);
  if (!stolen.ok) assert.equal(stolen.code, 'EMEVD_SOURCE_TOKEN_EXPIRED');
  const own = store.readSlice(windowB.token, 2, 0, 2);
  assert.equal(own.ok, true);
});

test('dropWindow 后切片失败', () => {
  const store = new EmevdSourceTokens();
  const put = store.put(7, 'file://event/a.emevd', 'a\nb');
  store.dropWindow(7);
  assert.equal(store.size, 0);
  const gone = store.readSlice(put.token, 7, 0, 1);
  assert.equal(gone.ok, false);
});
