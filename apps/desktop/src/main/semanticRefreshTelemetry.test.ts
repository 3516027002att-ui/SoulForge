import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore Focused runner executes this source with Node TypeScript stripping.
import { createSemanticRefreshTelemetry, measureSemanticRefreshStage } from './semanticRefreshTelemetry.ts';

type StageComplete = { stage: string; outcome: string; elapsedMs: number };
const createTelemetryWithCompletionSink = createSemanticRefreshTelemetry as unknown as (
  origin: 'postcommit',
  sink: (snapshot: unknown) => void,
  stageStartSink: (start: unknown) => void,
  stageCompleteSink: (complete: StageComplete) => void
) => ReturnType<typeof createSemanticRefreshTelemetry>;

test('semantic refresh emits one bounded stage-start receipt before work begins', async () => {
  const starts: Array<{ stage: string; heapUsedMb: number; heapLimitMb: number; rssMb: number }> = [];
  const finishes: unknown[] = [];
  const telemetry = createSemanticRefreshTelemetry(
    'postcommit',
    (snapshot) => finishes.push(snapshot),
    (start) => starts.push(start)
  );

  const value = await measureSemanticRefreshStage(telemetry, 'analyze', async () => {
    assert.equal(starts.length, 1, 'stage-start evidence must be available while the operation is in flight');
    await Promise.resolve();
    return { fileCount: 1 };
  }, (result) => ({ fileCount: result.fileCount }));
  telemetry.finish('completed');

  assert.deepEqual(value, { fileCount: 1 });
  assert.equal(starts.length, 1, 'repeated stage batches keep one bounded start receipt');
  assert.equal(starts[0]?.stage, 'analyze');
  assert.ok(Number.isFinite(starts[0]?.heapUsedMb));
  assert.ok(starts[0]!.heapLimitMb > 0);
  assert.ok(starts[0]!.rssMb > 0);
  assert.equal(finishes.length, 1);
});

test('semantic refresh emits stage completion before the final refresh snapshot', async () => {
  const completions: StageComplete[] = [];
  let finalSnapshotWritten = false;
  const telemetry = createTelemetryWithCompletionSink(
    'postcommit',
    () => { finalSnapshotWritten = true; },
    () => {},
    (complete) => completions.push(complete)
  );

  await measureSemanticRefreshStage(telemetry, 'nativeDecode', async () => ({ sourceCount: 1 }), (value) => value);

  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.stage, 'nativeDecode');
  assert.equal(completions[0]?.outcome, 'completed');
  assert.ok(completions[0]!.elapsedMs >= 0);
  assert.equal(finalSnapshotWritten, false, 'stage evidence must exist even if a later stage fails');
  telemetry.finish('completed');
  assert.equal(finalSnapshotWritten, true);
});

test('semantic refresh marks a rejected stage as failed immediately', async () => {
  const completions: StageComplete[] = [];
  const telemetry = createTelemetryWithCompletionSink(
    'postcommit',
    () => {},
    () => {},
    (complete) => completions.push(complete)
  );

  await assert.rejects(measureSemanticRefreshStage(telemetry, 'nativeDecode', async () => {
    throw new Error('native decode failed');
  }));

  assert.equal(completions.at(-1)?.outcome, 'failed');
});
