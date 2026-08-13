/**
 * MODEL-51A — FLVER 前端 DTO 的 pages 投影契约测试。
 *
 * 覆盖：projectFlverDocumentPages 把 read-flver-document envelope 投影成
 * bounds / mesh / material-slot 三页；缺失字段（无 boundingBox、无 mesh、
 * 无 textureSlots）的防御路径；isFlverDocument 窄守卫的接受/拒绝。
 * 负向优先：不是「有数据时对」，而是「缺字段时不崩且给可读默认」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectFlverDocumentPages,
  isFlverDocument,
  type FlverDocument
} from './flver-editor.js';

function makeEnvelope(overrides: Record<string, unknown> = {}): FlverDocument {
  return {
    format: 'FLVER',
    version: 'L',
    internalVersion: '0x2001A',
    sourceSize: 4096,
    sourceHash: 'abc123',
    skeletonTransformCount: 8,
    materialCount: 1,
    boneCount: 4,
    vertexBufferCount: 1,
    meshCount: 1,
    faceSetCount: 1,
    bufferLayoutCount: 1,
    textureCount: 2,
    faceCount: 12,
    totalFaceCount: 12,
    vertexStride: 40,
    vertexStrides: [40],
    unicode: false,
    boundingBox: { min: [0, 0, 0], max: [10, 20, 30] },
    materials: [
      {
        name: 'mat_a',
        mtdPath: 'mtd/m_a.mtd',
        textureCount: 2,
        flags: 0,
        gxOffset: 0,
        unk18: 0,
        gxList: null
      }
    ],
    materialsTruncated: false,
    bones: [{ name: 'bone_a', parentIndex: -1, nextSiblingIndex: -1 }],
    bonesTruncated: false,
    meshes: [
      {
        index: 0,
        dynamic: 0,
        materialIndex: 0,
        defaultBoneIndex: 0,
        vertexCount: 10,
        vertexStride: 40,
        bufferLayoutIndex: 0,
        faceSetCount: 1,
        boneCount: 4,
        indexFormat: 16
      }
    ],
    meshesTruncated: false,
    bufferLayouts: [],
    textureSlots: [
      { index: 0, type: 'g', path: 'tex/a.dds', materialIndex: 0 },
      { index: 1, type: 'g', path: 'tex/b.dds', materialIndex: 0 }
    ],
    texturesTruncated: false,
    layoutWarnings: [],
    unparsedGaps: [],
    roundTrip: {
      byteIdentical: true,
      semanticIdentical: true,
      sourceHash: 'abc123',
      rebuiltHash: 'abc123',
      skeletonTransformCount: 8,
      materialCount: 1,
      boneCount: 4,
      meshCount: 1
    },
    authority: 'partial',
    ...overrides
  } as FlverDocument;
}

test('projectFlverDocumentPages 投影 bounds page（min/max/extent）', () => {
  const pages = projectFlverDocumentPages(makeEnvelope());
  assert.deepEqual(pages.bounds.min, [0, 0, 0]);
  assert.deepEqual(pages.bounds.max, [10, 20, 30]);
  assert.deepEqual(pages.bounds.extent, [10, 20, 30]);
});

test('projectFlverDocumentPages 投影 mesh page（保留截断元数据）', () => {
  const pages = projectFlverDocumentPages(makeEnvelope());
  assert.equal(pages.meshes.meshCount, 1);
  assert.equal(pages.meshes.meshes.length, 1);
  assert.equal(pages.meshes.meshes[0]!.materialIndex, 0);
  assert.equal(pages.meshes.meshes[0]!.indexFormat, 16);
  assert.equal(pages.meshes.meshesTruncated, false);
});

test('projectFlverDocumentPages 投影 material-slot page（textures + materials）', () => {
  const pages = projectFlverDocumentPages(makeEnvelope());
  assert.equal(pages.materialSlots.textureCount, 2);
  assert.equal(pages.materialSlots.textures.length, 2);
  assert.equal(pages.materialSlots.textures[1]!.path, 'tex/b.dds');
  assert.equal(pages.materialSlots.textures[1]!.materialIndex, 0);
  assert.equal(pages.materialSlots.materials.length, 1);
  assert.equal(pages.materialSlots.materials[0]!.name, 'mat_a');
});

test('缺 boundingBox 时 bounds 回落为 [0,0,0]（不崩）', () => {
  const pages = projectFlverDocumentPages(makeEnvelope({ boundingBox: undefined }));
  assert.deepEqual(pages.bounds.min, [0, 0, 0]);
  assert.deepEqual(pages.bounds.max, [0, 0, 0]);
  assert.deepEqual(pages.bounds.extent, [0, 0, 0]);
});

test('缺 meshes / textureSlots 时对应 page 为空列表（不崩）', () => {
  const pages = projectFlverDocumentPages(makeEnvelope({ meshes: undefined, textureSlots: undefined }));
  assert.deepEqual(pages.meshes.meshes, []);
  assert.equal(pages.meshes.meshCount, 1);
  assert.deepEqual(pages.materialSlots.textures, []);
  assert.equal(pages.materialSlots.textureCount, 2);
});

test('isFlverDocument 窄守卫：接受 FLVER envelope、拒绝垃圾值', () => {
  assert.equal(isFlverDocument(makeEnvelope()), true);
  assert.equal(isFlverDocument({ format: 'GPARAM', sourceHash: 'x', authority: 'native-verified' }), false);
  assert.equal(isFlverDocument(null), false);
  assert.equal(isFlverDocument('FLVER'), false);
});
