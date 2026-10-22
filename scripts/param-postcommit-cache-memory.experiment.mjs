import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { getHeapStatistics } from 'node:v8';
import { resolve } from 'node:path';
import { createParamCacheFixture } from './param-ipc-cache-fixture.mjs';

assert.equal(typeof global.gc, 'function', 'Use --expose-gc');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const fixture = await createParamCacheFixture({ fileCount: 12, rows: 256, bytesPerRow: 4096 });
const report = { runtime: { node: process.version, v8: process.versions.v8,
  role: process.versions.electron ? `electron-${process.type}-actual-ipc-handler-fixture` : 'standalone-actual-ipc-handler-fixture',
  electron: process.versions.electron ?? null, heapLimit: getHeapStatistics().heap_size_limit },
  sourceBinding: fixture.state.sourceBinding,
  input: { files: 12, rowsPerFile: 256, bytesPerRow: 4096, native: 'deterministic-fixture', commit: 'settled-result-fixture' },
  retainedChain: 'PARAM module environment -> paramAllCache Map -> CachedParamDocument -> rows[] -> dataBase64 strings',
  samples: [] };
let phase = 'setup';
const sample = () => {
  const stats = process.memoryUsage();
  report.samples.push({ phase, heapUsed: stats.heapUsed, rss: stats.rss,
    cachedDocuments: fixture.state.caches.paramAllCache.size,
    cachedRows: [...fixture.state.caches.paramAllCache.values()].reduce((n, value) => n + value.rows.length, 0) });
};
try {
  global.gc(); sample();
  for (const [index, file] of fixture.files.entries()) {
    phase = `preflight${index}`; await fixture.readAll(file); sample();
    phase = `write-refresh${index}`; await fixture.write(file); global.gc(); sample();
  }
  report.refreshObservations = fixture.state.refreshObservations;
  report.peakHeapUsed = Math.max(...report.samples.map((item) => item.heapUsed));
  report.peakRss = Math.max(...report.samples.map((item) => item.rss));
  console.log(JSON.stringify({ peakHeapUsed: report.peakHeapUsed, peakRss: report.peakRss, terminal: report.samples.at(-1) }));
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
} finally { await fixture.dispose(); }
