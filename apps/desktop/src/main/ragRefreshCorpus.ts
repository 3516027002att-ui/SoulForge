import {
  attachLookupIndexAsync,
  createRagCorpus,
  mergeCatalogAndPersisted,
  type RagChunk,
  type RagCorpus
} from '@soulforge/core';
import type { ReferenceEdge } from '@soulforge/shared';

export interface PostCommitRagCorpusInput {
  current: RagCorpus;
  changedCatalog: RagCorpus;
  changedSources: readonly string[];
  changedSymbols: readonly string[];
  references: readonly ReferenceEdge[];
  builtAt: string;
}

/**
 * Replace only the refreshed rows while retaining a deferred lookup index.
 * The old corpus can remain reachable until durable persistence publishes this
 * candidate; eagerly building another full index here doubles the peak maps.
 */
export function createPostCommitRagCorpus(input: PostCommitRagCorpusInput): RagCorpus {
  const sourceFilter = new Set(input.changedSources.filter((sourceUri) => sourceUri.trim().length > 0));
  const symbolFilter = new Set(input.changedSymbols.filter((symbolUri) => symbolUri.trim().length > 0));
  const chunks = [
    ...input.current.chunks.filter((chunk) => (
      !sourceFilter.has(chunk.sourceUri) && !symbolFilter.has(chunk.symbolUri)
    )),
    ...input.changedCatalog.chunks
  ];
  return createRagCorpus({
    workspaceId: input.current.workspaceId,
    builtAt: input.builtAt,
    chunks,
    references: input.references,
    diagnostics: input.changedCatalog.diagnostics,
    lookupIndex: 'deferred'
  });
}

export interface InvalidatedRagCorpusInput {
  current: RagCorpus;
  invalidatedSources: readonly string[];
  builtAt: string;
}

/**
 * Publish a stale-safe, deferred baseline immediately after a committed write
 * invalidates source semantics. A failed or slow refresh must not leave the
 * old source's chunks/references queryable as if they were current.
 */
export function createInvalidatedRagCorpus(input: InvalidatedRagCorpusInput): RagCorpus {
  const invalidatedSources = new Set(input.invalidatedSources.filter((sourceUri) => sourceUri.trim().length > 0));
  const chunks = input.current.chunks.filter((chunk) => !invalidatedSources.has(chunk.sourceUri));
  const removedSymbols = new Set(
    input.current.chunks
      .filter((chunk) => invalidatedSources.has(chunk.sourceUri))
      .map((chunk) => chunk.symbolUri)
  );
  for (const sourceUri of invalidatedSources) removedSymbols.add(sourceUri);
  const references = input.current.references.filter((edge) => (
    !removedSymbols.has(edge.fromUri) && !removedSymbols.has(edge.toUri)
  ));
  return createRagCorpus({
    workspaceId: input.current.workspaceId,
    builtAt: input.builtAt,
    chunks,
    references,
    diagnostics: input.current.diagnostics,
    lookupIndex: 'deferred'
  });
}

export interface PrepareAgentRagSearchCorpusInput {
  workspaceId: string;
  builtAt: string;
  activeRag: RagCorpus | null;
  persistedChunks: readonly RagChunk[];
  persistedReferences: readonly ReferenceEdge[];
  signal?: AbortSignal;
}

/**
 * Assemble the Agent search snapshot without eager intermediate indexes, then
 * prepare at most one complete lookup asynchronously before retrieval.
 */
export async function prepareAgentRagSearchCorpus(input: PrepareAgentRagSearchCorpusInput): Promise<RagCorpus> {
  const persisted = createRagCorpus({
    workspaceId: input.workspaceId,
    builtAt: input.builtAt,
    chunks: input.persistedChunks,
    references: input.persistedReferences,
    lookupIndex: 'deferred'
  });
  const corpus = input.activeRag
    ? mergeCatalogAndPersisted(input.activeRag, persisted, { lookupIndex: 'deferred' })
    : persisted;
  if (corpus.availability === 'available') {
    const target = input.activeRag && hasSameRagProjection(input.activeRag, corpus)
      ? input.activeRag
      : corpus;
    await attachLookupIndexAsync(target, { ...(input.signal ? { signal: input.signal } : {}) });
    return target;
  }
  return corpus;
}

function hasSameRagProjection(left: RagCorpus, right: RagCorpus): boolean {
  return left.workspaceId === right.workspaceId
    && left.builtAt === right.builtAt
    && sameObjectSequence(left.chunks, right.chunks)
    && sameObjectSequence(left.references, right.references);
}

function sameObjectSequence<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
