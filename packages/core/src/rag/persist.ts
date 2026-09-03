import type { RagChunk, RagCorpus, ReferenceEdge } from '@soulforge/shared';
import type { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import { createRagCorpus } from './chunkBuilder.js';

export interface RagChunkDelta {
  sourceUri: string;
  upserts: RagChunk[];
  deletedChunkIds: string[];
}

const PERSIST_BATCH_SIZE = 512;

/**
 * Compare two corpora by native source.  The desktop persistence path uses
 * this to send only changed rows instead of the complete workspace corpus.
 */
export function diffRagCorpusBySource(previous: RagCorpus | null | undefined, next: RagCorpus): RagChunkDelta[] {
  const oldChunks = previous?.chunks ?? [];
  const oldById = new Map(oldChunks.map((chunk) => [chunk.chunkId, chunk] as const));
  const nextById = new Map(next.chunks.map((chunk) => [chunk.chunkId, chunk] as const));
  const oldBySource = groupChunksBySource(oldChunks);
  const nextBySource = groupChunksBySource(next.chunks);
  const sourceUris = new Set([...oldBySource.keys(), ...nextBySource.keys()]);
  const deltas: RagChunkDelta[] = [];
  for (const sourceUri of sourceUris) {
    const oldForSource = oldBySource.get(sourceUri) ?? [];
    const nextForSource = nextBySource.get(sourceUri) ?? [];
    const deletedChunkIds = oldForSource
      .filter((chunk) => nextById.get(chunk.chunkId)?.sourceUri !== sourceUri)
      .map((chunk) => chunk.chunkId);
    const upserts = nextForSource.filter((chunk) => {
      const old = oldById.get(chunk.chunkId);
      return !old || JSON.stringify(old) !== JSON.stringify(chunk);
    });
    if (deletedChunkIds.length > 0 || upserts.length > 0) {
      deltas.push({ sourceUri, upserts, deletedChunkIds });
    }
  }
  return deltas;
}

function groupChunksBySource(chunks: readonly RagChunk[]): Map<string, RagChunk[]> {
  const grouped = new Map<string, RagChunk[]>();
  for (const chunk of chunks) {
    const bucket = grouped.get(chunk.sourceUri);
    if (bucket) bucket.push(chunk);
    else grouped.set(chunk.sourceUri, [chunk]);
  }
  return grouped;
}

export function persistRagCorpus(repository: WorkspaceDataRepository, corpus: RagCorpus): void {
  const previous = loadRagCorpus(repository, corpus.workspaceId);
  for (const delta of diffRagCorpusBySource(previous, corpus)) {
    for (let start = 0; start < delta.upserts.length; start += PERSIST_BATCH_SIZE) {
      repository.mergeRagChunkDelta({
        sourceUri: delta.sourceUri,
        upserts: delta.upserts.slice(start, start + PERSIST_BATCH_SIZE),
        deletedChunkIds: start === 0 ? delta.deletedChunkIds : []
      });
    }
    if (delta.upserts.length === 0 && delta.deletedChunkIds.length > 0) {
      repository.mergeRagChunkDelta({
        sourceUri: delta.sourceUri,
        upserts: [],
        deletedChunkIds: delta.deletedChunkIds
      });
    }
  }
  if (!sameRagReferences(previous.references, corpus.references)) {
    repository.replaceReferences(corpus.references);
  }
}

/** Reference rows are loaded from SQLite in a stable sort order, while the
 * in-memory WorkspaceIndex preserves discovery order.  Compare by content so
 * an unchanged graph does not trigger a full reference-table replacement on
 * every semantic refresh. */
export function sameRagReferences(
  left: readonly ReferenceEdge[],
  right: readonly ReferenceEdge[]
): boolean {
  if (left.length !== right.length) return false;
  const canonical = (edge: ReferenceEdge): string => JSON.stringify([
    edge.fromUri,
    edge.toUri,
    edge.kind,
    edge.confidence,
    edge.reason,
    edge.evidence
  ]);
  const leftKeys = left.map(canonical).sort();
  const rightKeys = right.map(canonical).sort();
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

export function loadRagCorpus(repository: WorkspaceDataRepository, workspaceId: string): RagCorpus {
  return createRagCorpus({
    workspaceId,
    builtAt: new Date().toISOString(),
    chunks: repository.loadRagChunks(),
    references: repository.loadReferences()
  });
}
