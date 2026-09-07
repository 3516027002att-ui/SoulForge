import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';
import {
  EditorDocumentStore,
  type EditorDocumentDataSource,
  type EditorMutationApplyPort
} from '../editing/editorDocumentStore.js';
import type { NativeDocumentLocator } from '../editing/nativeDocumentLocator.js';
import type {
  EditorContentValue,
  EditorDocumentResult,
  EditorPageItemDto,
  EditorPageQuery
} from '@soulforge/shared';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';

interface SmokeArgs {
  layer?: string;
  executable?: string;
  nativeFixture?: string;
}

interface StaticChunk {
  triangleCount?: number;
  sourceVertexCount?: number;
  sourceIndexCount?: number;
  emittedVertexCount?: number;
  emittedIndexCount?: number;
  positionsBase64?: string;
  indicesBase64?: string;
  sourceVertexIndicesBase64?: string;
  indexElementBytes?: number;
}

interface StaticPage {
  sessionToken?: string;
  nextCursor?: string | null;
  complete?: boolean;
  chunks?: StaticChunk[];
}

interface CacheObservation {
  builds?: number;
  coalesced?: number;
  hits?: number;
  misses?: number;
  peakConcurrentBuilds?: number;
  readyBytes?: number;
  inFlightBytes?: number;
}

function parseArgs(): SmokeArgs {
  const args = process.argv.slice(2);
  const result: SmokeArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) continue;
    if (flag === '--layer') result.layer = value;
    else if (flag === '--bridge-executable') result.executable = value;
    else if (flag === '--native-fixture') result.nativeFixture = value;
    else continue;
    index += 1;
  }
  return result;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`SF15_WAIT_TIMEOUT: ${label}`);
    await new Promise((resolveValue) => setTimeout(resolveValue, 0));
  }
}

function fixtureLocator(): NativeDocumentLocator {
  return {
    locatorId: 'sf15:locator:fmg',
    outerResourceId: 'resource:sf15-fmg',
    outerSourceUri: 'file:///sf15/fmg.msgbnd.dcx',
    sourceVariant: 'overlay',
    expectedOuterRevision: 'scan:sf15',
    expectedOuterHash: 'f'.repeat(64),
    containerRole: 'none',
    layers: [{ layerIndex: 0, formatId: 'fmg', entry: null }],
    leafDocumentStableId: 'loose:fmg'
  };
}

function fmgQuery(): EditorPageQuery {
  return { kind: 'fmg-entries', tableId: 'menu', search: '' };
}

function fmgItem(): EditorPageItemDto {
  return {
    kind: 'fmg-entry',
    tableId: 'menu',
    entryId: '100',
    preview: 'fixture',
    change: 'none'
  };
}

function contentValue(): EditorContentValue {
  return { kind: 'fmg-content', tableId: 'menu', entryId: '100', text: 'fixture' };
}

function assertOk<T>(result: EditorDocumentResult<T>, label: string): T {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
  return result.value;
}

