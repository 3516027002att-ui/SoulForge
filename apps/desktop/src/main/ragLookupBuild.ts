import { randomUUID } from 'node:crypto';
import { attachLookupIndexAsync, type RagCorpus, type BackgroundJobRecord } from '@soulforge/core';

type Job = Omit<BackgroundJobRecord, 'workspaceId'>;
interface JobStore { upsertJob(job: Job): Promise<void>; }

/** Reuse the existing background-job surface; no new renderer IPC is needed. */
export async function prepareWorkspaceRagLookup(store: JobStore, corpus: RagCorpus, signal?: AbortSignal): Promise<void> {
  const startedAt = new Date().toISOString();
  const total = corpus.chunks.length + corpus.references.length;
  const base = { jobId: `rag-index:${randomUUID()}`, title: '构建检索索引', jobKind: 'workspace_rag_index',
    payload: { chunks: corpus.chunks.length, references: corpus.references.length }, createdAt: startedAt, startedAt };
  let current = 0, lastWritten = 0;
  let writes = Promise.resolve();
  let writeFailure: unknown;
  let terminal: 'completed' | 'failed' | 'cancelled' | null = null;
  await store.upsertJob({ ...base, status: 'running', progress: { current, total }, updatedAt: startedAt });
  try {
    await attachLookupIndexAsync(corpus, {
      ...(signal ? { signal } : {}),
      onProgress: (value) => {
        current = value.completed;
        if (Date.now() - lastWritten < 250 || writeFailure) return;
        lastWritten = Date.now();
        const job: Job = { ...base, status: 'running', progress: { current, total }, updatedAt: new Date().toISOString() };
        writes = writes.then(() => store.upsertJob(job)).catch((error: unknown) => { writeFailure = error; });
      }
    });
    await writes;
    if (writeFailure) throw writeFailure;
    throwIfLookupAborted(signal);
    const completedAt = new Date().toISOString();
    await store.upsertJob({ ...base, status: 'completed', progress: { current: total, total }, updatedAt: completedAt, completedAt });
    terminal = 'completed';
  } catch (error) {
    await writes;
    if (terminal === 'completed') return;
    const completedAt = new Date().toISOString();
    const status = signal?.aborted ? 'cancelled' : 'failed';
    try {
      await store.upsertJob({ ...base, status, progress: { current, total },
        error: { message: error instanceof Error ? error.message : String(error) }, updatedAt: completedAt, completedAt });
      terminal = status;
    } catch {
      // Preserve the build/cancellation error. A database close during
      // workspace switching must never mask the original failure.
    }
    throw error;
  }
}

function throwIfLookupAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('RAG lookup build cancelled.');
  error.name = 'AbortError';
  throw error;
}
