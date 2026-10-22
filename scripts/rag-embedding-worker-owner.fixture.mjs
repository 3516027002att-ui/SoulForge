// Fake EventEmitter workers exercise production event ownership without a worker/model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
test('a retired embedding worker error cannot detach or reject its replacement worker', async () => {
  const workers = [];
  class Worker extends EventEmitter {
    termination = deferred();
    constructor() { super(); workers.push(this); }
    postMessage(message) { this.request = message; }
    terminate() { return this.termination.promise; }
  }
  const url = new URL('../apps/desktop/src/main/ragEmbedding.ts', import.meta.url);
  const source = fs.readFileSync(url, 'utf8');
  assert.equal(source.split('import.meta.url').length - 1, 1);
  const built = ts.transpileModule(source.replace('import.meta.url', JSON.stringify(url.href)), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  const exports = {};
  vm.runInNewContext(built.outputText, { exports, module: { exports }, console, AbortController, Float32Array, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:worker_threads') return { Worker };
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === 'node:fs/promises') return { mkdir: () => assert.fail('filesystem is forbidden') };
      if (name === './ragLocalModel.js') return { resolveRagLocalModel: () => assert.fail('model probing is forbidden') };
      if (name.startsWith('node:')) return require(name);
      throw new Error(`Unexpected worker lifecycle import ${name}`);
    }
  });
  const service = new exports.InternalRagEmbeddingService('/owned', () => ({ state: 'local-ready', modelPath: '/owned/fake-model' }));
  const old = service.ensureWorker(); const retiring = service.resetWorker();
  const query = service.embedQuery('replacement query'); const replacement = workers[1];
  try {
    assert.equal(workers.length, 2);
    old.emit('error', new Error('retired worker error'));
    assert.equal(service.worker, replacement, 'retired error must not clear the current worker');
    assert.equal(service.pending.size, 1, 'retired error must not reject the replacement request');
    replacement.emit('message', { id: replacement.request.id, ok: true, dim: 512, vectors: [new Float32Array(512).buffer] });
    assert.equal((await query)?.length, 512);
  } finally {
    for (const worker of workers) worker.termination.resolve(0);
    await retiring; await service.dispose(); await query;
  }
});
