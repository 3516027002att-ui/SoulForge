import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideMapStaticReadFailure,
  isMapStaticGeometryData
} from './mapStaticReadDecision.js';

const base = { sourceUri: 'file://map/test' };

describe('decideMapStaticReadFailure', () => {
  it('only explicit MAPBND_MODEL_NOT_FOUND continues fallback', () => {
    assert.deepEqual(decideMapStaticReadFailure({
      ...base,
      parseStatus: 'failed',
      diagnostics: [{ severity: 'error', code: 'MAPBND_MODEL_NOT_FOUND', message: 'absent' }]
    }), { action: 'fallback' });
  });

  it('does not hide another native error when a missing-model note is also present', () => {
    const result = decideMapStaticReadFailure({
      ...base,
      parseStatus: 'failed',
      diagnostics: [
        { severity: 'error', code: 'MAPBND_MODEL_NOT_FOUND', message: 'absent' },
        { severity: 'error', code: 'MAPBND_FLVER_PREVIEW_FAILED', message: 'parse failed' }
      ]
    });
    assert.equal(result.action, 'return');
    if (result.action === 'return') {
      assert.deepEqual(result.result.diagnostics.map((item) => item.code), [
        'MAPBND_MODEL_NOT_FOUND',
        'MAPBND_FLVER_PREVIEW_FAILED'
      ]);
    }
  });

  it('does not fall back when a missing-model note is paired with an unknown warning', () => {
    const result = decideMapStaticReadFailure({
      ...base,
      parseStatus: 'failed',
      diagnostics: [
        { severity: 'error', code: 'MAPBND_MODEL_NOT_FOUND', message: 'absent' },
        { severity: 'warning', code: 'MAPBND_CONTAINER_SUSPECT', message: 'container suspect' }
      ]
    });
    assert.equal(result.action, 'return');
  });

  it('preserves native parse/session/Oodle/budget diagnostics', () => {
    for (const code of ['MAP_STATIC_GEOMETRY_FAILED', 'MAP_STATIC_SESSION_EXPIRED', 'MAPBND_KRAK_OODLE_UNAVAILABLE', 'MAP_STATIC_CHUNK_BUDGET_EXCEEDED']) {
      const result = decideMapStaticReadFailure({
        ...base,
        parseStatus: 'failed',
        diagnostics: [{ severity: 'error', code, message: code }]
      });
      assert.equal(result.action, 'return');
      if (result.action === 'return') assert.equal(result.result.diagnostics[0]?.code, code);
    }
  });

  it('preserves the native invalid-cursor code, message, source URI, and details', () => {
    const result = decideMapStaticReadFailure({
      ...base,
      parseStatus: 'failed',
      diagnostics: [{
        severity: 'error',
        code: 'MAP_STATIC_CURSOR_INVALID',
        message: 'cursor 无法解析。',
        sourceUri: 'file://native/mapbnd',
        details: { cursor: 'opaque-cursor' }
      }]
    });
    assert.equal(result.action, 'return');
    if (result.action === 'return') {
      assert.deepEqual(result.result.diagnostics[0], {
        severity: 'error',
        code: 'MAP_STATIC_CURSOR_INVALID',
        message: 'cursor 无法解析。',
        sourceUri: 'file://native/mapbnd',
        details: { cursor: 'opaque-cursor' }
      });
    }
  });

  it('preserves the native source URI and diagnostic details without adding a local path', () => {
    const result = decideMapStaticReadFailure({
      ...base,
      parseStatus: 'failed',
      diagnostics: [{
        severity: 'error',
        code: 'MAP_STATIC_SESSION_EXPIRED',
        message: 'session expired',
        sourceUri: 'file://native/mapbnd',
        details: { sessionToken: 'opaque', sourceHash: 'hash' }
      }]
    });
    assert.equal(result.action, 'return');
    if (result.action === 'return') {
      assert.deepEqual(result.result.diagnostics[0], {
        severity: 'error',
        code: 'MAP_STATIC_SESSION_EXPIRED',
        message: 'session expired',
        sourceUri: 'file://native/mapbnd',
        details: { sessionToken: 'opaque', sourceHash: 'hash' }
      });
      assert.equal('sourcePath' in result.result.diagnostics[0]!, false);
    }
  });

  it('adds structured NO_DATA when native returned no data silently', () => {
    const result = decideMapStaticReadFailure({ ...base, parseStatus: 'failed', data: null });
    assert.equal(result.action, 'return');
    if (result.action === 'return') assert.equal(result.result.diagnostics[0]?.code, 'MAP_STATIC_GEOMETRY_NO_DATA');
  });

  it('adds NO_DATA while retaining info-only timing diagnostics', () => {
    const result = decideMapStaticReadFailure({
      ...base,
      parseStatus: 'partial',
      data: null,
      diagnostics: [{ severity: 'info', code: 'MAP_NATIVE_TIMINGS', message: 'timing' }]
    });
    assert.equal(result.action, 'return');
    if (result.action === 'return') {
      assert.deepEqual(result.result.diagnostics.map((item) => item.code), [
        'MAP_NATIVE_TIMINGS',
        'MAP_STATIC_GEOMETRY_NO_DATA'
      ]);
    }
  });

  it('adds a stable failure code when native marks failure but only reports info', () => {
    const result = decideMapStaticReadFailure({
      ...base,
      parseStatus: 'failed',
      data: { complete: false },
      diagnostics: [{ severity: 'info', code: 'MAP_NATIVE_TIMINGS', message: 'timing' }]
    });
    assert.equal(result.action, 'return');
    if (result.action === 'return') assert.equal(result.result.diagnostics.at(-1)?.code, 'MAP_STATIC_GEOMETRY_FAILED');
  });

  it('returns a structured malformed-data diagnostic for primitive payloads', () => {
    const result = decideMapStaticReadFailure({ ...base, parseStatus: 'partial', data: false });
    assert.equal(result.action, 'return');
    if (result.action === 'return') assert.equal(result.result.diagnostics[0]?.code, 'MAP_STATIC_GEOMETRY_INVALID_DATA');
  });

  it('rejects a successful object passed to the failure-only helper', () => {
    assert.throws(
      () => decideMapStaticReadFailure({ ...base, parseStatus: 'partial', data: { complete: true } }),
      /MAP_STATIC_FAILURE_DECISION_REQUIRES_FAILURE/
    );
  });

  it('recognizes only object payloads as map-static data', () => {
    assert.equal(isMapStaticGeometryData({ complete: true }), true);
    assert.equal(isMapStaticGeometryData(null), false);
    assert.equal(isMapStaticGeometryData(false), false);
    assert.equal(isMapStaticGeometryData([]), false);
  });
});
