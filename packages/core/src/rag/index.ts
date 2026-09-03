export { parseRagQuery } from './queryParse.js';
export { buildRagCorpus, createRagCorpus, mergeCatalogAndPersisted, emptyFamilyCounts } from './chunkBuilder.js';
export { retrieveEvidence } from './retrieve.js';
export { ensureLookupIndex } from './lookupIndex.js';
export { retrieveEvidenceHybrid, type HybridVectorSource } from './hybridRetrieve.js';
export {
  persistRagCorpus,
  loadRagCorpus,
  diffRagCorpusBySource,
  sameRagReferences,
  type RagChunkDelta
} from './persist.js';
export type { ParsedRagQuery } from './queryParse.js';
export type {
  RagChunk,
  RagChunkFamily,
  RagCorpus,
  RagHit,
  RagRetrieveOptions,
  RagRetrieveResult
} from '@soulforge/shared';
