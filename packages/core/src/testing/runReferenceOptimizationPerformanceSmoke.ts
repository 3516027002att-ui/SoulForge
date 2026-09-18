/**
 * Reference-optimization performance smoke.
 *
 * Uses fixture port counters + production NativeSnapshotCache when present:
 * - cold parse once
 * - hot reads → 0 incremental parse
 * - concurrent cold coalesced → 1 parse
 * - bypass verification still increments freshVerificationReadCount
 *
 * Counters live on the port / cache object — never hand-counted in production paths.
 */
import { pathToFileURL } from 'node:url';
import {
  createFixtureNativePorts,
  fixtureHash,
  type FixtureNativePorts
} from './referenceOptimizationFixtures.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

function failMissing(symbol: string): never {
  const message = `behavior_not_implemented: ${symbol}`;
  console.error(JSON.stringify({
    ok: false,
    code: 'BEHAVIOR_NOT_IMPLEMENTED',
    symbol,
    message,
    checks
  }, null, 2));
  process.exitCode = 1;
  throw new Error(message);
}

type DynamicModule = Record<string, unknown>;

async function loadModule(specifier: string): Promise<DynamicModule | null> {
  try {
    return (await import(specifier)) as DynamicModule;
  } catch {
    return null;
  }
}

function requireFn(mod: DynamicModule | null, name: string): (...args: unknown[]) => unknown {
  if (!mod) failMissing(name);
  const value = mod[name];
  if (typeof value !== 'function') failMissing(name);
  return value as (...args: unknown[]) => unknown;
}

interface SnapshotCacheLike {
  load: <T>(input: {
    key: string;
    version: Record<string, unknown>;
    bypass?: boolean;
    signal?: AbortSignal;
    loader: (signal: AbortSignal) => Promise<T>;
    store: (data: T) => Record<string, unknown>;
  }) => Promise<T>;
  get: (key: string, version: Record<string, unknown>) => unknown;
  counters: Record<string, number>;
  size: () => number;
  dispose: () => Promise<void>;
}

function fixtureVersion(label: string): Record<string, unknown> {
  return {
    outerFileHash: fixtureHash(`perf-${label}-outer`),
    childHash: fixtureHash(`perf-${label}-child`),
    dataHash: fixtureHash(`perf-${label}-data`),
    generation: 0,
    readerSchema: 'fixture-reader@1',
    metadataSchema: 'fixture-meta@1'
  };
}

function storeShape(sourceKey: string): (data: unknown) => Record<string, unknown> {
  return (data) => ({
    sourceKey,
    shape: 'full-document',
    complete: true,
    bytes: Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8')
  });
}

interface FixturePortCounterSnapshot {
  nativeParseCount: number;
  childExtractionCount: number;
  containerInventoryCount: number;
  coalescedWaiterCount: number;
  freshVerificationReadCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
}

