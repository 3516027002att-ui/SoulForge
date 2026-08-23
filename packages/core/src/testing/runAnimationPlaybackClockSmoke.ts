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

  console.log('[Smoke] AnimationPlaybackClock & Timeline Tracks Smoke PASSED.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runAnimationPlaybackClockSmoke.js')) {
  runAnimationPlaybackClockSmoke().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
