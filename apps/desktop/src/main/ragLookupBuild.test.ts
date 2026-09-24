import assert from 'node:assert/strict';
import { createRagCorpus, type BackgroundJobRecord, type RagChunk } from '@soulforge/core';
// @ts-ignore Focused runner uses Node TypeScript stripping.
import { prepareWorkspaceRagLookup } from './ragLookupBuild.ts';

const chunks: RagChunk[] = Array.from({ length: 1024 }, (_, i) => ({
  workspaceId: 'progress', chunkId: `c${i}`, sourceUri: 'param://table', symbolUri: `param://table#${i}`,
  family: 'param_row', title: `行 ${i}`, body: 'test progress', numericIds: [i], contentHash: `h${i}`
}));
const make = () => createRagCorpus({ workspaceId: 'progress', builtAt: 'test', chunks, lookupIndex: 'deferred' });
const jobs: Array<Omit<BackgroundJobRecord, 'workspaceId'>> = [];
const store = { upsertJob: async (job: Omit<BackgroundJobRecord, 'workspaceId'>) => { jobs.push(job); } };
await prepareWorkspaceRagLookup(store, make());
assert.equal(jobs[0]?.status, 'running');
assert.equal(jobs.at(-1)?.status, 'completed');
assert.equal(jobs.at(-1)?.progress.current, 1024);
assert.equal(new Set(jobs.map(x => x.jobId)).size, 1);

const progressController = new AbortController();
const progressJobs: Array<Omit<BackgroundJobRecord, 'workspaceId'>> = [];
const progressStore = {
  upsertJob: async (job: Omit<BackgroundJobRecord, 'workspaceId'>) => {
    progressJobs.push(job);
    if (progressJobs.length > 1 && job.status === 'running') progressController.abort();
  }
};
await assert.rejects(
  prepareWorkspaceRagLookup(progressStore, make(), progressController.signal),
  { name: 'AbortError' }
);
assert.equal(progressJobs.some((job) => job.status === 'completed'), false);
assert.equal(progressJobs.at(-1)?.status, 'cancelled');
assert.ok(progressJobs.at(-1)?.error);

const completionController = new AbortController();
const completionJobs: Array<Omit<BackgroundJobRecord, 'workspaceId'>> = [];
let completionAbortTriggered = false;
const completionStore = {
  upsertJob: async (job: Omit<BackgroundJobRecord, 'workspaceId'>) => {
    completionJobs.push(job);
    if (job.status === 'completed' && !completionAbortTriggered) {
      completionAbortTriggered = true;
      completionController.abort();
    }
  }
};
await prepareWorkspaceRagLookup(completionStore, make(), completionController.signal);
assert.equal(completionJobs.filter((job) => job.status === 'completed').length, 1);
assert.equal(completionJobs.at(-1)?.status, 'completed');
assert.equal(completionJobs.at(-1)?.error, undefined);

const failureController = new AbortController();
const originalFailure = new Error('synthetic lookup failure');
const failureJobs: Array<Omit<BackgroundJobRecord, 'workspaceId'>> = [];
const failureStore = {
  upsertJob: async (job: Omit<BackgroundJobRecord, 'workspaceId'>) => {
    failureJobs.push(job);
    if (job.status === 'running' && failureJobs.length > 1) throw originalFailure;
    if (job.status === 'failed') throw new Error('synthetic terminal write failure');
  }
};
await assert.rejects(
  prepareWorkspaceRagLookup(failureStore, make(), failureController.signal),
  error => error === originalFailure
);
assert.equal(failureJobs.at(-1)?.status, 'failed');

console.log('ragLookupBuild: PASS (progress, completion, cancellation)');
