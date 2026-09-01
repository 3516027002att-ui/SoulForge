import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionContinuousSampler,
  evaluateBSpline,
  evaluateBSplineQuat,
  type TaeAnimationClipData
} from '@soulforge/shared';

describe('ACTION Continuous Sampler & De Boor Spline Tests', () => {
  it('De Boor 样条插值在给定单节点控制点时精确返回控制点', () => {
    const curve = {
      degree: 0,
      knots: [0, 1],
      controlPoints: [10.5]
    };
    const val = evaluateBSpline(curve, 0.5);
    assert.equal(val, 10.5);
  });

  it('De Boor 样条插值在两端及中间位置连续平滑插值', () => {
    // 3次样条，4个控制点：0, 10, 20, 30
    const curve = {
      degree: 3,
      knots: [0, 0, 0, 0, 1, 1, 1, 1],
      controlPoints: [0, 10, 20, 30]
    };
    const val0 = evaluateBSpline(curve, 0.0);
    const valMid = evaluateBSpline(curve, 0.5);
    const val1 = evaluateBSpline(curve, 1.0);

    assert.ok(Math.abs(val0 - 0) < 1e-4);
    assert.ok(Math.abs(val1 - 30) < 1e-4);
    assert.ok(valMid > 5 && valMid < 25);
  });

  it('四元数样条插值正确保持单位化四元数', () => {
    const curve = {
      degree: 1,
      knots: [0, 0, 1, 1],
      controlPoints: [
        [0, 0, 0, 1] as [number, number, number, number],
        [0, 1, 0, 0] as [number, number, number, number]
      ]
    };
    const mid = evaluateBSplineQuat(curve, 0.5);
    const lenSq = mid[0] * mid[0] + mid[1] * mid[1] + mid[2] * mid[2] + mid[3] * mid[3];
    assert.ok(Math.abs(lenSq - 1.0) < 1e-4);
    assert.ok(mid[1] > 0.5);
    assert.ok(mid[3] > 0.5);
  });

  it('Interleaved 关键帧连续采样在帧间精确线性与球形插值', () => {
    const clip: TaeAnimationClipData = {
      animId: 100,
      motionAnimId: 100,
      animationType: 'Interleaved',
      duration: 1.0,
      frameCount: 2,
      frameDuration: 1.0,
      transformTrackCount: 1,
      hkxBoneCount: 2,
      hkxBoneNames: ['Root', 'Spine'],
      hkxParentIndices: [-1, 0],
      hkxReferencePose: [
        { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
      ],
      trackToHkxBone: [1], // track 0 drives HKX bone 1 (Spine)
      hkxToFlverBoneMap: [0, 1],
      interleavedTransforms: [
        // Frame 0: Spine at [0, 1, 0]
        { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        // Frame 1: Spine at [0, 3, 0]
        { translation: [0, 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
      ]
    };

    const sampler = new ActionContinuousSampler(clip);
    const poseAtMid = sampler.sampleHkxPose(0.5, false);

    // Root (unanimated) retains reference pose
    assert.deepEqual(poseAtMid[0]?.translation, [0, 0, 0]);

    // Spine (animated track 0) is interpolated to [0, 2, 0]
    assert.ok(poseAtMid[1]);
    assert.ok(Math.abs(poseAtMid[1].translation[0] - 0) < 1e-4);
    assert.ok(Math.abs(poseAtMid[1].translation[1] - 2.0) < 1e-4);
    assert.ok(Math.abs(poseAtMid[1].translation[2] - 0) < 1e-4);
  });

  it('sampleFlverPose 应用 HKX 动画差分并保留 FLVER 绑定姿态', () => {
    const clip: TaeAnimationClipData = {
      animId: 200,
      motionAnimId: 200,
      animationType: 'Interleaved',
      duration: 1.0,
      frameCount: 2,
      frameDuration: 0.5,
      transformTrackCount: 1,
      hkxBoneCount: 2,
      hkxBoneNames: ['HkxRoot', 'HkxArm'],
      hkxParentIndices: [-1, 0],
      hkxReferencePose: [
        { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
      ],
      trackToHkxBone: [1], // drives HkxArm (HKX bone 1)
      hkxToFlverBoneMap: [1, 0], // HkxRoot -> FLVER bone 1, HkxArm -> FLVER bone 0
      interleavedTransforms: [
        // The clip starts at the HKX reference pose and then moves the arm.
        { translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { translation: [9, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 1, 1] }
      ]
    };

    const sampler = new ActionContinuousSampler(clip);
    const flverRefPose = [
      { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
      { translation: [0, 2, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
      { translation: [0, 0, 3] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } // FLVER bone 2 unmapped
    ];

    const flverPoseAtStart = sampler.sampleFlverPose(0, 3, flverRefPose, false);

    // At frame 0, mapped bones retain the actual FLVER bind pose even though
    // the HKX skeleton uses a different local translation for the arm.
    assert.deepEqual(flverPoseAtStart[0]?.translation, [0, 0, 0]);

    // The root is mapped too, but its FLVER bind translation is preserved.
    assert.deepEqual(flverPoseAtStart[1]?.translation, [0, 2, 0]);

    const flverPoseAtMid = sampler.sampleFlverPose(0.25, 3, flverRefPose, false);

    // HKX arm is halfway from 5 to 9; only the +2 animation delta is applied
    // to the FLVER arm bind translation [0, 0, 0].
    assert.deepEqual(flverPoseAtMid[0]?.translation, [2, 0, 0]);
    assert.deepEqual(flverPoseAtMid[0]?.scale, [1.5, 1, 1]);
    const expectedHalfTurnZ = Math.sin(Math.PI / 8);
    const expectedHalfTurnW = Math.cos(Math.PI / 8);
    assert.ok(Math.abs((flverPoseAtMid[0]?.rotation[2] ?? 0) - expectedHalfTurnZ) < 1e-6);
    assert.ok(Math.abs((flverPoseAtMid[0]?.rotation[3] ?? 0) - expectedHalfTurnW) < 1e-6);

    // FLVER bone 2 unmapped in HKX, retains FLVER reference pose [0, 0, 3]
    assert.deepEqual(flverPoseAtMid[2]?.translation, [0, 0, 3]);
  });
});
