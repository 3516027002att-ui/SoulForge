import type { RagCorpus } from '@soulforge/shared';
import type { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import { createRagCorpus } from './chunkBuilder.js';

export function persistRagCorpus(repository: WorkspaceDataRepository, corpus: RagCorpus): void {
  repository.replaceRagChunks(corpus.chunks, corpus.coverage?.sourceRevision);
  repository.replaceReferences(corpus.references);
  if (!corpus.coverage) throw new Error('RAG corpus persistence requires coverage metadata.');
  repository.replaceRagCorpusMetadata({ builtAt: corpus.builtAt, coverage: corpus.coverage });
}

export function loadRagCorpus(repository: WorkspaceDataRepository, workspaceId: string): RagCorpus {
  const metadata = repository.loadRagCorpusMetadata();
  return createRagCorpus({
    workspaceId,
    builtAt: metadata?.builtAt ?? new Date().toISOString(),
    chunks: repository.loadRagChunks(),
    references: repository.loadReferences(),
    ...(metadata ? { coverage: metadata.coverage } : {})
  });
}
