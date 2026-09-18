import { createHash } from 'node:crypto';
import type { KnowledgeClaim, KnowledgePage, KnowledgePatch, KnowledgeSourceRef } from './knowledgeTypes.js';
import { makeSourceRef, type KnowledgeStoreLike } from './knowledgeStore.js';

export interface KnowledgeIngestInput {
  sourceId: string;
  body: string;
  observedVersion: string;
  readerSchemaHash: string;
  page: Omit<KnowledgePage, 'contentHash' | 'revision' | 'claims'> & { claims?: KnowledgeClaim[] };
}

export function buildKnowledgePatch(store: KnowledgeStoreLike, input: KnowledgeIngestInput): KnowledgePatch {
  const source = makeSourceRef(input.sourceId, input.body, input.observedVersion, input.readerSchemaHash);
  const current = store.getCurrent();
  const existing = current.pages[input.page.pageId];
  return {
    expectedGeneration: current.generationId,
    sourceRevisions: [source],
    pages: [{
      pageId: input.page.pageId,
      path: input.page.path,
      body: input.page.body,
      expectedRevision: existing?.revision ?? null,
      scope: input.page.scope,
      ...(input.page.claims ? { claims: input.page.claims } : {})
    }],
    ...(input.page.claims ? { claims: input.page.claims } : {})
  };
}

export function ingestKnowledgeSource(store: KnowledgeStoreLike, input: KnowledgeIngestInput): ReturnType<KnowledgeStoreLike['commitPatch']> {
  const sourceHash = createHash('sha256').update(input.body, 'utf8').digest('hex');
  if (store.sourceRevision(input.sourceId) === sourceHash) return { ok: true, generation: store.getCurrent() };
  return store.commitPatch(buildKnowledgePatch(store, input));
}

export function sanitizeKnowledgeText(text: string): string {
  return text.replace(/(?:^|\n)\s*(?:powershell|cmd|exec|writeFile)\b[^\n]*/giu, '$1[executable instruction removed by host]');
}
