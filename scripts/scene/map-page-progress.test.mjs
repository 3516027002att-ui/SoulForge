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
test('MAP streaming counts retained texture data URIs exactly across pages', () => {
  const page = (nextCursor, complete, fill) => ({ sessionToken: 'session', nextCursor, complete,
    texturePreviewToken: 'data:image/png;base64,' + fill.repeat(2048),
    chunks: [{ positionsBase64: 'AAAA', texturePreviewToken: 'data:image/png;base64,' + fill.repeat(2048),
      material: { normalTexturePreviewToken: 'data:image/png;base64,' + fill.repeat(2048) } }] });
  const first = page('two', false, 'A');
  const second = page(null, true, 'B');
  const exactLength = JSON.stringify(first).length + JSON.stringify(second).length;
  const exact = new module.MapPageProgress({ maxWireCharacters: exactLength });
  assert.doesNotThrow(() => exact.accept(first));
  assert.doesNotThrow(() => exact.accept(second));
  const over = new module.MapPageProgress({ maxWireCharacters: exactLength - 1 });
  over.accept(first);
  assert.throws(() => over.accept(second), /MAP_STATIC_MODEL_WIRE_LIMIT/);
});
test('MAP streaming includes retained response diagnostics in the accumulated budget', () => {
  const first = { complete: false, nextCursor: 'two', chunks: [] };
  const second = { complete: true, chunks: [] };
  const response = (data) => ({ ok: true, data, diagnostics: [{ message: 'D'.repeat(1024) }] });
  const progress = new module.MapPageProgress({ maxWireCharacters: JSON.stringify(response(first)).length + JSON.stringify(response(second)).length - 1 });
  progress.accept(first, response(first));
  assert.throws(() => progress.accept(second, response(second)), /MAP_STATIC_MODEL_WIRE_LIMIT/);
});

test('MAP wire budget matches the native JSON length oracle for representative full envelopes', () => {
  const long = 'x'.repeat(2048);
  const longDataUri = 'data:image/png;base64,' + 'B'.repeat(4096);
  const escapeAtom = 'quote=" slash=\\ backspace=\b tab=\t lf=\n ff=\f cr=\r nul=\u0000 unit=\u001f bmp=雪 emoji=😀 lone-high=\ud800 lone-low=\udfff separators=\u2028\u2029';
  const longEscaped = escapeAtom.repeat(96);
  const sparse = []; sparse.length = 5; sparse[1] = undefined; sparse[2] = () => 'omitted'; sparse[3] = Symbol('omitted'); sparse[4] = 'tail';
  const shared = { text: 'shared-' + 's'.repeat(2048) };
  const longKey = 'key-' + 'k'.repeat(2048);
  const everyCodeUnit = Array.from({ length: 65536 }, (_, code) => String.fromCharCode(code)).join('');
  const cases = [
    ['all envelope fields: chunks, texture data URI, metadata and diagnostic details', () => ({ ok: true,
      sourceUri: 'file://map/mapstudio/m11_00_00_00.msb.dcx',
      data: { sessionToken: 'session-A', complete: true, chunks: [{ positionsBase64: 'A'.repeat(8192),
        materialName: 'm11_floor', texturePreviewToken: 'preview-token', textureDataUri: longDataUri,
        metadata: { pageOrdinal: 7, labels: ['static', 'geometry'] } }],
        texturePreviewToken: 'preview-token', textureColorSpace: 'srgb', metadata: { source: 'map' } },
      diagnostics: [{ severity: 'warning', code: 'MAP_TEXTURE_PREVIEW_PARTIAL', message: 'partial',
        details: { requested: 3, resolved: 2, payload: longDataUri } }] })],
    ['escaping: control characters, quotes, backslashes, BMP, paired and lone surrogates', () => ({ ok: true,
      data: { complete: true, chunks: [{ materialName: longEscaped }] }, diagnostics: [] })],
    ['every UTF-16 code unit including adjacent and unpaired surrogates', () => ({ ok: true,
      data: { complete: true, metadata: { text: everyCodeUnit } }, diagnostics: [] })],
    ['native omission and array-hole rules for undefined, functions and symbols', () => ({ ok: true,
      data: { complete: true, metadata: { sparse, omitUndefined: undefined,
        omitFunction() { return 'omitted'; }, omitSymbol: Symbol('omitted'), numbers: [-0, NaN, Infinity, -Infinity, 1e21] } }, diagnostics: [] })],
    ['toJSON conversion, long keys, boxed strings and shared-object occurrences', () => ({ ok: true,
      data: { complete: true, metadata: { [longKey]: 'small', boxed: new String('boxed-' + 'b'.repeat(2048)),
        nested: { toJSON(key) { return { key, output: 'converted:' + long }; } },
        primitive: { toJSON() { return longEscaped; } }, first: shared, second: shared } }, diagnostics: [] })],
    ...[1023, 1024, 1025].map(length => ['threshold-' + length, () => ({ ok: true,
      data: { complete: true, metadata: { text: 't'.repeat(length) } }, diagnostics: [] })])
  ];
  for (const [label, makeResponse] of cases) {
    const value = makeResponse();
    const exactLength = JSON.stringify(value).length;
    assert.doesNotThrow(() => new module.MapPageProgress({ maxWireCharacters: exactLength }).accept(value.data, value), label);
    assert.throws(() => new module.MapPageProgress({ maxWireCharacters: exactLength - 1 }).accept(value.data, value), /MAP_STATIC_MODEL_WIRE_LIMIT/, label);
  }
});

test('MAP wire budget preserves native cycle and unstringifiable-envelope failures', () => {
  const cyclic = { ok: true, data: { complete: true }, diagnostics: [] };
  cyclic.data.self = cyclic.data;
  assert.throws(() => JSON.stringify(cyclic), /circular/i);
  assert.throws(() => new module.MapPageProgress().accept(cyclic.data, cyclic), /circular/i);
  const invalid = { complete: true };
  assert.throws(() => new module.MapPageProgress().accept(invalid, () => undefined), /MAP_STATIC_PAGE_INVALID/);
  assert.throws(() => new module.MapPageProgress().accept(invalid, { data: invalid, unsupported: 1n }), TypeError);
});
