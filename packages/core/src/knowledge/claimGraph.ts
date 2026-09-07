import type { KnowledgeClaim } from './knowledgeTypes.js';

export function validateClaimDependencyDag(claims: readonly KnowledgeClaim[]): void {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  if (byId.size !== claims.length) throw new Error('DUPLICATE_CLAIM_ID');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    const claim = byId.get(id);
    if (!claim) throw new Error('CLAIM_DEPENDENCY_UNKNOWN');
    if (visiting.has(id)) throw new Error('CLAIM_DEPENDENCY_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    claim.dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  claims.forEach((claim) => visit(claim.claimId));
}

export function invalidateClaimClosure(
  claims: readonly KnowledgeClaim[],
  roots: readonly string[],
  reason: string
): KnowledgeClaim[] {
  validateClaimDependencyDag(claims);
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const reverse = new Map<string, string[]>();
  for (const claim of claims) for (const dependency of claim.dependencies) {
    const list = reverse.get(dependency) ?? [];
    list.push(claim.claimId);
    reverse.set(dependency, list);
  }
  const dirty = new Set<string>();
  const queue = [...roots];
  for (const root of roots) if (!byId.has(root)) throw new Error('STALE_ROOT_UNKNOWN');
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (dirty.has(current)) continue;
    dirty.add(current);
    queue.push(...(reverse.get(current) ?? []));
  }
  return claims.map((claim) => dirty.has(claim.claimId)
    ? { ...claim, publicationState: 'stale', staleReason: reason }
    : claim);
}
