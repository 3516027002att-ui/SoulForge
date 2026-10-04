import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeDiagnostics, sanitizeRendererIpcResult, sanitizeRendererValue, toRendererEditorDocumentResult } from './rendererDto.js';
import { stripPathFields } from '../preload/resultTransforms.js';
import { prepareMapStaticGeometryChunks } from '../renderer/src/scene/mapGeometryPrepare.js';

test('registered MAP response preserves geometry bytes through both service and IPC projections', () => {
  const positions = new Float32Array([1.99999988, 0, 0, 0, 1.99999988, 0, 0, 0, 1.99999988]);
  const positionsBase64 = Buffer.from(positions.buffer).toString('base64');
  assert.ok(positionsBase64.startsWith('//'), 'independent byte fixture must trigger the path-shaped case');
  const input = { data: { chunks: [{ positionsBase64 }] },
    diagnostics: [{ message: 'read /home/user/private/file failed', details: { absolutePath: '/tmp/private' } }] };
  let result = input;
  for (let pass = 0; pass < 2; pass += 1) {
    result = sanitizeRendererIpcResult('resource.readMapStaticGeometry', result) as typeof input;
    assert.deepEqual(result.data, input.data);
    assert.equal(JSON.stringify(result).includes('/home/user/private'), false);
    assert.equal(JSON.stringify(result).includes('absolutePath'), false);
    const prepared = prepareMapStaticGeometryChunks(result.data.chunks);
    assert.deepEqual(Buffer.from(prepared.positionsBytes!), Buffer.from(positions.buffer));
    assert.equal(prepared.vertexCount, 3);
  }
});

test('generic and preload projections have no binary field-name exemption', () => {
  for (const project of [sanitizeRendererValue, stripPathFields, (value: unknown) => sanitizeRendererIpcResult('unknown', value)]) {
    const result = project({ positionsBase64: 'D:\\private\\file', bytesBase64: '/home/user/a.fmg',
      dataBase64: '/tmp/private', argsBase64: '/tmp/private', uvSetsBase64: ['/home/asus/x'],
      arbitraryBase64: '/tmp/private', diagnostics: [{ message: '/tmp/private' }], absolutePath: '/tmp/private' });
    const text = JSON.stringify(result);
    for (const secret of ['D:', '/home/user', '/tmp/private', 'absolutePath']) assert.equal(text.includes(secret), false, secret);
  }
});

test('diagnostics cannot claim a binary exemption for a base64-shaped absolute path', () => {
  const input = { diagnostics: [{ message: 'failed', details: {
    bytesBase64: '/tmp/private', uvSetsBase64: ['/home/asus/x'], text: '/tmp/private'
  } }] };
  for (const project of [sanitizeRendererValue, stripPathFields, (value: unknown) => sanitizeRendererIpcResult('resource.readMapStaticGeometry', value)]) {
    const output = JSON.stringify(project(input));
    assert.equal(output.includes('/tmp/private'), false);
    assert.equal(output.includes('/home/asus/x'), false);
  }
});

test('trusted mesh profile preserves every declared attribute, not arbitrary nested base64 keys', () => {
  const mesh = {
    positionsBase64: '//8=', indicesBase64: '/w==', uvsBase64: '+/8=', normalsBase64: '////',
    uvSetsBase64: ['+/8=', '/w=='], boneIndicesBase64: '////', boneWeightsBase64: '//8=', vertexAlphaBase64: '/w==',
    positionDiagnostics: [{ xyzBase64: '////', normalWBase64: '/w==' }],
    normalDiagnostics: [{ xyzBase64: '//8=', normalWBase64: '/w==' }],
    tangentDiagnostics: [{ xyzwBase64: '////' }], bitangentDiagnostics: [{ xyzwBase64: '//8=' }],
    vertexColorDiagnostics: [{ rgbaBase64: '////' }]
  };
  for (const channel of ['resource.readFlverMesh', 'resource.readMapPartMesh']) {
    const input = { data: mesh };
    const output = sanitizeRendererIpcResult(channel, input) as typeof input;
    assert.deepEqual(output, input);
    assert.notEqual(output.data.uvSetsBase64, mesh.uvSetsBase64);
  }
  const input = { data: { ...mesh, sourceBoneIndicesBase64: '////' } };
  const charInput = { data: { models: [{ meshes: [input.data] }] } };
  assert.deepEqual(sanitizeRendererIpcResult('resource.readTaeChrbndPreview', charInput), charInput);
  for (const value of [
    { positionsBase64: '/tmp/private' },
    { data: { nested: { positionsBase64: '/tmp/private' }, bytesBase64: '/tmp/private' } },
    { data: { uvSetsBase64: { 0: '/tmp/private' }, positionDiagnostics: { 0: { xyzBase64: '/tmp/private' } } } },
    { data: { positionsBase64: '/tmp/private.txt', uvSetsBase64: ['/tmp/private.txt'] } }
  ]) assert.equal(JSON.stringify(sanitizeRendererIpcResult('resource.readFlverMesh', value)).includes('/tmp/private'), false);
});

