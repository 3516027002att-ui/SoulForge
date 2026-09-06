import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CharacterPreviewBundle, FlverPreviewBone } from '@soulforge/shared';
import {
  buildBundleSemanticScene,
  createFlverSkeletonErrorState,
  describeFlverSkeletonLoadState,
  resolveFlverSkeletonLoadState
} from './FlverViewer.js';

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

describe('FLVER skeleton IPC load state', () => {
  it('Bridge 失败保留结构化诊断并显示 code/message', () => {
    const state = resolveFlverSkeletonLoadState({
      ok: false,
      diagnostics: [{ severity: 'error', code: 'RESOURCE_NOT_INDEXED', message: '资源未索引。' }]
    });

    assert.equal(state.status, 'error');
    assert.deepEqual(state.bones, []);
    assert.deepEqual(state.diagnostics, [{
      severity: 'error',
      code: 'RESOURCE_NOT_INDEXED',
      message: '资源未索引。'
    }]);
    assert.equal(describeFlverSkeletonLoadState(state), '骨骼加载失败：RESOURCE_NOT_INDEXED · 资源未索引。');
  });

  it('Bridge 返回空 bones 时进入 empty，而不是继续 loading', () => {
    const state = resolveFlverSkeletonLoadState({ ok: true, data: { bones: [] } });

    assert.equal(state.status, 'empty');
    assert.deepEqual(state.bones, []);
    assert.equal(describeFlverSkeletonLoadState(state), '骨骼为空：Bridge 返回 0 根骨骼');
  });

  it('Bridge 返回骨骼时进入 ready 并保留原生层级数据', () => {
    const state = resolveFlverSkeletonLoadState({
      ok: true,
      data: {
        bones: [{
          name: 'Root',
          parentIndex: -1,
          translation: [1, 2, 3],
          rotation: [0.1, 0.2, 0.3],
          scale: [1, 1, 1],
          rotationOrder: 'XZY'
        }]
      }
    });

    assert.equal(state.status, 'ready');
    assert.deepEqual(state.bones[0], {
      name: 'Root',
      parentIndex: -1,
      translation: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
      scale: [1, 1, 1],
      rotationOrder: 'XZY'
    });
    assert.equal(describeFlverSkeletonLoadState(state), '骨骼已加载：1 bones');
  });

  it('Bridge 异常也转成可读的 error 诊断', () => {
    const state = createFlverSkeletonErrorState(new Error('IPC channel closed'));

    assert.equal(state.status, 'error');
    assert.equal(state.diagnostics[0]?.code, 'FLVER_SKELETON_READ_EXCEPTION');
    assert.equal(state.diagnostics[0]?.message, 'IPC channel closed');
  });
});

