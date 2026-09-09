import type { RagCorpus } from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import {
  createRagChunkExclusionMask,
  type RagChunkExclusionMask
} from './retrieve.js';

interface FreshnessMask {
  epoch: number;
  mask: RagChunkExclusionMask | undefined;
}

// A native refresh can leave a durable corpus containing both the old and the
// newly read rows for one physical source.  Keep the expensive provenance
// comparison at the host boundary and reuse it for every retrieval in the
// same (index, corpus, native epoch) snapshot.
const masksByIndex = new WeakMap<WorkspaceIndex, WeakMap<RagCorpus, FreshnessMask>>();

export function getRagStaleChunkIdsCached(
  index: WorkspaceIndex,
  corpus: RagCorpus
): readonly string[] {
  return getRagStaleChunkMaskCached(index, corpus)?.ids ?? [];
}

export function getRagStaleChunkMaskCached(
  index: WorkspaceIndex,
  corpus: RagCorpus
): RagChunkExclusionMask | undefined {
  const epoch = index.getNativeVersionEpoch();
  let byCorpus = masksByIndex.get(index);
  if (!byCorpus) {
    byCorpus = new WeakMap<RagCorpus, FreshnessMask>();
    masksByIndex.set(index, byCorpus);
  }
  const cached = byCorpus.get(corpus);
  if (cached?.epoch === epoch) return cached.mask;
  const chunkIds = index.getRagStaleChunkIds(corpus.chunks);
  const mask = chunkIds.length > 0 ? createRagChunkExclusionMask(chunkIds) : undefined;
  byCorpus.set(corpus, { epoch, mask });
  return mask;
}
