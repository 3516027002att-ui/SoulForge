import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ModelResourcePool, normalizeModelResourceKey, type MeshGeometryWire } from './modelResourcePool.js';
import { groupSceneDrawItems } from './threeSceneController.js';

const dummyPositions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
const dummyIndices16 = Buffer.from(new Uint16Array([0, 1, 2]).buffer).toString('base64');
const dummyIndices32 = Buffer.from(new Uint32Array([0, 1, 2]).buffer).toString('base64');
const variantPositions = Buffer.from(new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  2, 0, 0, 3, 0, 0, 2, 1, 0,
  4, 0, 0, 5, 0, 0, 4, 1, 0
]).buffer).toString('base64');
const variantIndices16 = Buffer.from(new Uint16Array([
  0, 1, 2,
  3, 4, 5,
  6, 7, 8
]).buffer).toString('base64');

const tracker = <T extends { dispose(): void }>(resource: T): T => resource;

test('ModelResourcePool：相同 modelName 的多 Part 共享唯一 BufferGeometry 与 Material 实例', () => {
  const pool = new ModelResourcePool();
  const meshWire: MeshGeometryWire = {
    positionsBase64: dummyPositions,
    indicesBase64: dummyIndices16,
    indexSize: 16,
    vertexCount: 3
  };

  const res1 = pool.updateModelGeometry(THREE, tracker, 'm000010.mapbnd.dcx', meshWire);
  const res2 = pool.updateModelGeometry(THREE, tracker, 'm000010', meshWire);
  const res3 = pool.updateModelGeometry(THREE, tracker, 'D:\\map\\M000010.FLVER', meshWire);

  assert.equal(res1.geometry, res2.geometry);
  assert.equal(res2.geometry, res3.geometry);
  assert.equal(res1.material, res2.material);
  assert.equal(normalizeModelResourceKey('D:\\map\\M000010.FLVER.dcx'), 'm000010');
});

test('ModelResourcePool：indexSize 为 16/32 时精准创建 Uint16/Uint32 缓冲，无脆弱启发式', () => {
  const pool = new ModelResourcePool();

  const geo16 = pool.getOrCreateGeometry(THREE, tracker, 'm16', {
    positionsBase64: dummyPositions,
    indicesBase64: dummyIndices16,
    indexSize: 16,
    vertexCount: 3
  });
  assert.ok(geo16.index instanceof THREE.Uint16BufferAttribute);

  const geo32 = pool.getOrCreateGeometry(THREE, tracker, 'm32', {
    positionsBase64: dummyPositions,
    indicesBase64: dummyIndices32,
    indexSize: 32,
    vertexCount: 3
  });
  assert.ok(geo32.index instanceof THREE.Uint32BufferAttribute);
});

test('ModelResourcePool：renderer-local typed bytes 路径不需要重新 base64 解码', () => {
  const pool = new ModelResourcePool();
  const positionsBytes = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const indicesBytes = new Uint8Array(new Uint16Array([0, 1, 2]).buffer);
  const result = pool.updateModelGeometry(THREE, tracker, 'm-bytes', {
    positionsBase64: '',
    positionsBytes,
    indicesBytes,
    indexSize: 16,
    vertexCount: 3
  });

  assert.deepEqual(
    Array.from(result.geometry.getAttribute('position').array as ArrayLike<number>),
    [0, 0, 0, 1, 0, 0, 0, 1, 0]
  );
  assert.ok(result.geometry.index instanceof THREE.Uint16BufferAttribute);
  assert.deepEqual(Array.from(result.geometry.index.array), [0, 1, 2]);
});

test('ModelResourcePool：相同 normalized model 的不同 prepare cacheKey 不复用旧几何，但仍共享默认材质', () => {
  const pool = new ModelResourcePool();
  const meshWire: MeshGeometryWire = {
    positionsBase64: dummyPositions,
    indicesBase64: dummyIndices16,
    indexSize: 16,
    vertexCount: 3
  };
  const preparedA = pool.updateModelGeometry(THREE, tracker, 'M000010.FLVER', meshWire, { cacheKey: 'prepare-a' });
  const preparedB = pool.updateModelGeometry(THREE, tracker, 'm000010.mapbnd.dcx', meshWire, { cacheKey: 'prepare-b' });

  assert.notEqual(preparedA.geometry, preparedB.geometry);
  assert.equal(preparedA.material, preparedB.material);
});