async function runUnit(): Promise<Record<string, unknown>> {
  let pageLoads = 0;
  let contentLoads = 0;
  let applyCalls = 0;
  let now = 10_000;
  const pageGate = deferred<void>();
  const contentGate = deferred<void>();
  const firstApplyGate = deferred<void>();

  const dataSource: EditorDocumentDataSource = {
    loadPage: async () => {
      pageLoads += 1;
      await pageGate.promise;
      return { items: [fmgItem()], nextCursor: null, totalKnown: 1 };
    },
    readContent: async () => {
      contentLoads += 1;
      await contentGate.promise;
      return contentValue();
    }
  };
  const applyPort: EditorMutationApplyPort = {
    apply: async () => {
      applyCalls += 1;
      if (applyCalls === 1) await firstApplyGate.promise;
      return { kind: 'committed', operationId: `op-${applyCalls}` };
    }
  };
  const store = new EditorDocumentStore({
    dataSource,
    applyPort,
    now: () => now,
    ttlMs: 500
  });

  const opened = assertOk(await store.open('owner-a', fixtureLocator()), 'open');
  const pageRequest = {
    documentHandle: opened.documentHandle,
    expectedRevision: opened.revision,
    query: fmgQuery(),
    cursor: null,
    limit: 32
  } as const;

  const pageA = store.page('owner-a', pageRequest);
  const pageB = store.page('owner-a', pageRequest);
  await waitFor(() => pageLoads === 1, 'same page single-flight');
  pageGate.resolve();
  const [pageResultA, pageResultB] = await Promise.all([pageA, pageB]);
  assert.equal(assertOk(pageResultA, 'page A').items.length, 1);
  assert.equal(assertOk(pageResultB, 'page B').items.length, 1);
  assert.equal(pageLoads, 1, 'same snapshot/page must share one data-source call');

  const contentRequest = {
    documentHandle: opened.documentHandle,
    expectedRevision: opened.revision,
    query: { kind: 'fmg-content', tableId: 'menu', entryId: '100' }
  } as const;
  const contentA = store.readContent('owner-a', contentRequest);
  const contentB = store.readContent('owner-a', contentRequest);
  await waitFor(() => contentLoads === 1, 'same content single-flight');
  contentGate.resolve();
  assert.equal(assertOk(await contentA, 'content A').kind, 'fmg-content');
  assert.equal(assertOk(await contentB, 'content B').kind, 'fmg-content');
  assert.equal(contentLoads, 1, 'same snapshot/content must share one data-source call');

  const latePageGate = deferred<void>();
  const lateStore = new EditorDocumentStore({
    dataSource: {
      loadPage: async () => {
        await latePageGate.promise;
        return { items: [fmgItem()], nextCursor: null, totalKnown: 1 };
      },
      readContent: async () => contentValue()
    },
    applyPort,
    now: () => now
  });
  const lateOpened = assertOk(await lateStore.open('owner-a', fixtureLocator()), 'late open');
  const latePage = lateStore.page('owner-a', {
    ...pageRequest,
    documentHandle: lateOpened.documentHandle,
    expectedRevision: lateOpened.revision
  });
  await Promise.resolve();
  assert.equal(assertOk(await lateStore.close('owner-a', lateOpened.documentHandle), 'close').closed, true);
  latePageGate.resolve();
  const lateResult = await latePage;
  assert.equal(lateResult.ok, false);
  assert.equal(lateResult.code, 'expired', 'late page from a closed tab must be discarded');

  const mutationOpened = assertOk(await store.open('owner-a', fixtureLocator()), 'mutation open');
  const mutation = { kind: 'fmg-entry-delete', tableId: 'menu', entryId: '100' } as const;
  const applyA = store.apply('owner-a', {
    documentHandle: mutationOpened.documentHandle,
    expectedRevision: mutationOpened.revision,
    mutation
  });
  await waitFor(() => applyCalls === 1, 'first mutation in flight');
  const applyB = store.apply('owner-a', {
    documentHandle: mutationOpened.documentHandle,
    expectedRevision: mutationOpened.revision,
    mutation
  });
  firstApplyGate.resolve();
  const firstMutation = await applyA;
  const secondMutation = await applyB;
  assert.equal(assertOk(firstMutation, 'first mutation').revision, 'rev:1');
  assert.equal(secondMutation.ok, false);
  assert.equal(secondMutation.code, 'stale-revision');
  assert.equal(applyCalls, 1, 'stale queued mutation must not reach the writer');

  const ownerMismatch = await store.get('owner-b', opened.documentHandle);
  assert.equal(ownerMismatch.ok, false);
  assert.equal(ownerMismatch.code, 'owner-mismatch');
  now += 1_000;
  const expired = await store.get('owner-a', opened.documentHandle);
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'expired');

  return {
    ok: true,
    status: 'passed',
    layer: 'unit',
    checks: [
      'same-snapshot page single-flight',
      'same-snapshot content single-flight',
      'closed-tab late result rejection',
      'serialized mutation lease/revision boundary',
      'owner and TTL rejection'
    ],
    pageLoads,
    contentLoads,
    applyCalls
  };
}

function resolveExecutable(explicit?: string): string {
  const modulePath = fileURLToPath(import.meta.url);
  const repositoryRoot = resolve(dirname(modulePath), '..', '..', '..', '..');
  const candidate = explicit
    ?? process.env.SOULFORGE_BRIDGE_EXECUTABLE
    ?? 'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe';
  const executable = resolve(repositoryRoot, candidate);
  if (!existsSync(executable)) {
    throw new Error(`SF15_ENVIRONMENT_BLOCKED: production Bridge executable not found: ${executable}`);
  }
  return executable;
}

async function resolveMapFixture(explicitPath?: string): Promise<string | undefined> {
  try {
    const resolved = await resolveNativeFixture(
      explicitPath,
      'map-primary',
      '../../mods/map/m10_00_00_00/m10_00_00_00_600050.mapbnd.dcx'
    );
    return existsSync(resolved) ? resolved : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!explicitPath && (message.includes('NATIVE_FIXTURE_ROLE_MISSING')
      || message.includes('ENOENT') || message.includes('cannot find'))) return undefined;
    throw error;
  }
}

function diagnosticCodes(result: { diagnostics?: Array<{ code?: string }> }): string[] {
  return (result.diagnostics ?? [])
    .map((item) => item.code)
    .filter((code): code is string => typeof code === 'string');
}

function cacheObservation(result: { diagnostics?: Array<{ code?: string; details?: unknown }> }): CacheObservation | undefined {
  const diagnostic = result.diagnostics?.find((item) => item.code === 'MAP_RESOURCE_CACHE_SNAPSHOT');
  return diagnostic?.details && typeof diagnostic.details === 'object'
    ? diagnostic.details as CacheObservation
    : undefined;
}

