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
