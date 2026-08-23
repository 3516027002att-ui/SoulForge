import assert from 'node:assert/strict';
import {
  AnimationPlaybackClock,
  buildTaeTimelineTracks,
  TAE_INVALID_TIME_RANGE,
  type TaeTimelineEventRow
} from '@soulforge/shared';

export async function runAnimationPlaybackClockSmoke(): Promise<void> {
  console.log('[Smoke] Testing AnimationPlaybackClock...');

  const clock = new AnimationPlaybackClock({ fps: 30, duration: 2.0, loop: true, playbackRate: 1.0 });
  let latestState = clock.getState();

  const unsub = clock.subscribe((st) => {
    latestState = st;
  });

  assert.equal(latestState.isPlaying, false);
  assert.equal(latestState.currentTime, 0);
  assert.equal(latestState.currentFrame, 0);
  assert.equal(latestState.totalFrames, 60);

  // Play & tick
  clock.play();
  assert.equal(latestState.isPlaying, true);

  clock.tick(0.5); // +0.5s -> frame 15
  assert.ok(Math.abs(latestState.currentTime - 0.5) < 0.001);
  assert.equal(latestState.currentFrame, 15);

  // Step frame
  clock.stepFrame(5); // 15 + 5 = 20
  assert.equal(latestState.currentFrame, 20);
  assert.ok(Math.abs(latestState.currentTime - 20 / 30) < 0.001);

  // Loop around duration
  clock.tick(2.0); // wraps around 2.0s
  assert.ok(latestState.currentTime < 2.0);

  // Pause & Stop
  clock.pause();
  assert.equal(latestState.isPlaying, false);

  clock.stop();
  assert.equal(latestState.currentTime, 0);
  assert.equal(latestState.currentFrame, 0);

  unsub();

  console.log('[Smoke] Testing buildTaeTimelineTracks & TAE_INVALID_TIME_RANGE mapping...');
  const events: TaeTimelineEventRow[] = [
    {
      animId: 3013,
      eventTypeId: 1,
      startTime: 0.0,
      endTime: 0.5,
      parameterDecoded: true
    },
    {
      animId: 3013,
      eventTypeId: 2,
      startTime: 0.2, // overlaps with event 1
      endTime: 0.8,
      parameterDecoded: true
    },
    {
      animId: 3013,
      eventTypeId: 3,
      startTime: 1.0, // does not overlap with event 1
      endTime: 1.5,
      parameterDecoded: true
    },
    {
      animId: 3013,
      eventTypeId: 99,
      startTime: 2.0,
      endTime: 1.0, // Invalid: startTime > endTime
      parameterDecoded: false
    }
  ];

  const tracks = buildTaeTimelineTracks(events, [
    {
      code: TAE_INVALID_TIME_RANGE,
      message: 'Invalid time range',
      severity: 'warning'
    }
  ]);

  assert.ok(tracks.length >= 2, 'Should pack overlapping events into multiple tracks');

  // Check invalid block
  const invalidBlock = tracks.flatMap((t) => t.blocks).find((b) => b.eventTypeId === 99);
  assert.ok(invalidBlock, 'Invalid block must be present');
  assert.equal(invalidBlock?.hasError, true, 'hasError must be true for invalid block');
  assert.ok(invalidBlock?.errorMessage?.includes('起始时间大于结束时间'), 'ErrorMessage must explain inversion');

  // Check valid block
  const validBlock = tracks.flatMap((t) => t.blocks).find((b) => b.eventTypeId === 1);
  assert.ok(validBlock, 'Valid block must be present');
  assert.equal(validBlock?.hasError, false);
  assert.equal(validBlock?.startFrame, 0);
  assert.equal(validBlock?.endFrame, 15);

  console.log('[Smoke] Testing ActionContinuousSampler De Boor B-spline & Lerp/Slerp interpolation...');
  const {
    ActionContinuousSampler,
    evaluateBSpline,
    evaluateBSplineQuat,
    eulerXYZToQuaternion
  } = await import('@soulforge/shared');

  // Euler XYZ to Quaternion tests (Section 6)
  const qIdentity = eulerXYZToQuaternion([0, 0, 0]);
  assert.ok(Math.abs(qIdentity[0] - 0) < 1e-4);
  assert.ok(Math.abs(qIdentity[1] - 0) < 1e-4);
  assert.ok(Math.abs(qIdentity[2] - 0) < 1e-4);
  assert.ok(Math.abs(qIdentity[3] - 1) < 1e-4);

  const qRotX = eulerXYZToQuaternion([Math.PI / 2, 0, 0]);
  assert.ok(Math.abs(qRotX[0] - Math.SQRT1_2) < 1e-4);
  assert.ok(Math.abs(qRotX[3] - Math.SQRT1_2) < 1e-4);

  const qRotY = eulerXYZToQuaternion([0, Math.PI / 2, 0]);
  assert.ok(Math.abs(qRotY[1] - Math.SQRT1_2) < 1e-4);
  assert.ok(Math.abs(qRotY[3] - Math.SQRT1_2) < 1e-4);

  const qRotZ = eulerXYZToQuaternion([0, 0, Math.PI / 2]);
  assert.ok(Math.abs(qRotZ[2] - Math.SQRT1_2) < 1e-4);
  assert.ok(Math.abs(qRotZ[3] - Math.SQRT1_2) < 1e-4);

  // Composite Euler angle
  const qComp = eulerXYZToQuaternion([0.5, -0.3, 1.2]);
  const qCompLen = qComp[0] ** 2 + qComp[1] ** 2 + qComp[2] ** 2 + qComp[3] ** 2;
  assert.ok(Math.abs(qCompLen - 1.0) < 1e-4, 'Composite quaternion must be normalized');

  // De Boor evaluation
  const spline = {
    degree: 3,
    knots: [0, 0, 0, 0, 1, 1, 1, 1],
    controlPoints: [0, 10, 20, 30]
  };
  assert.ok(Math.abs(evaluateBSpline(spline, 0) - 0) < 1e-4);
  assert.ok(Math.abs(evaluateBSpline(spline, 1) - 30) < 1e-4);

  // Quat evaluation
  const quatSpline = {
    degree: 1,
    knots: [0, 0, 1, 1],
    controlPoints: [
      [0, 0, 0, 1] as [number, number, number, number],
      [0, 1, 0, 0] as [number, number, number, number]
    ]
  };
  const qMid = evaluateBSplineQuat(quatSpline, 0.5);
  const qLen = qMid[0] * qMid[0] + qMid[1] * qMid[1] + qMid[2] * qMid[2] + qMid[3] * qMid[3];
  assert.ok(Math.abs(qLen - 1.0) < 1e-4);

  // Continuous Sampler & Remapping
  const nonUnitRefQuat = eulerXYZToQuaternion([0, Math.PI / 4, 0]);
  const sampler = new ActionContinuousSampler({
    animId: 3013,
    motionAnimId: 3013,
    animationType: 'Interleaved',
    duration: 2.0,
    frameCount: 2,
    frameDuration: 2.0,
    transformTrackCount: 1,
    hkxBoneCount: 2,
    hkxBoneNames: ['HkxRoot', 'HkxSpine'],
    hkxReferencePose: [
      { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
    ],
    trackToHkxBone: [1],
    hkxToFlverBoneMap: [1, 0],
    interleavedTransforms: [
      { translation: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { translation: [0, 6, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
    ]
  });

  const sampledFlver = sampler.sampleFlverPose(1.0, 3, [
    { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    { translation: [0, 0, 9], rotation: nonUnitRefQuat, scale: [1, 1, 1] }
  ]);

  // FLVER 0 from HKX 1: mid-point between 2 and 6 -> [0, 4, 0]
  assert.deepEqual(sampledFlver[0]?.translation, [0, 4, 0]);
  // FLVER 1 from HKX 0: ref pose [0, 0, 0]
  assert.deepEqual(sampledFlver[1]?.translation, [0, 0, 0]);
  // FLVER 2 unmapped: preserves non-unit reference rotation
  assert.deepEqual(sampledFlver[2]?.translation, [0, 0, 9]);
  assert.deepEqual(sampledFlver[2]?.rotation, nonUnitRefQuat);

  console.log('[Smoke] AnimationPlaybackClock, Timeline Tracks & ActionContinuousSampler Smoke PASSED.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runAnimationPlaybackClockSmoke.js')) {
  runAnimationPlaybackClockSmoke().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