test('ModelResourcePool：地图 FaceSet true/false/unknown 使用独立连续 variant 槽位并映射 WebGL2 side', () => {
  const pool = new ModelResourcePool();
  const result = pool.updateModelGeometry(THREE, tracker, 'm-cull-variants', {
    positionsBase64: variantPositions,
    indicesBase64: variantIndices16,
    indexSize: 16,
    vertexCount: 9,
    materialGroups: [
      { start: 0, count: 3, materialIndex: 4, cullBackfaces: true },
      { start: 3, count: 3, materialIndex: 4, cullBackfaces: false },
      { start: 6, count: 3, materialIndex: 4 }
    ]
  });

  assert.ok(Array.isArray(result.material));
  assert.equal(result.material.length, 3);
  assert.notEqual(result.material[0], result.material[1]);
  assert.notEqual(result.material[1], result.material[2]);
  assert.deepEqual(
    result.geometry.groups.map((group) => ({ start: group.start, count: group.count, materialIndex: group.materialIndex })),
    [
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
      { start: 6, count: 3, materialIndex: 2 }
    ]
  );
  assert.deepEqual(
    result.material.map((material) => material.side),
    [THREE.BackSide, THREE.DoubleSide, THREE.DoubleSide]
  );

  const trueOnly = pool.updateModelGeometry(THREE, tracker, 'm-cull-cache', {
    positionsBase64: dummyPositions,
    indicesBase64: dummyIndices16,
    indexSize: 16,
    vertexCount: 3,
    materialGroups: [{ start: 0, count: 3, materialIndex: 4, cullBackfaces: true }]
  });
  const falseOnly = pool.updateModelGeometry(THREE, tracker, 'm-cull-cache', {
    positionsBase64: dummyPositions,
    indicesBase64: dummyIndices16,
    indexSize: 16,
    vertexCount: 3,
    materialGroups: [{ start: 0, count: 3, materialIndex: 4, cullBackfaces: false }]
  });
  assert.notEqual(trueOnly.geometry, falseOnly.geometry);
  assert.notEqual(trueOnly.material, falseOnly.material);

  const ambiguousWithTopLevelTrue = pool.updateModelGeometry(THREE, tracker, 'm-cull-ambiguous', {
    positionsBase64: dummyPositions,
    indicesBase64: dummyIndices16,
    indexSize: 16,
    vertexCount: 3,
    cullBackfaces: true,
    materialGroups: [{ start: 0, count: 3, materialIndex: 4 }]
  });
  const confirmedTrue = pool.updateModelGeometry(THREE, tracker, 'm-cull-ambiguous', {
    positionsBase64: dummyPositions,
    indicesBase64: dummyIndices16,
    indexSize: 16,
    vertexCount: 3,
    cullBackfaces: true,
    materialGroups: [{ start: 0, count: 3, materialIndex: 4, cullBackfaces: true }]
  });
  assert.notEqual(ambiguousWithTopLevelTrue.geometry, confirmedTrue.geometry);
  assert.notEqual(ambiguousWithTopLevelTrue.material, confirmedTrue.material);
  assert.equal((ambiguousWithTopLevelTrue.material as THREE.Material).side, THREE.DoubleSide);
  assert.equal((confirmedTrue.material as THREE.Material).side, THREE.BackSide);
});

test('ModelResourcePool：typed bytes 只读取合法 subview，并校验 UV/normal/index 对齐', () => {
  const pool = new ModelResourcePool();
  const withSentinels = (source: ArrayBuffer): Uint8Array => {
    const wrapped = new Uint8Array(source.byteLength + 3);
    wrapped.fill(0xa5);
    wrapped.set(new Uint8Array(source), 1);
    return wrapped.subarray(1, 1 + source.byteLength);
  };
  const result = pool.updateModelGeometry(THREE, tracker, 'm-bytes-32', {
    positionsBase64: '',
    positionsBytes: withSentinels(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
    indicesBytes: withSentinels(new Uint32Array([0, 1, 2]).buffer),
    uvsBytes: withSentinels(new Float32Array([0, 0, 1, 0, 0, 1]).buffer),
    normalsBytes: withSentinels(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer),
    indexSize: 32,
    vertexCount: 3
  });

  assert.deepEqual(Array.from(result.geometry.getAttribute('uv').array as ArrayLike<number>), [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(result.geometry.getAttribute('normal').array as ArrayLike<number>), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.ok(result.geometry.index instanceof THREE.Uint32BufferAttribute);
  assert.deepEqual(Array.from(result.geometry.index.array), [0, 1, 2]);
});

test('ModelResourcePool：复用单例 Proxy 盒子与球体原型几何体', () => {
  const pool = new ModelResourcePool();

  const box1 = pool.getPrimitiveGeometry(THREE, tracker, 'box');
  const box2 = pool.getPrimitiveGeometry(THREE, tracker, 'box');
  assert.equal(box1, box2);

  const sphere1 = pool.getPrimitiveGeometry(THREE, tracker, 'sphere');
  const sphere2 = pool.getPrimitiveGeometry(THREE, tracker, 'sphere');
  assert.equal(sphere1, sphere2);
});

test('地图 draw items 按模型与 primitive 实例化分组，不按 placement 颜色拆 draw call', () => {
  const base = {
    label: 'part',
    entityKind: 'msb-part' as const,
    primitive: 'box' as const,
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    sourceResourceUri: 'fixture://map/m10.msb.dcx'
  };
  const batches = groupSceneDrawItems([
    { ...base, id: 'a', colorRgb: [1, 0, 0], modelName: 'M000010.FLVER' },
    { ...base, id: 'b', colorRgb: [0, 1, 0], modelName: 'm000010' },
    { ...base, id: 'c', colorRgb: [0, 0, 1] },
    { ...base, id: 'd', colorRgb: [1, 1, 0] }
  ]);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.items.length).sort(), [2, 2]);
});
