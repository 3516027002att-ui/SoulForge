import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SceneDrawList } from './sceneManifestBrowser.js';
import {
  computeRobustInitialCameraBounds,
  computeStablePointerDelta,
  FLVER_PREVIEW_FRAME_OPTIONS,
  normalizeSkinWeightsForThree,
  remapSkinIndicesToRuntime,
  validateFlverRuntimeFollowerBinding,
  validateFlverRuntimeSkeleton
} from './threeSceneController.js';

function drawListWithPositions(positions: Array<[number, number, number]>): SceneDrawList {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const position of positions) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, position[axis]!);
      max[axis] = Math.max(max[axis]!, position[axis]!);
    }
  }
  return {
    sourceUri: 'sf://workspace/map/m10',
    sourcePath: 'map/m10/m10.msb.dcx',
    game: 'sekiro',
    resourceKind: 'map',
    revision: 'test-revision',
    schemaVersion: 2,
    mapResourceUri: 'sf://workspace/map/m10',
    authority: 'partial',
    packetId: 'camera-test',
    chunkIndex: 0,
    chunkCount: 1,
    totalItemCount: positions.length,
    itemCount: positions.length,
    items: positions.map((position, index) => ({
      id: `part-${index}`,
      label: `part-${index}`,
      entityKind: 'msb-part',
      primitive: 'box',
      position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      sourceResourceUri: `sf://workspace/map/m10#part-${index}`,
      colorRgb: [0.5, 0.5, 0.5]
    })),
    bounds: {
      min,
      max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    },
    diagnostics: []
  };
}

describe('地图初始相机稳健聚焦', () => {
  it('只裁剪相机用离群点，不改变 draw list 或权威全量 bounds', () => {
    const cluster = Array.from({ length: 100 }, (_, index) => [index, index * 2, -index] as [number, number, number]);
    const list = drawListWithPositions([
      [-100_000, -100_000, -100_000],
      ...cluster,
      [100_000, 100_000, 100_000]
    ]);
    const originalItems = list.items;
    const originalBounds = structuredClone(list.bounds);

    const cameraBounds = computeRobustInitialCameraBounds(list);

    assert.deepEqual(cameraBounds.min, [0, 0, -99]);
    assert.deepEqual(cameraBounds.max, [99, 198, 0]);
    assert.strictEqual(list.items, originalItems);
    assert.deepEqual(list.bounds, originalBounds);
    assert.equal(list.itemCount, 102);
  });

  it('小场景不启用统计裁剪，保持精确 bounds', () => {
    const list = drawListWithPositions([[0, 0, 0], [10, 20, 30]]);
    assert.strictEqual(computeRobustInitialCameraBounds(list), list.bounds);
  });

  it('角色预览固定从原生 FLVER 正面取景', () => {
    assert.equal(FLVER_PREVIEW_FRAME_OPTIONS.azimuth, 0);
    assert.equal(FLVER_PREVIEW_FRAME_OPTIONS.elevation, 0.12);
    assert.equal(FLVER_PREVIEW_FRAME_OPTIONS.minDistance, 2.4);
  });
});

describe('地图 viewport 指针增量', () => {
  it('只使用 client 坐标并限制跨窗口跳变', () => {
    assert.deepEqual(
      computeStablePointerDelta({ x: 100, y: 80 }, { x: 132, y: 95 }),
      { x: 32, y: 15, moved: true }
    );
    assert.deepEqual(
      computeStablePointerDelta({ x: 100, y: 80 }, { x: 900, y: -500 }),
      { x: 150, y: -150, moved: true }
    );
  });

  it('非法坐标不会污染相机手势状态', () => {
    assert.deepEqual(
      computeStablePointerDelta({ x: Number.NaN, y: 20 }, { x: 30, y: Number.POSITIVE_INFINITY }),
      { x: 0, y: 0, moved: false }
    );
  });
});

describe('FLVER 原生骨骼索引投影', () => {
  it('按 native index 映射到 Three skeleton 顺序，而不是按数组位置猜测', () => {
    const indices = new Uint16Array([7, 9, 7, 99]);
    const weights = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    const mapped = remapSkinIndicesToRuntime(
      { skinIndices: indices, skinWeights: weights },
      new Map([[7, 2], [9, 0]])
    );
    assert.deepEqual([...mapped], [2, 0, 2, 0]);
  });

  it('正权重引用不存在的 native bone 时失败关闭', () => {
    assert.throws(
      () => remapSkinIndicesToRuntime(
        { skinIndices: new Uint16Array([99]), skinWeights: new Float32Array([1]) },
        new Map()
      ),
      /FLVER_RUNTIME_BONE_INDEX_UNRESOLVED/
    );
  });

  it('父索引按 native identity 校验，缺失父骨骼不静默挂到 root', () => {
    const result = validateFlverRuntimeSkeleton([
      {
        id: 'child', index: 9, name: 'child', parentIndex: 4,
        translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1]
      }
    ], 'sparse');
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'FLVER_RUNTIME_PARENT_INDEX_MISSING'));
  });

  it('拒绝重复 native index 和父链环', () => {
    const duplicate = validateFlverRuntimeSkeleton([
      { id: 'a', index: 4, name: 'a', parentIndex: -1, translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { id: 'b', index: 4, name: 'b', parentIndex: -1, translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
    ], 'duplicate');
    assert.ok(duplicate.diagnostics.some((diagnostic) => diagnostic.code === 'FLVER_RUNTIME_BONE_INDEX_DUPLICATE'));

    const cycle = validateFlverRuntimeSkeleton([
      { id: 'a', index: 4, name: 'a', parentIndex: 9, translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { id: 'b', index: 9, name: 'b', parentIndex: 4, translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
    ], 'cycle');
    assert.ok(cycle.diagnostics.some((diagnostic) => diagnostic.code === 'FLVER_RUNTIME_PARENT_CYCLE'));
  });

  it('follower 映射必须覆盖 source native index 且指向 leader native index', () => {
    const diagnostics = validateFlverRuntimeFollowerBinding(
      [{ id: 'source', index: 7, name: 'source', parentIndex: -1, translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
      [-1, -1, -1, -1, -1, -1, -1, 99],
      new Map([[4, 0]]),
      'follower'
    );
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'FLVER_FOLLOWER_LEADER_BONE_MISSING'));
  });
});

describe('FLVER 原生权重投影', () => {
  it('只在 renderer projection 中按 native 权重和归一化，不改原始输入', () => {
    const raw = new Float32Array([127 / 255, 64 / 255, 32 / 255, 0]);
    const normalized = normalizeSkinWeightsForThree(raw);
    const sum = normalized.reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(Math.abs(raw[0]! - 127 / 255) < 1e-7);
    assert.ok(Math.abs(normalized[0]! - (127 / 223)) < 1e-6);
    assert.ok(Math.abs(normalized[1]! - (64 / 223)) < 1e-6);
  });

  it('全零权重按成熟解码器规则回退到首个影响槽', () => {
    assert.deepEqual(
      [...normalizeSkinWeightsForThree(new Float32Array([0, 0, 0, 0]))],
      [1, 0, 0, 0]
    );
  });
});
