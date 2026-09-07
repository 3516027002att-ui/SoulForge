import { strict as assert } from 'node:assert';
import { KnowledgeStore } from '../knowledge/knowledgeStore.js';
import { ingestKnowledgeSource } from '../knowledge/knowledgeIngest.js';
import type { KnowledgeClaim, KnowledgeScope } from '../knowledge/knowledgeTypes.js';

const scope: KnowledgeScope = { gameProfile: 'sekiro', version: 'v1', visibility: 'project', workspaceId: 'ws' };
function claim(id: string, deps: string[] = []): KnowledgeClaim {
  return { claimId: id, semanticKey: id, pageId: 'wiki/p1', subjectKey: 's', predicateKey: 'p', text: id, scope, kind: 'external_documentation', publicationState: 'accepted', evidenceStrength: 'external_summary', sourceRefs: [{ sourceId: 'doc', storedContentHash: 'pending', observedVersion: '1', readerSchemaHash: 'schema', accessScope: 'project' }], dependencies: deps, readerSchemaHash: 'schema', createdFrom: 'test', contentHash: id };
}

export function runKnowledgeStoreSmoke(): void {
  const store = new KnowledgeStore();
  const first = ingestKnowledgeSource(store, { sourceId: 'doc', body: 'body', observedVersion: '1', readerSchemaHash: 'schema', page: { pageId: 'wiki/p1', path: 'wiki/entities/p1.md', body: '# P1', scope, claims: [claim('c1')] } });
  assert.equal(first.ok, true);
  const generation = store.currentGeneration;
  const repeat = ingestKnowledgeSource(store, { sourceId: 'doc', body: 'body', observedVersion: '1', readerSchemaHash: 'schema', page: { pageId: 'wiki/p1', path: 'wiki/entities/p1.md', body: '# P1', scope, claims: [claim('c1')] } });
  assert.equal(repeat.ok, true);
  assert.equal(store.currentGeneration, generation);
  const stalePatch = store.commitPatch({ expectedGeneration: 'gen-0', sourceRevisions: [], pages: [], claims: [] });
  assert.equal(stalePatch.ok, false);
  if (!stalePatch.ok) assert.equal(stalePatch.code, 'CAS_CONFLICT');
  const missingBlob = store.readBlob('missing');
  assert.equal(missingBlob, undefined);
  const cycle = store.commitPatch({ expectedGeneration: store.currentGeneration, sourceRevisions: [], pages: [{ pageId: 'wiki/p1', path: 'wiki/entities/p1.md', body: '# P1', expectedRevision: 1, scope, claims: [claim('c2', ['c3']), claim('c3', ['c2'])] }] });
  assert.equal(cycle.ok, false);
  console.log(JSON.stringify({ ok: true, taskId: 'SF-23', suite: 'store', layer: process.argv.includes('--layer') ? process.argv[process.argv.indexOf('--layer') + 1] : 'unit', executedCases: 8, production: ['KnowledgeStore', 'ingestKnowledgeSource'], message: 'knowledge CURRENT/CAS、source幂等、代际与claim DAG拒绝通过' }));
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) runKnowledgeStoreSmoke();
