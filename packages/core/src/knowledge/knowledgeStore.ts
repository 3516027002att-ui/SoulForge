import { createHash, randomUUID } from 'node:crypto';
import type { KnowledgeGeneration, KnowledgePage, KnowledgePatch, KnowledgeClaim, KnowledgeSourceRef } from './knowledgeTypes.js';
import { lintKnowledgeGeneration } from './knowledgeLint.js';
import { validateClaimDependencyDag } from './claimGraph.js';

export class KnowledgeStore {
  private readonly generations = new Map<string, KnowledgeGeneration>();
  private readonly blobs = new Map<string, string>();
  private current: string;

  constructor(schemaVersion = 'knowledge-v1') {
    const generation: KnowledgeGeneration = { generationId: 'gen-0', parentGeneration: null, schemaVersion, pages: {}, claims: {}, sourceRevisions: {}, createdAt: new Date(0).toISOString() };
    this.generations.set(generation.generationId, generation);
    this.current = generation.generationId;
  }

  get currentGeneration(): string { return this.current; }
  getCurrent(): KnowledgeGeneration { return cloneGeneration(this.requireGeneration(this.current)); }
  readPage(pageId: string, generationId = this.current): KnowledgePage | undefined { const page = this.requireGeneration(generationId).pages[pageId]; return page ? structuredClone(page) : undefined; }
  readBlob(hash: string): string | undefined { return this.blobs.get(hash); }

  registerBlob(body: string): string {
    const hash = createHash('sha256').update(body, 'utf8').digest('hex');
    const existing = this.blobs.get(hash);
    if (existing !== undefined && existing !== body) throw new Error('KNOWLEDGE_BLOB_HASH_COLLISION');
    this.blobs.set(hash, body);
    return hash;
  }

  commitPatch(patch: KnowledgePatch): { ok: true; generation: KnowledgeGeneration } | { ok: false; code: 'CAS_CONFLICT' | 'LINT_FAILED' | 'PAGE_CAS_CONFLICT'; message: string; findings?: unknown } {
    if (patch.expectedGeneration !== this.current) return { ok: false, code: 'CAS_CONFLICT', message: 'CURRENT generation 已变化。' };
    const base = this.requireGeneration(this.current);
    const pages = { ...base.pages };
    const claims = { ...base.claims };
    for (const change of patch.pages) {
      const previous = pages[change.pageId];
      if ((previous?.revision ?? null) !== change.expectedRevision) return { ok: false, code: 'PAGE_CAS_CONFLICT', message: `page ${change.pageId} revision 已变化。` };
      const contentHash = this.registerBlob(change.body);
      pages[change.pageId] = { pageId: change.pageId, path: change.path, body: change.body, contentHash, revision: (previous?.revision ?? 0) + 1, scope: change.scope, claims: change.claims?.map((claim) => claim.claimId) ?? previous?.claims ?? [] };
      for (const claim of change.claims ?? []) claims[claim.claimId] = structuredClone(claim);
    }
    for (const claim of patch.claims ?? []) claims[claim.claimId] = structuredClone(claim);
    const sourceRevisions: Record<string, string> = { ...base.sourceRevisions };
    for (const source of patch.sourceRevisions) sourceRevisions[source.sourceId] = source.storedContentHash;
    const next: KnowledgeGeneration = { generationId: `gen-${randomUUID()}`, parentGeneration: this.current, schemaVersion: base.schemaVersion, pages, claims, sourceRevisions, createdAt: new Date().toISOString() };
    const findings = lintKnowledgeGeneration(next);
    if (findings.some((finding) => finding.severity === 'error')) return { ok: false, code: 'LINT_FAILED', message: 'knowledge generation lint失败。', findings };
    try { validateClaimDependencyDag(Object.values(next.claims)); } catch (error) { return { ok: false, code: 'LINT_FAILED', message: error instanceof Error ? error.message : String(error) }; }
    this.generations.set(next.generationId, next);
    this.current = next.generationId;
    return { ok: true, generation: cloneGeneration(next) };
  }

  sourceRevision(sourceId: string): string | undefined { return this.getCurrent().sourceRevisions[sourceId]; }
  generation(generationId: string): KnowledgeGeneration | undefined { const value = this.generations.get(generationId); return value ? cloneGeneration(value) : undefined; }
  generationsForRecovery(): KnowledgeGeneration[] { return [...this.generations.values()].map(cloneGeneration); }

  private requireGeneration(id: string): KnowledgeGeneration { const generation = this.generations.get(id); if (!generation) throw new Error('KNOWLEDGE_GENERATION_NOT_FOUND'); return generation; }
}

function cloneGeneration(generation: KnowledgeGeneration): KnowledgeGeneration { return structuredClone(generation); }

export function makeSourceRef(sourceId: string, body: string, observedVersion = 'unknown', readerSchemaHash = 'unknown'): KnowledgeSourceRef {
  const storedContentHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return { sourceId, storedContentHash, observedVersion, readerSchemaHash, accessScope: 'local' };
}
