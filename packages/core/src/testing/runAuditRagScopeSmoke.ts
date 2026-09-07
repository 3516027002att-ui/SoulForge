import { strict as assert } from 'node:assert';
import type { RagChunk, RagCorpus, RagRetrieveResult } from '@soulforge/shared';
import { retrieveEvidenceHybrid, fuseRrf } from '../rag/hybridRetrieve.js';
import { normalizeRetrievalScope, RetrievalScopeError, retrievalCandidateLimit } from '../rag/retrievalScope.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { compareRanked, topK } from '../rag/topK.js';

interface SmokeSummary {
  readonly ok: true;
  readonly taskId: 'SF-18';
  readonly cases: number;
  readonly productionExports: readonly string[];
}

export function runAuditRagScopeSmoke(): SmokeSummary {
  const corpus = makeCorpus();
  let cases = 0;

  assert.throws(
    () => normalizeRetrievalScope({ workspaceId: 'ws-a', families: [] }),
    (error: unknown) => error instanceof RetrievalScopeError && error.code === 'INVALID_FAMILY_FILTER'
  );
  cases += 1;
  assert.throws(
    () => normalizeRetrievalScope({ workspaceId: 'ws-a', families: ['not-a-family'] }),
    (error: unknown) => error instanceof RetrievalScopeError && error.code === 'INVALID_FAMILY_FILTER'
  );
  cases += 1;

  const illegalScope = retrieveEvidence(corpus, 'target', { families: [] });
  assert.equal(illegalScope.ok, false);
  if (!illegalScope.ok) assert.equal(illegalScope.code, 'INVALID_INPUT');
  cases += 1;

  const wrongWorkspace = retrieveEvidence(corpus, 'target', { workspaceId: 'ws-b' });
  assert.equal(wrongWorkspace.ok, false);
  cases += 1;
  const limitLow = retrieveEvidence(corpus, 'target', { limit: 0 });
  const limitHigh = retrieveEvidence(corpus, 'target', { limit: 33 });
  assert.equal(limitLow.ok, false);
  assert.equal(limitHigh.ok, false);
  cases += 2;
  assert.equal(retrievalCandidateLimit(1), 64);
  assert.equal(retrievalCandidateLimit(8), 64);
  assert.equal(retrievalCandidateLimit(32), 128);
  cases += 1;

  const tied = topK([
    { id: 'z', score: 4 },
    { id: 'b', score: 4 },
    { id: 'a', score: 4 },
    { id: 'c', score: 3 }
  ], 3);
  assert.deepEqual(tied.map((item) => item.id), ['a', 'b', 'z']);
  assert.deepEqual(tied, [...tied].sort(compareRanked));
  cases += 1;

  const scopedLexical = retrieveEvidence(corpus, '50800000', {
    families: ['param_row'],
    expandReferences: true,
    limit: 4
  });
  assert.equal(scopedLexical.ok, true);
  if (scopedLexical.ok) {
    assert(scopedLexical.hits.every((hit) => hit.chunk.family === 'param_row'));
    assert(scopedLexical.hits.every((hit) => hit.chunk.chunkId !== 'stale-param'));
    assert(scopedLexical.hits.length <= 4);
  }
  cases += 1;

  const vectorOnly = retrieveEvidenceHybrid(corpus, 'semantic-only-no-lexical-hit', {
    families: ['param_row'],
    expandReferences: false,
    limit: 4,
    vectors: {
      queryVector: new Float32Array([1, 0]),
      vectors: new Map([
        ['map-1', new Float32Array([1, 0])],
        ['param-1', new Float32Array([0.8, 0.6])]
      ])
    }
  });
  assert.equal(vectorOnly.ok, true);
  if (vectorOnly.ok) {
    assert(vectorOnly.hits.length > 0);
    assert(vectorOnly.hits.every((hit) => hit.chunk.family === 'param_row'));
    assert.equal(vectorOnly.hits[0]?.chunk.chunkId, 'param-1');
  }
  cases += 1;

  const badDimension = retrieveEvidenceHybrid(corpus, 'semantic-only-no-lexical-hit', {
    families: ['param_row'],
    expandReferences: false,
    vectors: {
      queryVector: new Float32Array([1, 0]),
      dimension: 3,
      vectors: new Map([['param-1', new Float32Array([1, 0])]])
    }
  });
  assert.equal(badDimension.ok, false);
  const badDimensionWithDiagnostics = badDimension as RagRetrieveResult & { diagnostics?: Array<{ code: string }> };
  if (!badDimension.ok) assert(badDimensionWithDiagnostics.diagnostics?.some((diagnostic) => /DIMENSION/.test(diagnostic.code)) === true);
  cases += 1;

  const scope = normalizeRetrievalScope({ workspaceId: 'ws-a', families: ['param_row'] });
  const rrf = fuseRrf(
    corpus.chunks,
    ['param-1', 'param-1', 'param-2'],
    ['param-1', 'param-2', 'param-2'],
    scope,
    2
  );
  assert.deepEqual(rrf.map((chunk) => chunk.chunkId), ['param-1', 'param-2']);
  cases += 1;

  // 越界候选必须在构建 rank list 前过滤，不能消耗合法候选的 RRF 名次。
  const filteredBeforeRank = fuseRrf(
    corpus.chunks,
    ['map-1', 'param-1'],
    ['param-2'],
    scope,
    2
  );
  assert.deepEqual(filteredBeforeRank.map((chunk) => chunk.chunkId), ['param-1', 'param-2']);
  cases += 1;

  const ambiguity = retrieveEvidence(corpus, '909', {
    families: ['param_row'],
    expandReferences: false,
    limit: 2
  }) as RagRetrieveResult & { cursor?: string; ambiguity?: string };
  assert.equal(ambiguity.ok, false);
  if (!ambiguity.ok) {
    assert.equal(ambiguity.ambiguity, 'exact');
    assert(typeof ambiguity.cursor === 'string' && ambiguity.cursor.length > 0);
  }
  cases += 1;

  const revision = retrieveEvidence(corpus, 'revision-target', {
    families: ['param_row'],
    revision: 2,
    expandReferences: false
  });
  assert.equal(revision.ok, true);
  if (revision.ok) assert(revision.hits.every((hit) => hit.chunk.sourceRevision === 2));
  cases += 1;

  return {
    ok: true,
    taskId: 'SF-18',
    cases,
    productionExports: [
      'normalizeRetrievalScope',
      'retrievalCandidateLimit',
      'topK',
      'compareRanked',
      'retrieveEvidence',
      'retrieveEvidenceHybrid',
      'fuseRrf'
    ]
  };
}

