import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AuthoritativeAnimationClip,
  sampleAuthoritativePose
} from './animation-playback.js';

const sampleClip: AuthoritativeAnimationClip = {
  animId: 201000,
  animName: 'a000_201000.hkx',
  sourceFile: 'c0000_a000_hi.anibnd.dcx',
  duration: 1.0,
  frameCount: 31,
  frameDuration: 1 / 30,
  trackCount: 3,
  boneCount: 3,
  poses: Array.from({ length: 31 }, (_, frame) => [
    {
      p: [0, 1 + frame * 0.05, 0],
      q: [0, Math.sin(frame * 0.1), 0, Math.cos(frame * 0.1)],
      s: [1, 1, 1]
    },
    {
      p: [frame * 0.02, 0, 0],
      q: [0, 0, Math.sin(frame * 0.05), Math.cos(frame * 0.05)],
      s: [1, 1, 1]
    },
    {
      p: [0, 0, frame * 0.01],
      q: [0, 0, 0, 1],
      s: [1, 1, 1]
    }
  ])
};

test('sampleAuthoritativePose：在任意时间点确定性采样骨骼位姿', () => {
  const poseAt0_2 = sampleAuthoritativePose(sampleClip, 0.2);
  assert.ok(poseAt0_2 !== null);
  assert.equal(poseAt0_2.length, 3);

  // Frame 6 (0.2s * 30fps)
  assert.ok(Math.abs(poseAt0_2[0]!.p[1] - (1 + 6 * 0.05)) < 1e-5);
});

test('sampleAuthoritativePose：反向/多次 seek 产出 100% 绝对一致位姿（确定性 seek）', () => {
  const pose1 = sampleAuthoritativePose(sampleClip, 0.5);
  const pose2 = sampleAuthoritativePose(sampleClip, 0.8);
  const pose3 = sampleAuthoritativePose(sampleClip, 0.1);
  const poseReplay1 = sampleAuthoritativePose(sampleClip, 0.5);

  assert.deepEqual(pose1, poseReplay1);
  assert.notDeepEqual(pose1, pose2);
  assert.notDeepEqual(pose1, pose3);
});

test('sampleAuthoritativePose：正确处理循环与帧边界 clamping', () => {
  const loopPose = sampleAuthoritativePose(sampleClip, 1.2, true);
  assert.ok(loopPose !== null);

  const clampPose = sampleAuthoritativePose(sampleClip, 2.5, false);
  assert.ok(clampPose !== null);
  assert.ok(Math.abs(clampPose[0]!.p[1] - (1 + 30 * 0.05)) < 1e-5);
});
