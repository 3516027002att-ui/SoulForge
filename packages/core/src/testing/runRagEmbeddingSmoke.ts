/**
 * Embedding 语义检索 smoke：mock fetch 验证 /v1/embeddings 协议（请求体、
 * 乱序 index 归位、错误分类）、向量 BLOB 存取往返、余弦相似度、RRF 混合
 * 检索（lexical + 向量融合排序 / 无向量退化 / vectorScore 字段）。不发真实网络。
 */
import { join } from 'node:path';
import type { RagChunk, RagCorpus } from '@soulforge/shared';
import { cosineSimilarity, fetchEmbeddings } from '../model-services/embeddingClient.js';
import { createRagCorpus } from '../rag/chunkBuilder.js';
import { retrieveEvidenceHybrid } from '../rag/hybridRetrieve.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

let checked = 0;
function expect(condition: boolean, label: string): void {
  checked += 1;
  if (!condition) throw new Error(`embedding smoke assertion failed: ${label}`);
}

function embeddingFetch(
  vectorsByInput: Array<Array<number>>,
  shuffle = false
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/v1/embeddings')) throw new Error(`unexpected URL: ${url}`);
    const body = JSON.parse(String(init?.body)) as { model?: unknown; input?: unknown };
    expect(typeof body.model === 'string' && body.model === 'embed-model', 'request model');
    const texts = body.input as string[];
    expect(Array.isArray(texts) && texts.length === vectorsByInput.length, 'request input count');
    // index 字段指向输入序号；shuffle 时只打乱 data 的返回顺序，index 保持不变。
    const order = shuffle ? [...texts.keys()].reverse() : [...texts.keys()];
    const data = order.map((inputIndex) => ({
      index: inputIndex,
      embedding: vectorsByInput[inputIndex] ?? []
    }));
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ object: 'list', data, model: 'embed-model' }),
      text: async () => ''
    } as unknown as Response;
  }) as typeof fetch;
}

