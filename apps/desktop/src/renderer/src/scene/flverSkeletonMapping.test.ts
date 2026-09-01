import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  flverEulerXzyToQuaternion,
  mapFollowerSkeleton,
  retargetHkxPoseToFlver
} from './flverSkeletonMapping.js';
import type { FlverRetargetBone, LocalBoneTransform } from './flverSkeletonMapping.js';

describe('FLVER skeleton mapping', () => {
  it('uses hierarchy identity for duplicate bone names', () => {
    const leader = [
      { name: 'Root', parentIndex: -1 },
      { name: 'Left', parentIndex: 0 },
      { name: 'Ctrl', parentIndex: 1 },
      { name: 'Right', parentIndex: 0 },
      { name: 'Ctrl', parentIndex: 3 }
    ];
    const follower = [
      { name: 'Root', parentIndex: -1 },
      { name: 'Right', parentIndex: 0 },
      { name: 'Ctrl', parentIndex: 1 }
    ];
    assert.deepEqual(mapFollowerSkeleton(leader, follower), [0, 3, 4]);
  });

  it('does not guess when same-name mapping stays ambiguous', () => {
    const leader = [
      { name: 'Root', parentIndex: -1 },
      { name: 'Ctrl', parentIndex: 0 },
      { name: 'Ctrl', parentIndex: 0 }
    ];
    const follower = [{ name: 'Ctrl', parentIndex: -1 }];
    assert.deepEqual(mapFollowerSkeleton(leader, follower), [-1]);
  });

  it('composes native FLVER Euler rotations for Three.js column vectors', () => {
    const actual = flverEulerXzyToQuaternion([0.5, -0.3, 1.2]);
    const expected = [
      0.1201424763,
      0.0186237853,
      0.5714598517,
      0.8115741358
    ];
    for (let index = 0; index < 4; index += 1) {
      assert.ok(Math.abs(actual[index]! - expected[index]!) < 1e-4);
    }
  });

  it('retargets animation deltas while preserving a follower bind pose', () => {
    const hkxBones = [
      { name: 'Root', parentIndex: -1 },
      { name: 'Right', parentIndex: 0 },
      { name: 'Ctrl', parentIndex: 1 }
    ];
    const reference: LocalBoneTransform[] = [
      { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { translation: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
    ];
    const animated: LocalBoneTransform[] = [
      reference[0]!,
      reference[1]!,
      { translation: [3, 4, 5], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 1, 0.5] }
    ];
    const follower: FlverRetargetBone[] = [
      { name: 'Root', parentIndex: -1, translation: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { name: 'Right', parentIndex: 0, translation: [0, 10, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { name: 'Ctrl', parentIndex: 1, translation: [0, 20, 0], rotation: [Math.PI / 2, 0, 0], scale: [3, 4, 5] }
    ];
    const pose = retargetHkxPoseToFlver(hkxBones, reference, animated, follower);
    assert.deepEqual(pose[2]?.translation, [3, 22, 5]);
    assert.deepEqual(pose[2]?.scale, [6, 4, 2.5]);
    const rot = pose[2]?.rotation ?? [0, 0, 0, 0];
    const expectedRot = [0.5, -0.5, 0.5, 0.5];
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(rot[i]! - expectedRot[i]!) < 1e-12);
  });
});
