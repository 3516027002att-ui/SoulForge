import type { KnowledgeClaim, KnowledgePage, KnowledgeQueryOptions } from './knowledgeTypes.js';
import type { KnowledgeStoreLike } from './knowledgeStore.js';

export function queryKnowledgeClaims(store: KnowledgeStoreLike, query: string, options: KnowledgeQueryOptions): KnowledgeClaim[] {
  const needle = query.trim().toLocaleLowerCase();
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const candidates = Object.values(store.getCurrent().claims).filter((claim) => {
    if (!options.includeHistorical && !['draft', 'accepted'].includes(claim.publicationState)) return false;
    if (kinds && !kinds.has(claim.kind)) return false;
    if (claim.scope.visibility === 'project' && claim.scope.workspaceId !== options.workspaceId) return false;
    if (claim.scope.visibility === 'global' && options.gameProfile && claim.scope.gameProfile !== options.gameProfile) return false;
    if (options.namespace && claim.scope.namespace && claim.scope.namespace !== options.namespace) return false;
    return needle === '' || `${claim.subjectKey} ${claim.predicateKey} ${claim.text ?? ''} ${JSON.stringify(claim.value ?? '')}`.toLocaleLowerCase().includes(needle);
  });
  return candidates.sort((a, b) => a.claimId.localeCompare(b.claimId)).slice(0, Math.max(1, Math.min(64, options.limit ?? 8)));
}

export function readKnowledgePage(store: KnowledgeStoreLike, pageId: string, options: KnowledgeQueryOptions): KnowledgePage | undefined {
  const page = store.readPage(pageId);
  if (!page) return undefined;
  if (page.scope.visibility === 'project' && page.scope.workspaceId !== options.workspaceId) return undefined;
  return page;
}