function main(): Promise<void> {
  return withSmokeWorkspace('rag-embedding', async (workspace) => {
    // --- 1. embeddingClient 协议 ---
    const ok = await fetchEmbeddings({
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: 'k',
      model: 'embed-model',
      inputs: ['a', 'b', 'c'],
      fetchImpl: embeddingFetch([[1, 0], [0, 1], [1, 1]], true) // 乱序 index 归位
    });
    expect(ok.ok, 'fetchEmbeddings ok');
    if (ok.ok) {
      expect(ok.dim === 2, 'dim');
      expect(ok.vectors.length === 3, 'vector count');
      const first = ok.vectors[0];
      const second = ok.vectors[1];
      expect(first !== undefined && first[0] === 1 && first[1] === 0, 'index 0 reordered correctly');
      expect(second !== undefined && second[1] === 1, 'index 1 reordered correctly');
    }

    const empty = await fetchEmbeddings({
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: 'k',
      model: 'embed-model',
      inputs: [],
      fetchImpl: (async () => { throw new Error('must not call network for empty inputs'); }) as typeof fetch
    });
    expect(empty.ok && empty.vectors.length === 0, 'empty inputs -> ok empty');

    const failed = await fetchEmbeddings({
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: 'k',
      model: 'embed-model',
      inputs: ['x'],
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: 'bad key' } })
      }) as unknown as Response) as typeof fetch
    });
    expect(!failed.ok && failed.error.code === 'MODEL_SERVICE_AUTH_ERROR', '401 -> AUTH_ERROR');

    const partial = await fetchEmbeddings({
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: 'k',
      model: 'embed-model',
      inputs: ['a', 'b'],
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ object: 'list', data: [{ index: 0, embedding: [1] }], model: 'embed-model' }),
        text: async () => ''
      }) as unknown as Response) as typeof fetch
    });
    expect(!partial.ok && partial.error.code === 'MODEL_SERVICE_RESPONSE_PARSE_FAILED', 'mismatched count -> parse error');

    // --- 2. 余弦 ---
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    const same = new Float32Array([2, 0, 0]);
    expect(Math.abs(cosineSimilarity(a, b)) < 1e-9, 'orthogonal -> 0');
    expect(Math.abs(cosineSimilarity(a, same) - 1) < 1e-9, 'parallel -> 1');
    expect(cosineSimilarity(a, new Float32Array([0, 0])) === 0, 'dim mismatch -> 0');

    // --- 3. 向量 BLOB 存取往返（真实 workspace.db）---
    const dbPath = join(workspace.root, 'workspace.db');
    const database = openWorkspaceDatabase(dbPath);
    const now = new Date().toISOString();
    database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)`).run('ws-embed', workspace.root, 'sekiro', now, now);
    const repository = new WorkspaceDataRepository(database, 'ws-embed');
    const probe: RagChunk = {
      chunkId: 'rag:text_entry:probe',
      workspaceId: 'ws-embed',
      sourceUri: 'file://synthetic/msg/Goods.fmg',
      symbolUri: 'msg://Goods/1',
      family: 'text_entry',
      title: 'Goods 1',
      body: '狼的义手',
      numericIds: [1],
      contentHash: 'probe-hash'
    };
    repository.replaceRagChunks([probe]);
    const vector = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    repository.replaceRagEmbeddings([{
      chunkId: probe.chunkId,
      model: 'embed-model',
      vector,
      sourceRevision: 'fixture-revision-1'
    }]);
    expect(repository.ragEmbeddingModel() === 'embed-model', 'embedding model recorded');
    expect(repository.ragEmbeddingSourceRevision() === 'fixture-revision-1', 'embedding source revision recorded');
    const loaded = repository.loadRagEmbeddings().get(probe.chunkId);
    expect(loaded !== undefined, 'vector loaded back');
    if (loaded) {
      const third = loaded[2] ?? 0;
      expect(loaded.length === 4 && Math.abs(third - 0.3) < 1e-7, 'float32 roundtrip exact');
    }
    // 语料重建后向量被 FK 级联清掉（孤儿向量不得残留）。
    repository.replaceRagChunks([]);
    expect(repository.loadRagEmbeddings().size === 0, 'cascade deletes orphan vectors');
    database.close();

    // --- 4. RRF 混合检索 ---
    const corpus = makeCorpus();
    const lexicalOnly = retrieveEvidence(corpus, 'flag 71000000');
    expect(lexicalOnly.ok, 'lexical baseline ok');

    const vecA = new Float32Array([1, 0, 0]);
    const vecB = new Float32Array([0.9, 0.1, 0]);
    const vecC = new Float32Array([0, 0, 1]);
    const vectors = new Map<string, Float32Array>([
      ['rag:event:event1000', vecA],
      ['rag:map_entity:entity1100800', vecB],
      ['rag:text_entry:goods1000', vecC]
    ]);
    // 查询向量最接近 text_entry（语义上「狼的义手」与查询同向），
    // lexical 上 flag 查询命中 event。RRF 融合后两者都应出现，且 text_entry
    // 带有 vectorScore（纯向量命中）。
    const hybrid = retrieveEvidenceHybrid(corpus, 'flag 71000000', {
      vectors: { vectors, queryVector: new Float32Array([0.05, 0.02, 1]) },
      limit: 8
    });
    expect(hybrid.ok, 'hybrid ok');
    if (hybrid.ok) {
      const uris = hybrid.hits.map((hit) => hit.chunk.symbolUri);
      expect(uris.includes('event://m10_00_00_00/1000'), 'lexical hit retained in hybrid');
      expect(uris.includes('msg://Goods/1000'), 'pure-vector hit enters hybrid');
      const goods = hybrid.hits.find((hit) => hit.chunk.symbolUri === 'msg://Goods/1000');
      const goodsScore = goods?.vectorScore ?? 0;
      const goodsReasons = goods?.reasons ?? [];
      expect(goods !== undefined && goodsScore > 0.99, 'pure-vector hit carries vectorScore');
      expect(goodsReasons.some((reason) => reason.startsWith('vector:')), 'pure-vector hit reason');
      expect(hybrid.hits.every((hit) => hit.score > 0), 'hybrid scores positive');
    }

    // 无向量源 → 退化为纯 lexical（结果等价）。
    const noVectors = retrieveEvidenceHybrid(corpus, 'flag 71000000', {});
    expect(noVectors.ok, 'no vectors -> lexical ok');
    if (noVectors.ok && lexicalOnly.ok) {
      expect(noVectors.hits.map((hit) => hit.chunk.chunkId).join(',')
        === lexicalOnly.hits.map((hit) => hit.chunk.chunkId).join(','), 'no vectors -> identical to lexical');
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'workspace RAG embedding smoke: ok',
      assertions: checked,
      protocol: 'POST /v1/embeddings (openai-compatible)',
      fusion: 'RRF (K=60)',
      storage: 'rag_embeddings float32 BLOB, cascade on chunk rebuild',
      nonClaims: [
        'Mock responses do not prove any real embedding provider is available.',
        'Vector similarity is not native-verified; it only re-ranks lexical evidence.'
      ]
    }, null, 2));
  });
}

function makeCorpus(): RagCorpus {
  const now = new Date().toISOString();
  return createRagCorpus({
    workspaceId: 'ws-embed',
    builtAt: now,
    chunks: [
      makeChunk('rag:event:event1000', 'event://m10_00_00_00/1000', 'event',
        'event 1000', 'event 1000\nSetEventFlag flag=71000000', [1000, 71000000]),
      makeChunk('rag:map_entity:entity1100800', 'map://m10_00_00_00/entity/1100800', 'map_entity',
        'm10_00_00_00 1100800', 'entity 1100800\nname 义手武士', [1100800]),
      makeChunk('rag:text_entry:goods1000', 'msg://Goods/1000', 'text_entry',
        'Goods 1000', 'textId 1000\n狼的义手', [1000])
    ],
    references: []
  });
}

function makeChunk(
  chunkId: string,
  symbolUri: string,
  family: RagChunk['family'],
  title: string,
  body: string,
  numericIds: number[]
): RagChunk {
  return {
    chunkId,
    workspaceId: 'ws-embed',
    sourceUri: symbolUri.replace(/^[a-z]+:\/\//, 'file://synthetic/'),
    symbolUri,
    family,
    title,
    body,
    numericIds,
    contentHash: `hash-${chunkId}`
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