test('PARAM, EMEVD, animation and raw-range payloads only survive at their registered paths', () => {
  const cases: [string, unknown][] = [
    ['resource.readParamDocument', { data: { rows: [{ dataBase64: '/tmp/private' }] } }],
    ...['resource.readParamPage', 'resource.readContainerParamPage', 'resource.readParamRows']
      .map(channel => [channel, { rows: [{ dataBase64: '/tmp/private' }] }] as [string, unknown]),
    ['resource.readEmevdDocument', { data: { instructionsSample: [{ argsBase64: '/tmp/private' }] } }],
    ['resource.readTaeAnimationClip', { data: { splineRawPayloadBase64: '/tmp/private' } }],
    ['resource.readRawRange', { base64: '/tmp/private' }]
  ];
  for (const [channel, value] of cases) {
    assert.deepEqual(sanitizeRendererIpcResult(channel, value), value, channel);
    assert.equal(JSON.stringify(sanitizeRendererIpcResult('resource.readParamIndexPage', value)).includes('/tmp/private'), false);
    assert.equal(JSON.stringify(sanitizeRendererValue({ channel, schemaVersion: 1, ...value as object })).includes('/tmp/private'), false);
  }
});

test('texture profiles preserve only fixed PNG data URIs at native preview slots', () => {
  const png = 'data:image/png;base64,+/8=';
  const mesh = { projectionTexturePreviewToken: png };
  const texture = { texturePreviewToken: png, normalTexturePreviewToken: png, metalnessTexturePreviewToken: png,
    mask1TexturePreviewToken: png, albedo2: { texturePreviewToken: png }, normal2: { texturePreviewToken: png } };
  const cases: [string, unknown][] = [
    ['resource.readTpfTexturePreview', { data: { previewToken: png } }],
    ['resource.readFlverMesh', { data: { texturePreviewToken: png, mask1TexturePreviewToken: png,
      albedo2TexturePreviewToken: png, normal2TexturePreviewToken: png } }],
    ['resource.readTaeChrbndPreview', { data: { models: [{ meshes: [mesh], texturePreviewToken: png, texturePreviews: [texture] }] } }],
    ['resource.readMapStaticGeometry', { data: { texturePreviewToken: png, chunks: [{ texturePreviewToken: png }] } }],
    ['document.readContent', { value: { previewToken: png } }]
  ];
  for (const [channel, value] of cases) assert.deepEqual(sanitizeRendererIpcResult(channel, value), value, channel);
  const content = { ok: true as const, value: { previewToken: png }, diagnostics: [] };
  assert.deepEqual(toRendererEditorDocumentResult(content, 'document.readContent'), content);
  for (const value of ['/tmp/private', 'data:image/png;base64,/tmp/private.txt', 'data:text/plain;base64,+/8=']) {
    const output = sanitizeRendererIpcResult('resource.readTpfTexturePreview', { data: { previewToken: value } });
    assert.notDeepEqual(output, { data: { previewToken: value } });
  }
});

test('diagnostic context never inherits source-text or binary exemptions and does not erase failure status', () => {
  const diagnostic = { bytesBase64: '/tmp/private', argsBase64: '/tmp/private', text: '/tmp/private',
    nested: { data: { positionsBase64: '/tmp/private', uvSetsBase64: ['/home/asus/x'] } },
    bytes: new Uint8Array(Buffer.from('/tmp/private')), buffer: new Uint8Array(Buffer.from('/tmp/private')).buffer };
  for (const key of ['diagnostics', 'details', 'error', 'errors', 'Diagnostic', 'Details']) {
    const input = { ok: false, code: 'FAILED_NOT_SUCCESS', data: { [key]: diagnostic }, sourcePrefix: '/tmp/source' };
    for (const project of [sanitizeRendererValue, stripPathFields,
      (value: unknown) => sanitizeRendererIpcResult('resource.readFlverMesh', value)]) {
      const output = project(input) as typeof input;
      assert.equal(output.ok, false);
      assert.equal(output.code, 'FAILED_NOT_SUCCESS');
      assert.equal(JSON.stringify(output.data).includes('/tmp/private'), false);
      assert.equal(JSON.stringify(output.data).includes('/home/asus/x'), false);
      assert.equal(output.data[key]!.bytes, '[二进制诊断已隐藏]');
      assert.equal(output.data[key]!.buffer, '[二进制诊断已隐藏]');
    }
    assert.equal((sanitizeRendererValue(input) as typeof input).sourcePrefix, input.sourcePrefix);
    assert.equal(input.data[key]!.text, '/tmp/private', 'outbound projection must not mutate tool arguments/source data');
  }
  const output = sanitizeDiagnostics([{ severity: 'error', code: 'FAILED', message: '/tmp/private', details: diagnostic }]);
  assert.equal(JSON.stringify(output).includes('/tmp/private'), false);
});
