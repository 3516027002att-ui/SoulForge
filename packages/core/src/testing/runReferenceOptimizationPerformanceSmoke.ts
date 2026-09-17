/**
 * Reference-optimization performance smoke (T01, 执行指令 §8).
 *
 * Counters live at the lowest native port (FixtureNativeBackend). The
 * production snapshot cache (T03 nativeSnapshotCache) is the object under
 * test: it must coalesce concurrent identical reads, keep hot reads at zero
 * incremental parses, and never let a bypass verification read be swallowed
 * by the cache. On the baseline the cache module does not exist, so the
 * positive assertions fail with "行为未实现" while the fixture-side
 * invariants (counters increment exactly once per port call) still run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_LUABND_SOURCE,
  FixtureNativeBackend,
  fixtureHash,
  newFixtureCounters
} from './referenceOptimizationFixtures.js';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

/* ------------------------------------------------------------------ */
/* 0. Counter instrumentation sanity (fixture-side, always runs)       */
/* ------------------------------------------------------------------ */

// §8.2: measured counters for the fixed cases. Only what actually executed is
// reported — no derived percentages.
const perf: Record<string, number | string> = {};

const counters = newFixtureCounters();
check('counters/zero-initialized', Object.values(counters).every((value) => value === 0));

const backend = new FixtureNativeBackend();
backend.addOuter({
  sourceUri: FIXTURE_LUABND_SOURCE,
  outerBytes: Buffer.from('fixture-outer'),
  mtimeMs: 1000,
  children: [{ entryIndex: 0, entryName: 'a.lua', payload: Buffer.from('return 1'), contentKind: 'source' }],
  document: { scripts: [] }
});
backend.inventory(FIXTURE_LUABND_SOURCE);
backend.extractChild(FIXTURE_LUABND_SOURCE, 0);
backend.parse(FIXTURE_LUABND_SOURCE);
check('counters/inventory-once', backend.counters.containerInventoryCount === 1);
check('counters/extract-once', backend.counters.childExtractionCount === 1);
check('counters/parse-once', backend.counters.nativeParseCount === 1);

/* ------------------------------------------------------------------ */
/* 1. NativeSnapshotCache (T03) — cold/hot/concurrency/cancellation    */
/* ------------------------------------------------------------------ */

const cachePath = fileURLToPath(new URL('../runtime/nativeSnapshotCache.js', import.meta.url));
check('T03/nativeSnapshotCache-exists', existsSync(cachePath),
  '行为未实现：packages/core/src/runtime/nativeSnapshotCache.ts 尚不存在（T03）');

