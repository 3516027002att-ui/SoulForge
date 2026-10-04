import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeRendererValue } from './rendererDto.js';
import { stripPathFields } from '../preload/resultTransforms.js';
import { prepareMapStaticGeometryChunks } from '../renderer/src/scene/mapGeometryPrepare.js';

test('renderer projections preserve declared binary payloads that contain POSIX-looking slashes', () => {
  const positions = new Float32Array([1.99999988, 0, 0, 0, 1.99999988, 0, 0, 0, 1.99999988]);
  const positionsBase64 = Buffer.from(positions.buffer).toString('base64');
  assert.ok(positionsBase64.startsWith('//'), 'independent byte fixture must trigger the path-shaped case');
  const input = { data: { chunks: [{ positionsBase64 }], uvSetsBase64: ['+/8=', '/w=='], bytesBase64: '////' },
    diagnostics: [{ message: 'read /home/user/private/file failed', details: { absolutePath: '/tmp/private' } }] };
  for (const project of [sanitizeRendererValue, stripPathFields, (value: unknown) => stripPathFields(sanitizeRendererValue(value))]) {
    const result = project(input) as typeof input;
    assert.deepEqual(result.data, input.data);
    assert.equal(JSON.stringify(result).includes('/home/user/private'), false);
    assert.equal(JSON.stringify(result).includes('absolutePath'), false);
    const prepared = prepareMapStaticGeometryChunks(result.data.chunks);
    assert.deepEqual(Buffer.from(prepared.positionsBytes!), Buffer.from(positions.buffer));
    assert.equal(prepared.vertexCount, 3);
  }
});

test('binary field exemption is explicit and rejects text disguised as encoded bytes', () => {
  for (const project of [sanitizeRendererValue, stripPathFields]) {
    const result = project({ positionsBase64: 'D:\\private\\file', bytesBase64: '/home/user/a.fmg',
      arbitraryBase64: '/tmp/private', diagnostics: [{ message: '/tmp/private' }], absolutePath: '/tmp/private' });
    const text = JSON.stringify(result);
    for (const secret of ['D:', '/home/user', '/tmp/private', 'absolutePath']) assert.equal(text.includes(secret), false, secret);
  }
});
