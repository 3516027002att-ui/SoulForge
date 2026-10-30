import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore Focused runner executes this source with Node TypeScript stripping.
import { createSemanticRefreshTelemetry } from './semanticRefreshTelemetry.ts';

type Complete = {
  stage: string;
  heapUsedMb: number;
  rssMb: number;
  heapDeltaMb: number;
  rssDeltaMb: number;
};

const create = createSemanticRefreshTelemetry as unknown as (
  origin: 'postcommit' | 'deferred',
  sink: (snapshot: unknown) => void,
  stageStartSink: (start: unknown) => void,
  stageCompleteSink: (complete: Complete) => void
) => ReturnType<typeof createSemanticRefreshTelemetry>;

test('stage deltas are relative to the previous completed stage (#27)', () => {
  const completes: Complete[] = [];
  const telemetry = create('postcommit', () => {}, () => {}, (complete) => completes.push(complete));

  telemetry.begin('scan');
  telemetry.complete('scan');
  telemetry.begin('analyze');
  telemetry.complete('analyze');
  telemetry.begin('ragBuild');
  telemetry.complete('ragBuild');

  assert.equal(completes.length, 3);
  // 第一个阶段没有前一个，增量为 0
  assert.equal(completes[0]!.heapDeltaMb, 0);
  assert.equal(completes[0]!.rssDeltaMb, 0);
  // 后续阶段的增量 = 本次绝对值 - 上一次绝对值
  for (let index = 1; index < completes.length; index += 1) {
    const previous = completes[index - 1]!;
    const current = completes[index]!;
    assert.equal(
      current.heapDeltaMb,
      Number((current.heapUsedMb - previous.heapUsedMb).toFixed(1)),
      `${current.stage} heapDelta must equal difference from ${previous.stage}`
    );
    assert.equal(
      current.rssDeltaMb,
      Number((current.rssMb - previous.rssMb).toFixed(1)),
      `${current.stage} rssDelta must equal difference from ${previous.stage}`
    );
  }
});

test('delta keeps sign when heap shrinks between stages', () => {
  const completes: Complete[] = [];
  const telemetry = create('deferred', () => {}, () => {}, (complete) => completes.push(complete));

  telemetry.begin('scan');
  telemetry.complete('scan');
  telemetry.begin('publish');
  telemetry.complete('publish');

  const [first, second] = completes;
  assert.ok(first && second);
  // 增量可以为负：收缩也是信息，不能被夹成 0
  assert.equal(second.heapDeltaMb, Number((second.heapUsedMb - first.heapUsedMb).toFixed(1)));
});
