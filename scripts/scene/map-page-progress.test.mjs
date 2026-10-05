import assert from 'node:assert/strict';
import { test } from 'node:test';
const module = await import('../../apps/desktop/src/renderer/src/scene/mapPageProgress.ts').catch(() => ({}));
test('MAP streaming rejects repeated cursors instead of hanging halfway', () => {
  assert.equal(typeof module.MapPageProgress, 'function');
  const progress = new module.MapPageProgress();
  progress.accept({ sessionToken: 'session', nextCursor: 'page-1', complete: false });
  assert.throws(() => progress.accept({ sessionToken: 'session', nextCursor: 'page-1', complete: false }), /MAP_STATIC_CURSOR_REPEATED/);
});
test('MAP streaming rejects incomplete terminal pages and changed sessions', () => {
  assert.equal(typeof module.MapPageProgress, 'function');
  assert.throws(() => new module.MapPageProgress().accept({ complete: false }), /MAP_STATIC_PAGE_INCOMPLETE/);
  const progress = new module.MapPageProgress();
  progress.accept({ sessionToken: 'old', nextCursor: 'one', complete: false });
  assert.throws(() => progress.accept({ sessionToken: 'new', complete: true }), /MAP_STATIC_SESSION_CHANGED/);
});
test('MAP streaming bounds pages and accumulated wire bytes; complete empty page is valid', () => {
  assert.equal(typeof module.MapPageProgress, 'function');
  new module.MapPageProgress().accept({ complete: true, chunks: [] });
  const count = new module.MapPageProgress({ maxPages: 1 });
  count.accept({ nextCursor: 'one', complete: false });
  assert.throws(() => count.accept({ complete: true }), /MAP_STATIC_PAGE_LIMIT/);
  assert.throws(() => new module.MapPageProgress({ maxWireCharacters: 3 }).accept({ complete: true, chunks: [{ positionsBase64: 'AAAA' }] }), /MAP_STATIC_MODEL_WIRE_LIMIT/);
});
test('MAP streaming counts retained texture data URIs across pages before accepting them', () => {
  const page = (nextCursor, complete) => ({ sessionToken: 'session', nextCursor, complete, texturePreviewToken: 'data:image/png;base64,' + 'A'.repeat(512), chunks: [{ positionsBase64: 'AAAA', texturePreviewToken: 'data:image/png;base64,' + 'B'.repeat(512), material: { normalTexturePreviewToken: 'data:image/png;base64,' + 'C'.repeat(512) } }] });
  const first = page('two', false);
  const second = page(null, true);
  const progress = new module.MapPageProgress({ maxWireCharacters: JSON.stringify(first).length + JSON.stringify(second).length - 1 });
  progress.accept(first);
  assert.throws(() => progress.accept(second), /MAP_STATIC_MODEL_WIRE_LIMIT/);
});
test('MAP streaming includes retained response diagnostics in the accumulated budget', () => {
  const first = { complete: false, nextCursor: 'two', chunks: [] };
  const second = { complete: true, chunks: [] };
  const response = (data) => ({ ok: true, data, diagnostics: [{ message: 'D'.repeat(1024) }] });
  const progress = new module.MapPageProgress({ maxWireCharacters: JSON.stringify(response(first)).length + JSON.stringify(response(second)).length - 1 });
  progress.accept(first, response(first));
  assert.throws(() => progress.accept(second, response(second)), /MAP_STATIC_MODEL_WIRE_LIMIT/);
});

function assertExactEnvelopeBudget(envelope) {
  const expected = JSON.stringify(envelope).length;
  const page = { complete: true, chunks: [] };
  new module.MapPageProgress({ maxWireCharacters: expected }).accept(page, envelope);
  assert.throws(() => new module.MapPageProgress({ maxWireCharacters: expected - 1 }).accept(page, envelope), /MAP_STATIC_MODEL_WIRE_LIMIT/);
}

test('MAP envelope counting preserves escaping and UTF-16 Unicode lengths', () => {
  const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('');
  for (const text of [
    'A'.repeat(8192),
    ('"\\\n\r\t\b\f' + controls).repeat(80),
    '地图é😀𝄞'.repeat(400),
    ('\ud800x\udfff\ud800\udc00\udfff\ud800').repeat(300),
    'A'.repeat(2047) + '\ud800',
    'A'.repeat(2047) + '\udfff'
  ]) assertExactEnvelopeBudget({ complete: true, text, [text.slice(-2048)]: text });
});

