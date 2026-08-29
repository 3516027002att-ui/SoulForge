import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CharacterPreviewBundle, FlverPreviewBone } from '@soulforge/shared';
import { buildBundleSemanticScene } from './FlverViewer.js';

function float32Base64(values: readonly number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString('base64');
}

function uint16Base64(values: readonly number[]): string {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes.toString('base64');
}

const leaderBone: FlverPreviewBone = {
  index: 0,
  name: 'Root',
  parentIndex: -1,
  childIndex: -1,
  nextSiblingIndex: -1,
  hierarchyId: 'Root#0',
  translation: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  rotationOrder: 'XZY'
};

describe('buildBundleSemanticScene action assembly projection', () => {
  it('preserves a remapped body mesh leader skeleton id', () => {
    const bundle: CharacterPreviewBundle = {
      meshCount: 1,
      vertexCount: 1,
      boneCount: 1,
      leaderModelId: 'leader',
      models: [
        {
          modelId: 'leader',
          entry: { index: 0, id: 1, name: 'c0000.flver', duplicateOrdinal: 0, contentHash: 'leader-hash' },
          meshCount: 0,
          boneCount: 1,
          meshes: [],
          bones: [leaderBone]
        },
        {
          modelId: 'body-part',
          entry: { index: 0, id: 2, name: 'bd_preview.flver', duplicateOrdinal: 0, contentHash: 'part-hash' },
          meshCount: 1,
          boneCount: 0,
          bones: [],
          meshes: [{
            meshIndex: 0,
            vertexCount: 1,
            indexSize: 16,
            positionsBase64: float32Base64([0, 0, 0]),
            indicesBase64: '',
            boneIndicesBase64: uint16Base64([0, 0, 0, 0]),
            boneWeightsBase64: float32Base64([1, 0, 0, 0]),
            skinningMode: 'weighted',
            boneIndexSpace: 'flver-global',
            skeletonId: 'leader'
          }]
        }
      ]
    };

    const scene = buildBundleSemanticScene(bundle);
    assert.equal(scene.meshes[0]?.skeletonId, 'leader');
    assert.equal(scene.skeletons?.length, 1);
    assert.equal(scene.skeletons?.[0]?.id, 'leader');
  });

  it('shows and tightly frames markers for a skeleton-only bundle', () => {
    const bundle: CharacterPreviewBundle = {
      meshCount: 0,
      vertexCount: 0,
      boneCount: 1,
      leaderModelId: 'leader',
      models: [{
        modelId: 'leader',
        entry: { index: 0, id: 1, name: 'c0000.flver', duplicateOrdinal: 0, contentHash: 'leader-hash' },
        meshCount: 0,
        boneCount: 1,
        meshes: [],
        bones: [leaderBone]
      }]
    };

    const scene = buildBundleSemanticScene(bundle);
    assert.equal(scene.showSkeletonMarkers, true);
    assert.deepEqual(scene.bounds.min, [-7.5, -7.5, -7.5]);
    assert.deepEqual(scene.bounds.max, [7.5, 7.5, 7.5]);
  });
});