function makeCorpus(): RagCorpus {
  const chunks: RagChunk[] = [
    makeChunk('map-1', 'map_entity', 'map entity boss 50800000', 50800000),
    makeChunk('param-1', 'param_row', 'param row target 50800000', 50800000, { sourceRevision: 1 }),
    makeChunk('param-2', 'param_row', 'param row second 50800001', 50800001, { sourceRevision: 1 }),
    makeChunk('param-neighbor', 'param_row', 'param row neighbor target', 8100, { sourceRevision: 1 }),
    makeChunk('stale-param', 'param_row', 'stale target 50800000', 50800000, { stale: true, sourceRevision: 1 }),
    makeChunk('revision-param', 'param_row', 'revision-target', 8200, { sourceRevision: 2 }),
    makeChunk('ambiguous-a', 'param_row', 'ambiguous 909 alpha', 909, { sourceRevision: 1 }),
    makeChunk('ambiguous-b', 'param_row', 'ambiguous 909 beta', 909, { sourceRevision: 1 }),
    makeChunk('ambiguous-c', 'param_row', 'ambiguous 909 gamma', 909, { sourceRevision: 1 }),
    makeChunk('event-1', 'event', 'event target', 100)
  ];
  return {
    workspaceId: 'ws-a',
    builtAt: 'sf18-smoke-v1',
    chunks,
    references: [
      edge(chunks, 'param-1', 'map-1', 'references_map_entity'),
      edge(chunks, 'param-1', 'param-neighbor', 'references_param_row')
    ],
    stats: {
      total: chunks.length,
      byFamily: { file: 0, event: 1, map_entity: 1, map_region: 0, param_row: 7, text_entry: 0, tae_event: 0 }
    },
    availability: 'available',
    diagnostics: []
  };
}

function makeChunk(
  chunkId: string,
  family: RagChunk['family'],
  body: string,
  numericId: number,
  extra: Record<string, unknown> = {}
): RagChunk {
  return {
    chunkId,
    workspaceId: 'ws-a',
    sourceUri: `sekiro://${family}/${chunkId}`,
    symbolUri: `symbol://${chunkId}`,
    family,
    title: chunkId,
    body,
    numericIds: [numericId],
    contentHash: `${chunkId}:${body}`,
    ...extra
  } as RagChunk;
}

function edge(
  chunks: readonly RagChunk[],
  fromId: string,
  toId: string,
  kind: 'references_map_entity' | 'references_param_row'
): RagCorpus['references'][number] {
  const from = chunks.find((chunk) => chunk.chunkId === fromId);
  const to = chunks.find((chunk) => chunk.chunkId === toId);
  assert(from && to);
  return { fromUri: from.symbolUri, toUri: to.symbolUri, kind, confidence: 'high', reason: 'SF-18 smoke', evidence: [] };
}
