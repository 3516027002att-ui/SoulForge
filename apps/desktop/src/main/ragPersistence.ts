import type { RagChunk, RagCorpus, ReferenceEdge } from '@soulforge/shared';
import { diffRagCorpusBySource, sameRagReferences } from '@soulforge/core';
import {
  measureSemanticRefreshStage,
  measureSemanticRefreshStageSync,
  type SemanticRefreshTelemetry
} from './semanticRefreshTelemetry.js';

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
  signal?: AbortSignal,
  telemetry?: SemanticRefreshTelemetry
): Promise<void> {
  const deltas = telemetry
    ? measureSemanticRefreshStageSync(telemetry, 'diff', () => diffRagCorpusBySource(previous, corpus), (value) => ({
        changedSourceCountInDiff: value.length,
        upsertChunks: value.reduce((sum, delta) => sum + delta.upserts.length, 0),
        deletedChunks: value.reduce((sum, delta) => sum + delta.deletedChunkIds.length, 0)
      }))
    : diffRagCorpusBySource(previous, corpus);
  for (const delta of deltas) {
    throwIfAborted(signal);
    for (let dStart = 0; dStart < delta.deletedChunkIds.length; dStart += RAG_PERSIST_BATCH_SIZE) {
      throwIfAborted(signal);
      const deletedChunkIds = delta.deletedChunkIds.slice(dStart, dStart + RAG_PERSIST_BATCH_SIZE);
      const persist = () => store.mergeRagChunkDelta({
        sourceUri: delta.sourceUri,
        upserts: [],
        deletedChunkIds
      });
      if (telemetry) {
        await measureSemanticRefreshStage(telemetry, 'persistBatch', persist, () => ({
          batchCount: 1,
          deletedChunks: deletedChunkIds.length
        }));
      } else {
        await persist();
      }
    }
    for (let start = 0; start < delta.upserts.length; start += RAG_PERSIST_BATCH_SIZE) {
      throwIfAborted(signal);
      const upserts = delta.upserts.slice(start, start + RAG_PERSIST_BATCH_SIZE);
      const persist = () => store.mergeRagChunkDelta({
        sourceUri: delta.sourceUri,
        upserts,
        deletedChunkIds: []
      });
      if (telemetry) {
        await measureSemanticRefreshStage(telemetry, 'persistBatch', persist, () => ({
          batchCount: 1,
          upsertChunks: upserts.length
        }));
      } else {
        await persist();
      }
    }
  }
  throwIfAborted(signal);
  if (previous === null || !sameRagReferences(previous.references, corpus.references)) {
    const persistReferences = () => store.replaceReferences(corpus.references);
    if (telemetry) {
      await measureSemanticRefreshStage(telemetry, 'persistBatch', persistReferences, () => ({
        batchCount: 1,
        referenceCount: corpus.references.length
      }));
    } else {
      await persistReferences();
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('RAG 语义持久化已被更新任务取消。');
  error.name = 'AbortError';
  throw error;
}