test('MAP envelope counting keeps native arrays, omission and non-finite number semantics', () => {
  const sparse = [undefined, NaN, Infinity, -Infinity, -0, 'A'.repeat(4096)];
  sparse.length += 3;
  sparse.ignoredArrayProperty = 'ignored'.repeat(1024);
  assertExactEnvelopeBudget({
    nested: { absent: undefined, callback() {}, symbol: Symbol('omitted'), text: 'B'.repeat(4096) },
    sparse, array: [() => {}, Symbol('null'), { value: undefined }],
    number: 1e30, boolean: false, nothing: null
  });
});

test('MAP envelope counting preserves native toJSON and getter calls', () => {
  const calls = [];
  const envelope = {
    child: { toJSON(key) { calls.push(`toJSON:${key}`); return { text: 'C'.repeat(4096), absent: undefined }; } },
    get metadata() { calls.push('getter'); return 'D'.repeat(4096); },
    date: new Date('2026-10-05T00:00:00.000Z'),
    boxed: new String('E'.repeat(4096))
  };
  const expected = JSON.stringify(envelope).length;
  const expectedCalls = [...calls];
  calls.length = 0;
  new module.MapPageProgress({ maxWireCharacters: expected }).accept({ complete: true }, envelope);
  assert.deepEqual(calls, expectedCalls, 'counting must not call hooks twice or mutate the envelope');
});

test('MAP envelope counting keeps native serialization failures and invalid roots', () => {
  const cyclic = { text: 'A'.repeat(4096) }; cyclic.self = cyclic;
  for (const envelope of [cyclic, { value: 1n }]) {
    assert.throws(() => new module.MapPageProgress().accept({ complete: true }, envelope), TypeError);
  }
  assert.throws(() => new module.MapPageProgress().accept({ complete: true }, () => {}), /MAP_STATIC_PAGE_INVALID/);
});

test('MAP streaming still budgets long textures, metadata, diagnostics and cursors across pages', () => {
  const first = { complete: false, nextCursor: 'cursor:' + 'Q'.repeat(4096), chunks: [{ positionsBase64: 'AAAA', texturePreviewToken: 'data:image/png;base64,' + 'T'.repeat(16384) }] };
  const second = { complete: true, chunks: [] };
  const response = data => ({ ok: true, data, metadata: { text: '"\\\n地图😀'.repeat(1024) }, diagnostics: [{ message: 'D'.repeat(4096) }] });
  const firstResponse = response(first), secondResponse = response(second);
  const progress = new module.MapPageProgress({ maxWireCharacters: JSON.stringify(firstResponse).length + JSON.stringify(secondResponse).length - 1 });
  progress.accept(first, firstResponse);
  assert.throws(() => progress.accept(second, secondResponse), /MAP_STATIC_MODEL_WIRE_LIMIT/);
});

test('MAP envelope counting avoids serializing the large string payloads again', () => {
  const envelope = { ok: true, data: { complete: true, chunks: [{ positionsBase64: 'A'.repeat(8 * 1024 * 1024), texturePreviewToken: 'data:image/png;base64,' + 'T'.repeat(512 * 1024) }] }, metadata: { note: 'M'.repeat(32 * 1024) } };
  const nativeStringify = JSON.stringify;
  const expected = nativeStringify(envelope).length;
  let largestSerializedString = 0;
  JSON.stringify = (value, replacer, space) => nativeStringify(value, function (key, original) {
    const projected = typeof replacer === 'function' ? replacer.call(this, key, original) : original;
    if (typeof projected === 'string') largestSerializedString = Math.max(largestSerializedString, projected.length);
    return projected;
  }, space);
  try {
    new module.MapPageProgress({ maxWireCharacters: expected }).accept(envelope.data, envelope);
  } finally {
    JSON.stringify = nativeStringify;
  }
  assert.ok(largestSerializedString < 32 * 1024, 'large wire strings must be counted without materializing them in another JSON string');
  assert.equal(envelope.data.chunks[0].positionsBase64.length, 8 * 1024 * 1024);
});
