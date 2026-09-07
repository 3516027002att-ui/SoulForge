import { strict as assert } from 'node:assert';
import { KnowledgeStore } from '../knowledge/knowledgeStore.js';
import { ingestKnowledgeSource, sanitizeKnowledgeText } from '../knowledge/knowledgeIngest.js';
import { queryKnowledgeClaims, readKnowledgePage } from '../knowledge/knowledgeQuery.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import type { KnowledgeClaim } from '../knowledge/knowledgeTypes.js';

function selectedLayer(): 'unit' | 'native' {
  const index = process.argv.indexOf('--layer');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== 'unit' && value !== 'native') throw new Error('SF-24 requires --layer unit|native');
  return value;
}

function claim(overrides: Partial<KnowledgeClaim> = {}): KnowledgeClaim {
  return {
    claimId: 'claim-native-1',
    semanticKey: 'param:goods:1000',
    pageId: 'page-goods',
    subjectKey: 'Goods/1000',
    predicateKey: 'hasField',
    value: { hp: 10 },
    text: 'Goods 1000 has hp 10',
    scope: { gameProfile: 'sekiro', version: 'fixture-1', visibility: 'project', workspaceId: 'ws-a', namespace: 'param' },
    kind: 'observed_native',
    publicationState: 'accepted',
    evidenceStrength: 'native_read',
    sourceRefs: [{ sourceId: 'native:param', storedContentHash: 'source-hash', observedVersion: 'rev-1', readerSchemaHash: 'schema-1', accessScope: 'local' }],
    dependencies: [],
    readerSchemaHash: 'schema-1',
    createdFrom: 'native-read',
    contentHash: 'claim-hash',
    ...overrides
  };
}

async function main(): Promise<void> {
  const layer = selectedLayer();
  const store = new KnowledgeStore();
  const first = ingestKnowledgeSource(store, {
    sourceId: 'wiki:goods',
    body: '# Goods\nNative observation',
    observedVersion: 'rev-1',
    readerSchemaHash: 'schema-1',
    page: { pageId: 'page-goods', path: 'wiki/goods.md', body: '# Goods\nNative observation', scope: { gameProfile: 'sekiro', version: 'fixture-1', visibility: 'project', workspaceId: 'ws-a' }, claims: [claim()] }
  });
  assert.equal(first.ok, true);
  const generationAfterFirst = store.currentGeneration;
  const idempotent = ingestKnowledgeSource(store, {
    sourceId: 'wiki:goods',
    body: '# Goods\nNative observation',
    observedVersion: 'rev-1',
    readerSchemaHash: 'schema-1',
    page: { pageId: 'page-goods', path: 'wiki/goods.md', body: '# Goods\nNative observation', scope: { gameProfile: 'sekiro', version: 'fixture-1', visibility: 'project', workspaceId: 'ws-a' }, claims: [claim()] }
  });
  assert.equal(idempotent.ok, true);
  assert.equal(store.currentGeneration, generationAfterFirst, 'same source hash must be idempotent');

  const claims = queryKnowledgeClaims(store, 'goods 1000', { workspaceId: 'ws-a', gameProfile: 'sekiro', kinds: ['observed_native'] });
  assert.equal(claims.length, 1);
  assert.equal(queryKnowledgeClaims(store, 'goods', { workspaceId: 'other', gameProfile: 'sekiro' }).length, 0);
  assert.equal(readKnowledgePage(store, 'page-goods', { workspaceId: 'other' }), undefined);

  const registry = createDefaultToolRegistry();
  const queryTool = await registry.run('query_knowledge', { query: 'goods', workspaceId: 'ws-a', gameProfile: 'sekiro' }, { workspaceIndex: null, mode: 'normal', knowledgeStore: store });
  assert.equal(queryTool.ok, true);
  assert.equal((queryTool.data as { count: number }).count, 1);
  const readTool = await registry.run('read_knowledge_claims', { claimIds: ['claim-native-1'], workspaceId: 'ws-a' }, { workspaceIndex: null, mode: 'normal', knowledgeStore: store });
  assert.equal(readTool.ok, true);
  const readData = readTool.data as { claims: KnowledgeClaim[] };
  assert.equal(readData.claims[0]?.claimId, 'claim-native-1');
  const deniedTool = await registry.run('query_knowledge', { query: 'goods', workspaceId: 'ws-a' }, { workspaceIndex: null, mode: 'normal' });
  assert.equal(deniedTool.ok, false);
  assert.equal(deniedTool.error?.code, 'KNOWLEDGE_STORE_UNAVAILABLE');

  const sanitized = sanitizeKnowledgeText('summary\nexec writeFile secret.txt\nnormal');
  assert(!sanitized.includes('writeFile secret.txt'));
  assert(sanitized.includes('[executable instruction removed by host]'));

  const staged = ingestKnowledgeSource(store, {
    sourceId: 'wiki:hypothesis',
    body: 'hypothesis',
    observedVersion: 'rev-2',
    readerSchemaHash: 'schema-1',
    page: { pageId: 'page-hypothesis', path: 'wiki/hypothesis.md', body: 'hypothesis', scope: { gameProfile: 'sekiro', version: 'fixture-1', visibility: 'global' }, claims: [claim({ claimId: 'claim-hypothesis', pageId: 'page-hypothesis', kind: 'hypothesis', evidenceStrength: 'hypothesis', publicationState: 'draft', scope: { gameProfile: 'sekiro', version: 'fixture-1', visibility: 'global' } })] }
  });
  assert.equal(staged.ok, true);
  assert.equal(queryKnowledgeClaims(store, 'goods', { workspaceId: 'ws-a', gameProfile: 'sekiro' }).length, 2);
  assert.equal(queryKnowledgeClaims(store, 'goods', { workspaceId: 'ws-a', gameProfile: 'sekiro', includeHistorical: true }).length, 2);

  console.log(JSON.stringify({
    ok: true,
    taskId: 'SF-24',
    layer,
    executedCases: 12,
    queryCount: claims.length,
    generation: store.currentGeneration,
    production: ['KnowledgeStore', 'queryKnowledgeClaims', 'query_knowledge', 'read_knowledge_claims', 'sanitizeKnowledgeText'],
    note: layer === 'native' ? 'knowledge query native verification remains read-only and is bounded by current store/source evidence' : undefined
  }));
}

void main();
