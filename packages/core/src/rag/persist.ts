import type { RagCorpus } from '@soulforge/shared';
import type { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import { createRagCorpus } from './chunkBuilder.js';

export function persistRagCorpus(repository: WorkspaceDataRepository, corpus: RagCorpus): void {
  repository.replaceRagChunks(corpus.chunks);
  repository.replaceReferences(corpus.references);
}

export function loadRagCorpus(repository: WorkspaceDataRepository, workspaceId: string): RagCorpus {
  return createRagCorpus({
    workspaceId,
    builtAt: new Date().toISOString(),
    chunks: repository.loadRagChunks(),
    references: repository.loadReferences()
  });
}