async function runPerformanceLegs(cacheMod: DynamicModule | null, ports: FixtureNativePorts): Promise<Record<string, number>> {
  const createNativeSnapshotCache = requireFn(cacheMod, 'createNativeSnapshotCache');
  const createNativeSnapshotCounters = requireFn(cacheMod, 'createNativeSnapshotCounters');

  // Production counters live on the cache/port object.
  const productionCounters = createNativeSnapshotCounters() as {
    nativeParseCount: number;
    childExtractionCount: number;
    containerInventoryCount: number;
    coalescedWaiterCount: number;
    cacheHitCount: number;
    cacheMissCount: number;
    freshVerificationReadCount: number;
  };
  const cache = createNativeSnapshotCache({ counters: productionCounters }) as SnapshotCacheLike;

  const key = JSON.stringify(['fixture-ws-perf', 'gameparam://fixture/NpcParam', [], '', '', 'full-document', '']);
  const sourceKey = JSON.stringify(['fixture-ws-perf', 'gameparam://fixture/NpcParam', [], '', '']);
  const version = fixtureVersion('baseline');

  // ── Cold parse once ──
  const coldLoader = async (): Promise<{ rows: number[]; label: string }> => {
    // Port-owned parse counter (what the loader actually does).
    return await ports.snapshot.parseLoader(async () => {
      await delay(5);
      return { rows: [91000100, 91000101], label: 'fixture-cold' };
    });
  };

  const cold = await cache.load({
    key,
    version,
    loader: coldLoader,
    store: storeShape(sourceKey)
  });
  record(
    'cold_parse_once',
    cold.label === 'fixture-cold' && ports.counters.nativeParseCount === 1,
    JSON.stringify({ portParse: ports.counters.nativeParseCount, cacheCounters: productionCounters })
  );

  // ── Hot reads: 0 incremental parse ──
  const parseBeforeHot = ports.counters.nativeParseCount;
  const hot1 = await cache.load({
    key,
    version,
    loader: async () => {
      return await ports.snapshot.parseLoader(async () => ({ rows: [], label: 'should-not-run' }));
    },
    store: storeShape(sourceKey)
  });
  const hot2 = await cache.load({
    key,
    version,
    loader: async () => {
      return await ports.snapshot.parseLoader(async () => ({ rows: [], label: 'should-not-run-2' }));
    },
    store: storeShape(sourceKey)
  });
  const parseAfterHot = ports.counters.nativeParseCount;
  record(
    'hot_reads_zero_incremental_parse',
    hot1.label === 'fixture-cold' && hot2.label === 'fixture-cold' && parseAfterHot === parseBeforeHot,
    JSON.stringify({
      parseBeforeHot,
      parseAfterHot,
      cacheHitCount: productionCounters.cacheHitCount,
      cacheMissCount: productionCounters.cacheMissCount
    })
  );

  // ── Concurrent cold coalesced to 1 parse ──
  ports.reset();
  const coalescedKey = JSON.stringify(['fixture-ws-perf', 'gameparam://fixture/ColdCoalesce', [], '', '', 'full-document', 'coalesce']);
  const coalescedSource = JSON.stringify(['fixture-ws-perf', 'gameparam://fixture/ColdCoalesce', [], '', '']);
  const coalescedVersion = fixtureVersion('coalesce');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const coalescedLoader = async (): Promise<{ label: string }> => {
    return await ports.snapshot.parseLoader(async () => {
      await gate;
      return { label: 'fixture-coalesced' };
    });
  };

  const concurrent = [
    cache.load({ key: coalescedKey, version: coalescedVersion, loader: coalescedLoader, store: storeShape(coalescedSource) }),
    cache.load({ key: coalescedKey, version: coalescedVersion, loader: coalescedLoader, store: storeShape(coalescedSource) }),
    cache.load({ key: coalescedKey, version: coalescedVersion, loader: coalescedLoader, store: storeShape(coalescedSource) })
  ];
  // Let all three attach to the inflight promise, then open the gate.
  await delay(10);
  release();
  const concurrentResults = await Promise.all(concurrent);
  const coalescedParse = ports.counters.nativeParseCount;
  const coalescedWaiters = productionCounters.coalescedWaiterCount;
  record(
    'concurrent_cold_coalesced_to_one_parse',
    coalescedParse === 1
      && concurrentResults.every((r) => r.label === 'fixture-coalesced')
      && coalescedWaiters >= 1,
    JSON.stringify({ portParse: coalescedParse, coalescedWaiters, cacheCounters: productionCounters })
  );

  // ── Bypass verification still increments freshVerificationReadCount ──
  const freshBefore = productionCounters.freshVerificationReadCount;
  const parseBeforeBypass = ports.counters.nativeParseCount;
  await cache.load({
    key: coalescedKey,
    version: coalescedVersion,
    bypass: true,
    loader: async () => {
      return await ports.snapshot.parseLoader(async () => ({ label: 'fixture-fresh-verify' }));
    },
    store: storeShape(coalescedSource)
  });
  const freshAfter = productionCounters.freshVerificationReadCount;
  const parseAfterBypass = ports.counters.nativeParseCount;
  record(
    'bypass_verification_increments_fresh_verification_reads',
    freshAfter === freshBefore + 1 && parseAfterBypass === parseBeforeBypass + 1,
    JSON.stringify({
      freshBefore,
      freshAfter,
      parseBeforeBypass,
      parseAfterBypass,
      cacheCounters: productionCounters
    })
  );

  const portSnapshot: FixturePortCounterSnapshot = {
    nativeParseCount: ports.counters.nativeParseCount,
    childExtractionCount: ports.counters.childExtractionCount,
    containerInventoryCount: ports.counters.containerInventoryCount,
    coalescedWaiterCount: ports.counters.coalescedWaiterCount,
    freshVerificationReadCount: ports.counters.freshVerificationReadCount,
    cacheHitCount: ports.counters.cacheHitCount,
    cacheMissCount: ports.counters.cacheMissCount
  };

  await cache.dispose().catch(() => undefined);

  // Print counters as required by the smoke contract.
  return {
    ...portSnapshot,
    productionNativeParseCount: productionCounters.nativeParseCount,
    productionCoalescedWaiterCount: productionCounters.coalescedWaiterCount,
    productionFreshVerificationReadCount: productionCounters.freshVerificationReadCount,
    productionCacheHitCount: productionCounters.cacheHitCount,
    productionCacheMissCount: productionCounters.cacheMissCount
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function runReferenceOptimizationPerformanceSmoke(): Promise<void> {
  const cacheMod = await loadModule('../runtime/nativeSnapshotCache.js');
  const ports = createFixtureNativePorts();

  // Production cache/service must exist — fail closed if missing.
  requireFn(cacheMod, 'createNativeSnapshotCache');
  requireFn(cacheMod, 'createNativeSnapshotCounters');
  requireFn(cacheMod, 'snapshotKey');
  if (!cacheMod || typeof cacheMod.NativeSnapshotCache !== 'function') {
    failMissing('NativeSnapshotCache');
  }

  const counters = await runPerformanceLegs(cacheMod, ports);

  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    smoke: 'reference-optimization-performance',
    checks,
    counters,
    failedCount: failed.length
  }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReferenceOptimizationPerformanceSmoke().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('behavior_not_implemented:')) {
      return;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
}
