import type { RagChunk, RagCorpus, ReferenceEdge } from '@soulforge/shared';
import { diffRagCorpusBySource, sameRagReferences } from '@soulforge/core';

const RAG_PERSIST_BATCH_SIZE = 512;

interface RagDeltaStore {
  mergeRagChunkDelta(input: {
    sourceUri: string;
    upserts: RagChunk[];
    deletedChunkIds: string[];
  }): Promise<void>;
  replaceReferences(references: ReferenceEdge[]): Promise<void>;
}

/**
 * Persist only changed native sources in bounded requests.  Cancellation is
 * checked between requests, so the database utility never receives an
 * unbounded workspace-wide synchronous transaction.
 */
export async function persistRagCorpusBySourceDelta(
  store: RagDeltaStore,
  corpus: RagCorpus,
  previous: RagCorpus | null = null,
  signal?: AbortSignal
): Promise<void> {
  const deltas = diffRagCorpusBySource(previous, corpus);
  for (const delta of deltas) {
    throwIfAborted(signal);
    for (let start = 0; start < delta.upserts.length; start += RAG_PERSIST_BATCH_SIZE) {
      throwIfAborted(signal);
      await store.mergeRagChunkDelta({
        sourceUri: delta.sourceUri,
        upserts: delta.upserts.slice(start, start + RAG_PERSIST_BATCH_SIZE),
        deletedChunkIds: start === 0 ? delta.deletedChunkIds : []
      });
    }
    if (delta.upserts.length === 0 && delta.deletedChunkIds.length > 0) {
      await store.mergeRagChunkDelta({
        sourceUri: delta.sourceUri,
        upserts: [],
        deletedChunkIds: delta.deletedChunkIds
      });
    }
  }
  throwIfAborted(signal);
  if (previous === null || !sameRagReferences(previous.references, corpus.references)) {
    await store.replaceReferences(corpus.references);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('RAG 语义持久化已被更新任务取消。');
  error.name = 'AbortError';
  throw error;
}