if (existsSync(cachePath)) {
  const cacheModule = await import(new URL('../runtime/nativeSnapshotCache.js', import.meta.url).href) as {
    createNativeSnapshotCache?: (options: {
      backend: { parse: (uri: string) => unknown; inventory: (uri: string) => unknown };
      maxBytes?: number; maxEntries?: number;
    }) => {
      read: (key: { sourceUri: string; shape: string; version: string }, options?: { bypass?: boolean; signal?: AbortSignal }) => Promise<unknown>;
      invalidate: (sourceUri: string) => void;
      stats: () => { coalescedWaiters: number; hits: number; misses: number };
      dispose: () => Promise<void>;
    };
  };
  check('T03/factory-exported', typeof cacheModule.createNativeSnapshotCache === 'function');
  const cache = cacheModule.createNativeSnapshotCache?.({ backend, maxBytes: 128 * 1024 * 1024, maxEntries: 256 });
  // §8.2 measured counters (no percentages — only what the fixed cases ran).
  perf.resources = 1;
  perf.version = fixtureHash('outer-v0');
  perf.cacheMaxBytes = 128 * 1024 * 1024;
  perf.cacheMaxEntries = 256;
  if (cache) {
    const key = { sourceUri: FIXTURE_LUABND_SOURCE, shape: 'full-document', version: fixtureHash('outer-v0') };

    // V05: 10 concurrent identical cold reads → exactly one underlying parse.
    const before = backend.counters.nativeParseCount;
    const ten = await Promise.all(Array.from({ length: 10 }, () => cache.read(key)));
    check('V05/concurrent-cold-single-parse', backend.counters.nativeParseCount - before === 1,
      `V05：10 个并发相同冷读应只触发 1 次底层解析，实际 ${backend.counters.nativeParseCount - before}`);
    check('V05/waiters-coalesced', cache.stats().coalescedWaiters >= 9);
    perf.concurrentColdReads = 10;
    perf.concurrentColdParses = backend.counters.nativeParseCount - before;
    perf.coalescedWaiters = cache.stats().coalescedWaiters;

    // Hot repeat: 20 more reads must add zero parses (same-version hash check allowed).
    const hotBefore = backend.counters.nativeParseCount;
    const hotInvBefore = backend.counters.containerInventoryCount;
    for (let i = 0; i < 20; i += 1) await cache.read(key);
    check('§8.2/hot-read-zero-reparse', backend.counters.nativeParseCount === hotBefore,
      '同版本热查询的增量 parse 计数必须为 0');
    perf.hotReads = 20;
    perf.hotIncrementalParses = backend.counters.nativeParseCount - hotBefore;
    perf.hotIncrementalInventories = backend.counters.containerInventoryCount - hotInvBefore;

    // V08: outline shape must not satisfy a full-document request.
    const outlineKey = { ...key, shape: 'outline' };
    const outlineBefore = backend.counters.nativeParseCount;
    await cache.read(outlineKey);
    check('V08/outline-not-satisfy-full-document', backend.counters.nativeParseCount > outlineBefore,
      'V08：outline 快照不得命中 full-document 请求');
    perf.outlineReadParses = backend.counters.nativeParseCount - outlineBefore;

    // V06/V07: cancelling one waiter leaves the others; cancelling all aborts.
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const slowKey = { sourceUri: `${FIXTURE_LUABND_SOURCE}#slow`, shape: 'full-document', version: 'v0' };
    backend.addOuter({
      sourceUri: `${FIXTURE_LUABND_SOURCE}#slow`, outerBytes: Buffer.from('slow'), mtimeMs: 1,
      children: [], document: { scripts: [] }
    });
    const p1 = cache.read(slowKey, { signal: controller1.signal }).catch(() => 'cancelled');
    const p2 = cache.read(slowKey, { signal: controller2.signal });
    controller1.abort();
    const r2 = await p2;
    const r1 = await p1;
    check('V06/survivor-waits-succeed', r2 !== 'cancelled' && r1 === 'cancelled',
      `V06：取消一个 waiter 后其余 waiter 仍须成功（r1=${String(r1)} r2=${String(r2)}）`);

    // Invalidation: outer change drops the snapshot; next read re-parses.
    cache.invalidate(FIXTURE_LUABND_SOURCE);
    const afterInvalidate = backend.counters.nativeParseCount;
    await cache.read(key);
    check('V01/invalidation-reparses', backend.counters.nativeParseCount > afterInvalidate,
      '外层变化失效后必须重新解析，不得沿用旧快照');
    perf.invalidatedReparse = backend.counters.nativeParseCount - afterInvalidate;
    perf.cacheHits = cache.stats().hits;
    perf.cacheMisses = cache.stats().misses;

    await cache.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* 2. PARAM same-source read merge (T03 §"合并 PARAM 同源读取")        */
/* ------------------------------------------------------------------ */

const paramMergeSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/param/containerParamEdit.ts'), 'utf8'
);
check('T03/readParamFields-groups-queries',
  /group|byContainer|canonical/i.test(paramMergeSource.split('export async function readParamFields')[1]?.slice(0, 4000) ?? ''),
  '行为未实现：readParamFields 仍逐 query 调用 loadTableRows，未按 canonical container/entry 分组合并（T03）');

/* ------------------------------------------------------------------ */
/* 3. Bypass verification reads survive cache optimization (§8.2)      */
/* ------------------------------------------------------------------ */

backend.freshVerificationRead(FIXTURE_LUABND_SOURCE);
check('§8.2/fresh-verification-counted', backend.counters.freshVerificationReadCount === 1,
  '写前/写后 bypass 原生验证必须单独计数，不得并入可消除的重复读取');
perf.freshVerificationReads = backend.counters.freshVerificationReadCount;

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checks, failures, perf }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true, checks, perf,
    message: 'reference-optimization performance smoke passed (counters are measured, not derived)'
  }, null, 2));
}


