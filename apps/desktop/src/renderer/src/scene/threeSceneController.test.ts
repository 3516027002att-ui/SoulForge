import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SceneDrawList } from './sceneManifestBrowser.js';
import { computeRobustInitialCameraBounds } from './threeSceneController.js';

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
});
