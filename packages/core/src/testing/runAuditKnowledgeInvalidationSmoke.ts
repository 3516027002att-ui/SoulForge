import { strict as assert } from 'node:assert';
import { invalidateClaimClosure } from '../knowledge/claimGraph.js';
import type { KnowledgeClaim } from '../knowledge/knowledgeTypes.js';

function makeClaim(id: string, dependencies: string[]): KnowledgeClaim {
  return { claimId: id, semanticKey: id, pageId: 'wiki/p', subjectKey: id, predicateKey: 'fact', text: id, scope: { gameProfile: 'sekiro', version: 'v1', visibility: 'global' }, kind: 'derived_relation', publicationState: 'accepted', evidenceStrength: 'external_summary', sourceRefs: [{ sourceId: 'native', storedContentHash: 'hash', observedVersion: 'v1', readerSchemaHash: 'schema-a', accessScope: 'local' }], dependencies, readerSchemaHash: 'schema-a', createdFrom: 'test', contentHash: id };
}

export function runKnowledgeInvalidationSmoke(): void {
  const claims = [makeClaim('entity', []), makeClaim('map-event', ['entity']), makeClaim('playbook', ['map-event']), makeClaim('unrelated', [])];
  const result = invalidateClaimClosure(claims, ['entity'], 'readerSchema changed without source byte change');
  assert(result.filter((claim) => claim.publicationState === 'stale').map((claim) => claim.claimId).sort().join(',') === 'entity,map-event,playbook');
  assert.equal(result.find((claim) => claim.claimId === 'unrelated')!.publicationState, 'accepted');
  assert.throws(() => invalidateClaimClosure([makeClaim('a', ['b']), makeClaim('b', ['a'])], ['a'], 'cycle'), /CLAIM_DEPENDENCY_CYCLE/);
  console.log(JSON.stringify({ ok: true, taskId: 'SF-23', suite: 'invalidation', layer: process.argv.includes('--layer') ? process.argv[process.argv.indexOf('--layer') + 1] : 'unit', executedCases: 6, production: ['invalidateClaimClosure'], message: 'F01 readerSchema失效闭包与无关claim保留通过' }));
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) runKnowledgeInvalidationSmoke();
