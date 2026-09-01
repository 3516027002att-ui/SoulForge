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
  it('按 material index 绑定不同 albedo，不用首张纹理覆盖未匹配材质', () => {
    const baseTexture = 'data:image/png;base64,base';
    const materialTexture = 'data:image/png;base64,material';
    const mesh = (meshIndex: number, materialIndex: number, renderMode?: 'surface' | 'projected-decal') => ({
      meshIndex,
      materialIndex,
      vertexCount: 3,
      indexSize: 16 as const,
      positionsBase64: float32Base64([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indicesBase64: uint16Base64([0, 1, 2]),
      skinningMode: 'static' as const,
      boneIndexSpace: 'none' as const,
      ...(renderMode ? { renderMode } : {})
    });
    const bundle: CharacterPreviewBundle = {
      meshCount: 2,
      vertexCount: 6,
      boneCount: 0,
      leaderModelId: 'model',
      models: [{
        modelId: 'model',
        entry: { index: 0, id: 1, name: 'c1130.flver', duplicateOrdinal: 0, contentHash: 'hash' },
        meshCount: 2,
        boneCount: 0,
        meshes: [mesh(0, 0), mesh(1, 1)],
        bones: [],
        texturePreviewToken: baseTexture,
        texturePreviews: [{
          materialIndex: 1,
          textureName: 'c1130_head_a',
          texturePreviewToken: materialTexture,
          width: 1,
          height: 1,
          colorSpace: 'srgb'
        }]
    }]
    };

    const scene = buildBundleSemanticScene(bundle, undefined, {
      kind: 'image-uri',
      uri: baseTexture,
      colorSpace: 'srgb'
    });
    const baseSceneTexture = scene.meshes[0]?.texture;
    const materialSceneTexture = scene.meshes[1]?.texture;
    assert.equal(materialSceneTexture?.kind, 'image-uri');
    if (baseSceneTexture !== undefined || materialSceneTexture?.kind !== 'image-uri') {
      throw new Error('expected per-material texture projection without legacy override');
    }
    assert.equal(materialSceneTexture.uri, materialTexture);
  });

  it('没有逐材质表时保留旧单纹理回退', () => {
    const legacyTexture = 'data:image/png;base64,legacy';
    const bundle: CharacterPreviewBundle = {
      meshCount: 2,
      vertexCount: 6,
      boneCount: 0,
      leaderModelId: 'model',
      models: [{
        modelId: 'model',
        entry: { index: 0, id: 1, name: 'legacy.flver', duplicateOrdinal: 0, contentHash: 'legacy-hash' },
        meshCount: 2,
        boneCount: 0,
        meshes: [0, -1].map((materialIndex, meshIndex) => ({
          meshIndex,
          materialIndex,
          vertexCount: 3,
          indexSize: 16 as const,
          positionsBase64: float32Base64([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indicesBase64: uint16Base64([0, 1, 2]),
          skinningMode: 'static' as const,
          boneIndexSpace: 'none' as const
        })),
        bones: [],
        texturePreviewToken: legacyTexture
      }]
    };

    const scene = buildBundleSemanticScene(bundle);
    assert.equal(scene.meshes[0]?.texture?.kind, 'image-uri');
    assert.equal(scene.meshes[1]?.texture?.kind, 'image-uri');
    assert.equal(scene.meshes[0]?.texture && scene.meshes[0].texture.kind === 'image-uri'
      ? scene.meshes[0].texture.uri
      : undefined, legacyTexture);
    assert.equal(scene.meshes[1]?.texture && scene.meshes[1].texture.kind === 'image-uri'
      ? scene.meshes[1].texture.uri
      : undefined, legacyTexture);
  });

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

  it('preserves native projected-decal classification without letting it distort preview bounds', () => {
    const bundle: CharacterPreviewBundle = {
      meshCount: 2,
      vertexCount: 6,
      boneCount: 0,
      leaderModelId: 'model',
      models: [{
        modelId: 'model',
        entry: { index: 0, id: 1, name: 'model.flver', duplicateOrdinal: 0, contentHash: 'model-hash' },
        meshCount: 2,
        boneCount: 0,
        meshes: [
          {
            meshIndex: 0,
            vertexCount: 3,
            indexSize: 16,
            positionsBase64: float32Base64([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            indicesBase64: uint16Base64([0, 1, 2]),
            skinningMode: 'static',
            boneIndexSpace: 'none',
            renderMode: 'surface'
          },
          {
            meshIndex: 1,
            vertexCount: 3,
            indexSize: 16,
            positionsBase64: float32Base64([0, 100, 0, 1, 100, 0, 0, 101, 0]),
            indicesBase64: uint16Base64([0, 1, 2]),
            skinningMode: 'static',
            boneIndexSpace: 'none',
            renderMode: 'projected-decal'
          }
        ],
        bones: []
      }]
    };

    const scene = buildBundleSemanticScene(bundle);
    assert.equal(scene.meshes[1]?.previewRenderMode, 'projected-decal');
    assert.deepEqual(scene.bounds.min, [0, 0, 0]);
    assert.deepEqual(scene.bounds.max, [1, 1, 0]);
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
