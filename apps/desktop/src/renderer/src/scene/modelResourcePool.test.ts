import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ModelResourcePool, type MeshGeometryWire } from './modelResourcePool.js';
import { groupSceneDrawItems } from './threeSceneController.js';

const dummyPositions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
const dummyIndices16 = Buffer.from(new Uint16Array([0, 1, 2]).buffer).toString('base64');
const dummyIndices32 = Buffer.from(new Uint32Array([0, 1, 2]).buffer).toString('base64');

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

  assert.equal(res1.geometry, res2.geometry);
  assert.equal(res1.material, res2.material);
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
