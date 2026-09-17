#!/usr/bin/env node
/**
 * RAG local-only contract check.
 *
 * It deliberately uses a temporary, isolated cache list.  A developer's
 * unrelated Hugging Face cache must not decide whether this regression test
 * passes, and this script never downloads or creates a model.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const workerSource = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'ragEmbeddingWorker.ts'), 'utf8');
assert.match(workerSource, /allowRemoteModels\s*=\s*false/u);
assert.match(workerSource, /allowLocalModels\s*=\s*true/u);
assert.match(workerSource, /local_files_only\s*:\s*true/u);
assert.doesNotMatch(workerSource, /(?:fetch\s*\(|download|from_pretrained)/iu);

const { resolveRagLocalModel } = await import('../apps/desktop/src/main/ragLocalModel.ts');
const embeddingSource = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'ragEmbedding.ts'), 'utf8');
assert.match(embeddingSource, /model\.state\s*!==\s*'local-ready'/u);
assert.match(embeddingSource, /throw new Error\('RAG_LOCAL_MODEL_UNAVAILABLE'\)/u);
assert.ok(embeddingSource.indexOf('model.state !== \'local-ready\'') < embeddingSource.indexOf('new Worker('), 'worker 必须在本地模型门禁之后创建');
const scratch = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'soulforge-rag-local-only-'));
const previousModelPath = process.env.SOULFORGE_RAG_MODEL_PATH;
const previousFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('RAG_NETWORK_FETCH_FORBIDDEN');
};

try {
  const isolated = { cacheDir: join(scratch, 'embedding-cache'), userDataDir: join(scratch, 'user-data'), standardCacheRoots: [] };
  delete process.env.SOULFORGE_RAG_MODEL_PATH;
  const unavailable = resolveRagLocalModel(isolated);
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.diagnosticCode, 'RAG_LOCAL_MODEL_UNAVAILABLE');

  const explicit = join(scratch, 'explicit-model');
  await mkdir(explicit, { recursive: true });
  process.env.SOULFORGE_RAG_MODEL_PATH = explicit;
  const manifestMissing = resolveRagLocalModel(isolated);
  assert.equal(manifestMissing.state, 'model-id-mismatch');
  assert.equal(manifestMissing.diagnosticCode, 'RAG_MODEL_MANIFEST_REQUIRED');

  await writeFile(join(explicit, 'soulforge-rag-model.json'), JSON.stringify({
    modelId: 'wrong/model',
    revision: 'wrong-revision',
    dimension: 1
  }));
  const identityMismatch = resolveRagLocalModel(isolated);
  assert.equal(identityMismatch.state, 'model-id-mismatch');

  assert.equal(fetchCalls, 0, '缺模型时不得触发网络请求');
  assert.equal(existsSync(isolated.cacheDir), false, '缺模型时不得创建 embedding/model 目录');

  console.log(JSON.stringify({
    ok: true,
    status: 'verified',
    networkFetches: fetchCalls,
    unavailableState: unavailable.state,
    mismatchState: identityMismatch.state
  }, null, 2));
} finally {
  if (previousModelPath === undefined) delete process.env.SOULFORGE_RAG_MODEL_PATH;
  else process.env.SOULFORGE_RAG_MODEL_PATH = previousModelPath;
  globalThis.fetch = previousFetch;
  await rm(scratch, { recursive: true, force: true });
}
