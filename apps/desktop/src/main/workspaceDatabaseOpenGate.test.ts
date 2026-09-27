import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore Focused runner executes this source with Node TypeScript stripping.
import { WorkspaceDatabaseOpenGate } from './workspaceDatabaseOpenGate.ts';

test('coalesces concurrent opens for one workspace and serializes workspace switches', async () => {
  const gate = new WorkspaceDatabaseOpenGate();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = gate.run('workspace-a', async () => {
    events.push('a:start');
    await firstBarrier;
    events.push('a:end');
    return 'a';
  });
  const duplicate = gate.run('workspace-a', async () => {
    events.push('a:duplicate');
    return 'wrong';
  });
  const switched = gate.run('workspace-b', async () => {
    events.push('b:start');
    return 'b';
  });

  await Promise.resolve();
  assert.deepEqual(events, ['a:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, duplicate, switched]), ['a', 'a', 'b']);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start']);
});

test('releases the database open gate after a failed open so the same workspace can retry', async () => {
  const gate = new WorkspaceDatabaseOpenGate();
  let attempts = 0;
  await assert.rejects(gate.run('workspace-a', async () => {
    attempts += 1;
    throw new Error('open failed');
  }), /open failed/u);
  assert.equal(await gate.run('workspace-a', async () => {
    attempts += 1;
    return 'reopened';
  }), 'reopened');
  assert.equal(attempts, 2);
});

test('does not hand a stale session open failure to a replacement session for the same workspace', async () => {
  const gate = new WorkspaceDatabaseOpenGate();
  const oldOwner = {};
  const replacementOwner = {};
  const staleSessionError = Object.assign(new Error('old workspace session is stale'), {
    code: 'DATABASE_UTILITY_SESSION_STALE'
  });
  let releaseOldOpen!: () => void;
  let markOldOpenEntered!: () => void;
  const oldOpenBarrier = new Promise<void>((resolve) => { releaseOldOpen = resolve; });
  const oldOpenEntered = new Promise<void>((resolve) => { markOldOpenEntered = resolve; });
  let replacementOpenCount = 0;

  const oldSessionOpen = gate.run('workspace-a', async () => {
    markOldOpenEntered();
    await oldOpenBarrier;
    throw staleSessionError;
  }, oldOwner);
  await oldOpenEntered;
  const replacementSessionOpen = gate.run('workspace-a', async () => {
    replacementOpenCount += 1;
    return 'replacement-opened';
  }, replacementOwner);

  releaseOldOpen();
  await assert.rejects(oldSessionOpen, (error) => error === staleSessionError);
  assert.equal(await replacementSessionOpen, 'replacement-opened');
  assert.equal(replacementOpenCount, 1);
});