async function readStaticPage(
  executable: string,
  filePath: string,
  modelName: string,
  workspaceSessionId: string,
  ownerLeaseId: string,
  sessionToken?: string,
  cursor?: string
): Promise<{ data: StaticPage; diagnostics: Array<{ code?: string; details?: unknown }>; parseStatus: string }> {
  const result = await runBridge<StaticPage>({
    bridgeExecutablePath: executable,
    command: 'read-map-static-geometry',
    filePath,
    allowedRoots: [dirname(filePath)],
    ...(process.env.SOULFORGE_SEKIRO_GAME_ROOT
      ? { oodleRuntimeRoot: process.env.SOULFORGE_SEKIRO_GAME_ROOT }
      : {}),
    workspaceSessionId,
    timeoutMs: 180_000,
    maxConcurrency: 2,
    commandOptions: {
      modelName,
      ownerLeaseId,
      resourceCacheKey: 'sf15-smoke',
      ...(sessionToken ? { sessionToken } : {}),
      ...(cursor ? { cursor } : {})
    }
  });
  return {
    data: (result.data ?? {}) as StaticPage,
    diagnostics: result.diagnostics,
    parseStatus: result.parseStatus
  };
}

async function runNative(executable: string, explicitFixture?: string): Promise<Record<string, unknown>> {
  const fixture = await resolveMapFixture(explicitFixture);
  if (!fixture) {
    return {
      ok: true,
      status: 'skipped',
      layer: 'native',
      code: 'SF15_NATIVE_FIXTURE_UNAVAILABLE',
      message: '未找到登记的 map-primary 或 legacy mapbnd 语料。'
    };
  }

  const workspace = await createSmokeWorkspace('audit-sf15-native');
  try {
    const inventory = await runBridge<{ entries?: Array<{ name?: string }> }>({
      bridgeExecutablePath: executable,
      command: 'list-bnd4-entries',
      filePath: fixture,
      allowedRoots: [dirname(fixture)],
      ...(process.env.SOULFORGE_SEKIRO_GAME_ROOT
        ? { oodleRuntimeRoot: process.env.SOULFORGE_SEKIRO_GAME_ROOT }
        : {}),
      workspaceSessionId: 'sf15-native-inventory',
      timeoutMs: 180_000,
      commandOptions: { includeContentHashes: true }
    });
    if (inventory.parseStatus === 'failed') {
      const codes = diagnosticCodes(inventory);
      if (codes.some((code) => code.includes('OODLE') || code.includes('KRAK'))) {
        return { ok: true, status: 'skipped', layer: 'native', code: 'SF15_NATIVE_OODLE_UNAVAILABLE', diagnostics: inventory.diagnostics };
      }
      throw new Error(`SF15_NATIVE_INVENTORY_FAILED: ${JSON.stringify(inventory.diagnostics)}`);
    }
    const modelName = inventory.data?.entries?.find((entry) => /\.flver$/i.test(entry.name ?? ''))?.name;
    assert.ok(modelName, 'map-primary BND4 has no FLVER entry');

    const workspaceSessionId = 'sf15-native-cache';
    const concurrent = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      readStaticPage(executable, fixture, modelName!, workspaceSessionId, `sf15-owner-${index}`)
    ));
    for (const result of concurrent) {
      assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result.diagnostics));
      assert.ok((result.data.chunks?.length ?? 0) <= 1);
      assert.ok(result.data.chunks?.[0]?.sourceVertexCount && result.data.chunks[0].sourceIndexCount);
    }
    const observations = concurrent.map(cacheObservation).filter((item): item is CacheObservation => item !== undefined);
    assert.ok(observations.length > 0, 'cache observation was not returned by production daemon');
    const finalCache = observations[observations.length - 1]!;
    assert.equal(finalCache.builds, 1, 'ten same-key requests must build geometry metadata once');
    assert.ok((finalCache.peakConcurrentBuilds ?? 0) <= 2, 'native builds exceeded configured concurrency');
    assert.ok((finalCache.readyBytes ?? 0) > 0, 'resident byte accounting must be non-zero');

    const first = concurrent[0]!;
    if (!first.data.complete && first.data.sessionToken && first.data.nextCursor) {
      const second = await readStaticPage(
        executable,
        fixture,
        modelName!,
        workspaceSessionId,
        'sf15-owner-0',
        first.data.sessionToken,
        first.data.nextCursor
      );
      assert.notEqual(second.parseStatus, 'failed', JSON.stringify(second.diagnostics));
    }

    return {
      ok: true,
      status: 'passed',
      layer: 'native',
      fixture,
      modelName,
      concurrentRequests: concurrent.length,
      cache: finalCache,
      checks: [
        'production map resource cache single-flight',
        'workspace-scoped cache key and byte accounting',
        'max native build concurrency',
        'session lease cursor resume'
      ]
    };
  } finally {
    await workspace.dispose();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.layer !== 'unit' && args.layer !== 'native') {
    throw new Error('SF15_INVALID_LAYER: expected --layer unit or --layer native.');
  }
  try {
    const result = args.layer === 'unit'
      ? await runUnit()
      : await runNative(resolveExecutable(args.executable), args.nativeFixture);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