describe('buildBundleSemanticScene action assembly projection', () => {
  it('按 material index 绑定不同 albedo，不用首张纹理覆盖未匹配材质', () => {
    const baseTexture = 'data:image/png;base64,base';
    const materialTexture = 'data:image/png;base64,material';
    const mesh = (meshIndex: number, materialIndex: number, renderMode?: 'surface' | 'projected-decal' | 'compatibility-projected', cullBackfaces?: boolean) => ({
      meshIndex,
      materialIndex,
      vertexCount: 3,
      indexSize: 16 as const,
      positionsBase64: float32Base64([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indicesBase64: uint16Base64([0, 1, 2]),
      skinningMode: 'static' as const,
      boneIndexSpace: 'none' as const,
       ...(renderMode ? { renderMode } : {}),
       ...(cullBackfaces !== undefined ? { cullBackfaces } : {})
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
         meshes: [mesh(0, 0, undefined, true), mesh(1, 1)],
        bones: [],
        texturePreviewToken: baseTexture,
        texturePreviews: [{
          materialIndex: 1,
          textureName: 'c1130_head_a',
          texturePreviewToken: materialTexture,
          width: 1,
          height: 1,
          colorSpace: 'srgb',
          normalTextureName: 'c1130_head_n',
          normalTexturePreviewToken: 'data:image/png;base64:normal',
          normalTextureColorSpace: 'linear',
          metalnessTextureName: 'c1130_head_m',
          metalnessTexturePreviewToken: 'data:image/png;base64:metalness',
          metalnessTextureColorSpace: 'linear',
          mask1TextureName: 'c1130_head_1m',
          mask1TexturePreviewToken: 'data:image/png;base64,mask1',
          mask1TextureColorSpace: 'linear'
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
    assert.equal(scene.meshes[0]?.cullBackfaces, true);
    assert.equal(scene.meshes[1]?.normalTexture?.kind, 'image-uri');
    assert.equal(scene.meshes[1]?.normalTexture && scene.meshes[1].normalTexture.kind === 'image-uri'
      ? scene.meshes[1].normalTexture.uri
      : undefined, 'data:image/png;base64:normal');
    assert.equal(scene.meshes[1]?.metalnessTexture?.kind, 'image-uri');
    assert.equal(scene.meshes[1]?.metalnessTexture && scene.meshes[1].metalnessTexture.kind === 'image-uri'
      ? scene.meshes[1].metalnessTexture.uri
      : undefined, 'data:image/png;base64:metalness');
    assert.equal(Object.prototype.hasOwnProperty.call(scene.meshes[1], 'mask1Texture'), false);
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

  it('keeps follower binding authoritative when a legacy bundle labels its mesh as leader', () => {
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
          bindingBones: [{ ...leaderBone, name: 'PartRoot', translation: [2, 0, 0], hierarchyId: 'PartRoot#0' }],
          bindingBoneMap: [0],
          meshes: [{
            meshIndex: 0,
            vertexCount: 1,
            indexSize: 16,
            positionsBase64: float32Base64([0, 0, 0]),
            indicesBase64: '',
            boneIndicesBase64: uint16Base64([7, 7, 7, 7]),
            sourceBoneIndicesBase64: uint16Base64([0, 0, 0, 0]),
            boneWeightsBase64: float32Base64([1, 0, 0, 0]),
            skinningMode: 'weighted',
            boneIndexSpace: 'flver-global',
            skeletonId: 'leader'
          }]
        }
      ]
    };

    const scene = buildBundleSemanticScene(bundle);
    assert.equal(scene.meshes[0]?.skeletonId, 'body-part');
    assert.equal(scene.meshes[0]?.skinIndices?.[0], 0);
    assert.equal(scene.skeletonBindings?.length, 1);
  });

  it('为保留原生绑定姿态的部件建立 follower 语义并消费源索引', () => {
    const partBone: FlverPreviewBone = {
      ...leaderBone,
      name: 'PartRoot',
      translation: [2, 0, 0],
      hierarchyId: 'PartRoot#0'
    };
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
          bindingBones: [partBone],
          bindingBoneMap: [0],
          meshes: [{
            meshIndex: 0,
            vertexCount: 1,
            indexSize: 16,
            positionsBase64: float32Base64([0, 0, 0]),
            indicesBase64: '',
            // Leader-space data is deliberately different; semantic decode
            // must use the retained source payload for the follower.
            boneIndicesBase64: uint16Base64([7, 7, 7, 7]),
            sourceBoneIndicesBase64: uint16Base64([0, 0, 0, 0]),
            boneWeightsBase64: float32Base64([1, 0, 0, 0]),
            skinningMode: 'weighted',
            boneIndexSpace: 'flver-global',
            skeletonId: 'body-part'
          }]
        }
      ]
    };

    const scene = buildBundleSemanticScene(bundle);
    assert.equal(scene.meshes[0]?.skeletonId, 'body-part');
    assert.equal(scene.meshes[0]?.skinIndices?.[0], 0);
    assert.equal(scene.skeletonBindings?.length, 1);
    assert.equal(scene.skeletonBindings?.[0]?.leaderSkeletonId, 'leader');
    assert.equal(scene.skeletonBindings?.[0]?.bones[0]?.translation[0], 2);
  });

  it('按原生骨骼 index 集合校验稀疏/重排骨骼，不把数组长度当作上界', () => {
    const sparseBones: FlverPreviewBone[] = [
      { ...leaderBone, index: 9, name: 'Hand.R', hierarchyId: 'Hand.R#9' },
      { ...leaderBone, index: 4, name: 'Root', hierarchyId: 'Root#4' }
    ];
    const bundle: CharacterPreviewBundle = {
      meshCount: 1,
      vertexCount: 1,
      boneCount: sparseBones.length,
      leaderModelId: 'sparse',
      models: [{
        modelId: 'sparse',
        entry: { index: 0, id: 1, name: 'sparse.flver', duplicateOrdinal: 0, contentHash: 'sparse-hash' },
        meshCount: 1,
        boneCount: sparseBones.length,
        meshes: [{
          meshIndex: 0,
          vertexCount: 1,
          indexSize: 16,
          positionsBase64: float32Base64([0, 0, 0]),
          indicesBase64: '',
          boneIndicesBase64: uint16Base64([9, 9, 9, 9]),
          boneWeightsBase64: float32Base64([1, 0, 0, 0]),
          skinningMode: 'weighted',
          boneIndexSpace: 'flver-global'
        }],
        bones: sparseBones
      }]
    };

    const scene = buildBundleSemanticScene(bundle);
    assert.equal(scene.meshes[0]?.skinIndices?.[0], 9);
    assert.deepEqual(scene.skeletons?.[0]?.bones.map((bone) => bone.index), [9, 4]);
  });

  it('接受原生 Byte4C 蒙皮权重的量化误差', () => {
    const quantizedWeights = [4, 50, 146, 52].map((value) => value / 255);
    const bundle: CharacterPreviewBundle = {
      meshCount: 1,
      vertexCount: 1,
      boneCount: 1,
      leaderModelId: 'quantized',
      models: [{
        modelId: 'quantized',
        entry: { index: 0, id: 1, name: 'quantized.flver', duplicateOrdinal: 0, contentHash: 'quantized-hash' },
        meshCount: 1,
        boneCount: 1,
        meshes: [{
          meshIndex: 0,
          vertexCount: 1,
          indexSize: 16,
          positionsBase64: float32Base64([0, 0, 0]),
          indicesBase64: '',
          boneIndicesBase64: uint16Base64([0, 0, 0, 0]),
          boneWeightsBase64: float32Base64(quantizedWeights),
          skinningMode: 'weighted',
          boneIndexSpace: 'flver-global'
        }],
        bones: [leaderBone]
      }]
    };

    const scene = buildBundleSemanticScene(bundle);
    assert.ok(Math.abs((scene.meshes[0]?.skinWeights?.[0] ?? 0) - quantizedWeights[0]!) < 1e-6);
    assert.ok(Array.from(scene.meshes[0]?.skinWeights ?? []).reduce((sum, weight) => sum + weight, 0) < 1);
  });

  it('仍拒绝非原生量化且明显不归一的蒙皮权重', () => {
    const bundle: CharacterPreviewBundle = {
      meshCount: 1,
      vertexCount: 1,
      boneCount: 1,
      leaderModelId: 'invalid-weights',
      models: [{
        modelId: 'invalid-weights',
        entry: { index: 0, id: 1, name: 'invalid-weights.flver', duplicateOrdinal: 0, contentHash: 'invalid-weights-hash' },
        meshCount: 1,
        boneCount: 1,
        meshes: [{
          meshIndex: 0,
          vertexCount: 1,
          indexSize: 16,
          positionsBase64: float32Base64([0, 0, 0]),
          indicesBase64: '',
          boneIndicesBase64: uint16Base64([0, 0, 0, 0]),
          boneWeightsBase64: float32Base64([0.49, 0.49, 0, 0]),
          skinningMode: 'weighted',
          boneIndexSpace: 'flver-global'
        }],
        bones: [leaderBone]
      }]
    };

    assert.throws(
      () => buildBundleSemanticScene(bundle),
      /FLVER_SKIN_WEIGHT_SUM_INVALID/
    );
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
