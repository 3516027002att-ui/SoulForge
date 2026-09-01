import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  FlverPreviewBone,
  FlverPreviewModel
} from '@soulforge/shared';
import { remapCharacterBundleToLeader } from '../../../../../packages/core/src/character/characterAssembly.js';

function bone(
  index: number,
  name: string,
  parentIndex: number,
  hierarchyId: string
): FlverPreviewBone {
  return {
    index,
    name,
    parentIndex,
    childIndex: -1,
    nextSiblingIndex: -1,
    hierarchyId,
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    rotationOrder: 'XZY'
  };
}

function model(
  modelId: string,
  bones: FlverPreviewBone[],
  meshes: FlverPreviewModel['meshes']
): FlverPreviewModel {
  return {
    modelId,
    entry: {
      index: 0,
      id: modelId === 'leader' ? 1 : 2,
      name: `${modelId}.flver`,
      duplicateOrdinal: 0,
      contentHash: `${modelId}-hash`
    },
    meshCount: meshes.length,
    boneCount: bones.length,
    meshes,
    bones
  };
}

function uint16Base64(values: readonly number[]): string {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes.toString('base64');
}

function float32Base64(values: readonly number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString('base64');
}

const headMesh: FlverPreviewModel['meshes'][number] = {
  meshIndex: 0,
  vertexCount: 1,
  indexSize: 16,
  positionsBase64: float32Base64([0, 0, 0]),
  indicesBase64: '',
  boneIndicesBase64: uint16Base64([3, 3, 3, 3]),
  boneWeightsBase64: float32Base64([1, 0, 0, 0]),
  skinningMode: 'weighted',
  boneIndexSpace: 'flver-global'
};

describe('character compatibility skeleton augmentation', () => {
  it('appends an exact native head-bone chain and remaps its positive weights', () => {
    const leader = model('leader', [
      bone(0, 'Root', -1, 'Root#0'),
      bone(1, 'Head', 0, 'Root#0/Head#0')
    ], []);
    const head = model('head', [
      bone(1, 'Head', 0, 'root/Head#0'),
      bone(2, 'HD_L_bone1', 1, 'root/Head#0/HD_L_bone1#0'),
      bone(3, 'HD_L_bone2', 2, 'root/Head#0/HD_L_bone1#0/HD_L_bone2#0')
    ], [headMesh]);

    const result = remapCharacterBundleToLeader(leader, [head]);

    assert.equal(result.ok, true);
    assert.ok(result.bundle);
    assert.equal(result.bundle.boneCount, 4);
    assert.deepEqual(result.bundle.models[0]?.bones.map((candidate) => candidate.name), [
      'Root', 'Head', 'HD_L_bone1', 'HD_L_bone2'
    ]);
    assert.equal(result.bundle.models[0]?.bones[2]?.parentIndex, 1);
    assert.equal(result.bundle.models[0]?.bones[3]?.parentIndex, 2);
    const remappedIndices = Buffer.from(
      result.bundle.models[1]?.meshes[0]?.boneIndicesBase64 ?? '',
      'base64'
    );
    assert.equal(remappedIndices.readUInt16LE(0), 3);
    assert.equal(result.bundle.models[1]?.bones.length, 0);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'CHARACTER_BONE_AUGMENTED'));
  });

  it('fails closed for an invalid native parent instead of inventing a skeleton link', () => {
    const leader = model('leader', [bone(0, 'Root', -1, 'Root#0')], []);
    const broken = model('broken', [
      bone(4, 'Unknown', 99, 'root/Unknown#0')
    ], [{
      ...headMesh,
      boneIndicesBase64: uint16Base64([4, 4, 4, 4])
    }]);

    const result = remapCharacterBundleToLeader(leader, [broken]);

    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'CHARACTER_BONE_PARENT_INVALID'));
  });
});
