/**
 * Reference-query smoke: production decode + service + projection behavior.
 *
 * Missing production symbols fail closed with `behavior_not_implemented: <symbol>`.
 * Port counters live on fixture ports — never hand-count production internals.
 */
import { pathToFileURL } from 'node:url';
import { createFixtureNativePorts } from './referenceOptimizationFixtures.js';

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
  console.error(JSON.stringify({ ok: false, code: 'BEHAVIOR_NOT_IMPLEMENTED', symbol, message, checks }, null, 2));
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

function requireCtor(mod: DynamicModule | null, name: string): new (...args: never[]) => unknown {
  if (!mod) failMissing(name);
  const value = mod[name];
  if (typeof value !== 'function') failMissing(name);
  return value as new (...args: never[]) => unknown;
}

async function resolveDecode(): Promise<(raw: unknown) => { ok: boolean; code?: string; value?: unknown }> {
  const shared = await loadModule('@soulforge/shared');
  const decode = requireFn(shared, 'decodeReferenceQueryInput');
  return decode as (raw: unknown) => { ok: boolean; code?: string; value?: unknown };
}

async function loadCoreModule(relative: string): Promise<DynamicModule | null> {
  return loadModule(relative);
}

async function testDecodeRejectsUriPlusTarget(decode: (raw: unknown) => { ok: boolean; code?: string }): Promise<void> {
  const result = decode({
    uri: 'gameparam://fixture/NpcParam',
    target: { domain: 'param', sourceUri: 'gameparam://fixture/NpcParam', entryIndex: 0, rowId: 1 },
    direction: 'both',
    detail: 'context'
  });
  record(
    'decode_rejects_uri_plus_target',
    result.ok === false && (result.code === 'REFERENCE_TARGET_CONFLICT' || result.code === 'REFERENCE_INPUT_INVALID'),
    result.ok ? 'uri+target was accepted' : `code=${result.code}`
  );
}

async function testDecodeRejectsUnsafeIds(decode: (raw: unknown) => { ok: boolean; code?: string }): Promise<void> {
  const nanRow = decode({
    target: { domain: 'param', sourceUri: 'gameparam://fixture/NpcParam', entryIndex: 0, rowId: Number.NaN },
    direction: 'both',
    detail: 'context'
  });
  const unsafeRow = decode({
    target: { domain: 'param', sourceUri: 'gameparam://fixture/NpcParam', entryIndex: 0, rowId: 2 ** 53 },
    direction: 'both',
    detail: 'context'
  });
  const unsafeEvent = decode({
    target: { domain: 'emevd', sourceUri: 'emevd://fixture/a.emevd', eventId: Number.NaN },
    direction: 'both',
    detail: 'context'
  });
  const nanDepth = decode({
    uri: 'gameparam://fixture/NpcParam',
    depth: Number.NaN,
    direction: 'both',
    detail: 'context'
  });
  const allRejected = !nanRow.ok && !unsafeRow.ok && !unsafeEvent.ok && !nanDepth.ok;
  record(
    'decode_rejects_nan_and_unsafe_integer_ids',
    allRejected,
    JSON.stringify({ nanRow: nanRow.code, unsafeRow: unsafeRow.code, unsafeEvent: unsafeEvent.code, nanDepth: nanDepth.code })
  );
}

interface ServiceLike {
  query: (input: unknown) => Promise<{
    resolution: string;
    target?: { workspaceId?: string; domain?: string; objectKey?: string; rowId?: number };
    relations?: unknown[];
    coverage?: { predicateComplete?: boolean; allowsNegativeClaim?: boolean; domains?: Array<{ status?: string }> };
  }>;
}

async function testPreciseTargetRelationsPage(serviceMod: DynamicModule | null): Promise<void> {
  const createService = requireFn(serviceMod, 'createReferenceQueryService');
  const ports = createFixtureNativePorts();

  const fixtureTarget = {
    workspaceId: 'fixture-ws-ref',
    domain: 'param',
    sourceUri: 'gameparam://fixture/NpcParam',
    outerId: 'gameparam://fixture/NpcParam',
    childChain: ['FixtureNpcParam'],
    namespace: 'FixtureNpcParam',
    objectKey: 'FixtureNpcParam#91000100',
    rowId: 91000100,
    entryIndex: 0,
    entryName: 'FixtureNpcParam',
    // Host-resolved param facts the production param provider consumes.
    fieldValues: { spEffectId0: 9030, spEffectType: 1 },
    metadataByField: {
      spEffectId0: { refs: 'FixtureSpEffectParam(spEffectType=1)' }
    },
    containerEntries: ['FixtureNpcParam', 'FixtureSpEffectParam']
  };

  // Prefer production provider registry + param provider when available.
  const registryMod = await loadCoreModule('../references/referenceProviderRegistry.js');
  const paramProviderMod = await loadCoreModule('../references/paramReferenceProvider.js');
  let providerRegistry: unknown;
  if (
    registryMod
    && typeof registryMod.createReferenceProviderRegistry === 'function'
    && paramProviderMod
    && typeof paramProviderMod.createParamReferenceProvider === 'function'
  ) {
    providerRegistry = (registryMod.createReferenceProviderRegistry as (...args: unknown[]) => unknown)([
      (paramProviderMod.createParamReferenceProvider as (...args: unknown[]) => unknown)()
    ]);
  }

  const service = createService({
    principal: 'fixture-principal',
    workspaceId: 'fixture-ws-ref',
    workspaceSession: {},
    editSession: {},
    snapshotCache: {},
    versionClock: { current: () => 0, bump: () => 1 },
    nativeReadProofs: {},
    providerPorts: ports.providerPorts,
    ...(providerRegistry ? { providerRegistry } : {}),
    resolveTarget: async () => ({
      resolution: 'resolved',
      target: fixtureTarget,
      version: { outerFileHash: 'a'.repeat(64), generation: 0 }
    }),
    readTargetFields: async () => ({
      identity: fixtureTarget,
      version: { outerFileHash: 'a'.repeat(64), generation: 0 },
      fields: [
        { fieldId: 'spEffectId0', value: 9030 },
        { fieldId: 'spEffectType', value: 1 }
      ],
      completeness: 'complete'
    })
  }) as ServiceLike;

  const page = await service.query({
    direction: 'both',
    detail: 'context',
    depth: 2,
    limit: 8,
    includeHypotheses: false,
    fieldIds: ['spEffectId0', 'spEffectType'],
    target: {
      domain: 'param',
      sourceUri: fixtureTarget.sourceUri,
      entryIndex: 0,
      entryName: 'FixtureNpcParam',
      rowId: 91000100
    }
  });

  const hasIdentity = page.resolution === 'resolved'
    && typeof page.target?.objectKey === 'string'
    && page.target.objectKey.includes('91000100')
    && page.target.domain === 'param';
  const relationCount = page.relations?.length ?? -1;
  const relationKinds = Array.isArray(page.relations)
    ? page.relations.map((r) => (r as { relationKind?: string }).relationKind)
    : [];
  record(
    'precise_target_returns_relations_page_with_identity',
    hasIdentity && relationCount >= 1,
    JSON.stringify({
      resolution: page.resolution,
      objectKey: page.target?.objectKey,
      relationCount,
      relationKinds
    })
  );
}

async function testAmbiguousQueryDoesNotDeepRead(serviceMod: DynamicModule | null): Promise<void> {
  const createService = requireFn(serviceMod, 'createReferenceQueryService');
  const ports = createFixtureNativePorts();
  const candidates = [0, 1, 2].map((i) => ({
    identity: {
      workspaceId: 'fixture-ws-ref',
      domain: 'param',
      sourceUri: `gameparam://fixture/Candidate${i}`,
      outerId: `gameparam://fixture/Candidate${i}`,
      childChain: [`Candidate${i}`],
      namespace: `Candidate${i}`,
      objectKey: `Candidate${i}#1`,
      rowId: 1
    },
    discriminators: { fixtureIndex: i }
  }));

  const service = createService({
    principal: 'fixture-principal',
    workspaceId: 'fixture-ws-ref',
    workspaceSession: {},
    editSession: {},
    snapshotCache: {},
    versionClock: { current: () => 0, bump: () => 1 },
    nativeReadProofs: {},
    providerPorts: ports.providerPorts,
    resolveTarget: async () => ({
      resolution: 'ambiguous',
      candidates,
      diagnostics: [{
        code: 'REFERENCE_TARGET_AMBIGUOUS',
        message: 'fixture ambiguous candidates',
        severity: 'error'
      }]
    })
  }) as ServiceLike;

  const page = await service.query({
    query: 'fixture ambiguous boss',
    domain: 'param',
    direction: 'both',
    detail: 'context',
    depth: 3,
    limit: 8,
    includeHypotheses: false
  });

  const noDeepRead = ports.counters.eventReadCount === 0 && ports.counters.scriptReadCount === 0;
  record(
    'ambiguous_query_does_not_deep_read_candidates',
    page.resolution === 'ambiguous' && noDeepRead && (page.relations?.length ?? 0) === 0,
    JSON.stringify({
      resolution: page.resolution,
      eventReadCount: ports.counters.eventReadCount,
      scriptReadCount: ports.counters.scriptReadCount,
      relationCount: page.relations?.length ?? -1
    })
  );
}

async function testEmptyCoverageNotNotFound(projectionMod: DynamicModule | null): Promise<void> {
  if (!projectionMod || typeof projectionMod.incompleteCoverage !== 'function') {
    failMissing('incompleteCoverage');
  }
  const incompleteCoverage = projectionMod.incompleteCoverage as (input: unknown) => {
    predicateComplete: boolean;
    allowsNegativeClaim: boolean;
    domains: Array<{ domain: string; status: string }>;
    unscannedSources?: string[];
  };
  const coverage = incompleteCoverage({ scopeDescription: 'fixture-unscanned-scope' });
  const unscanned = coverage.domains?.some((d) => d.status === 'unscanned') === true;
  const noNegative = coverage.allowsNegativeClaim === false && coverage.predicateComplete === false;
  record(
    'empty_unscanned_coverage_does_not_claim_not_found',
    unscanned && noNegative,
    JSON.stringify({
      predicateComplete: coverage.predicateComplete,
      allowsNegativeClaim: coverage.allowsNegativeClaim,
      domains: coverage.domains
    })
  );

  // Service path: not_found with unscanned coverage must keep allowsNegativeClaim false.
  const serviceMod = await loadCoreModule('../references/referenceQueryService.js');
  const createService = requireFn(serviceMod, 'createReferenceQueryService');
  const ports = createFixtureNativePorts();
  const service = createService({
    principal: 'fixture-principal',
    workspaceId: 'fixture-ws-ref',
    workspaceSession: {},
    editSession: {},
    snapshotCache: {},
    versionClock: { current: () => 0, bump: () => 1 },
    nativeReadProofs: {},
    providerPorts: ports.providerPorts,
    resolveTarget: async () => ({
      resolution: 'not_found',
      diagnostics: [{
        code: 'REFERENCE_COVERAGE_INCOMPLETE',
        message: 'fixture unscanned',
        severity: 'warning'
      }],
      coverage: {
        scopeDescription: 'fixture-empty',
        predicateComplete: false,
        domains: [{ domain: 'workspace', status: 'unscanned' }],
        unresolvedSources: [],
        failedSources: [],
        unscannedSources: ['fixture://unscanned'],
        allowsNegativeClaim: false
      }
    })
  }) as ServiceLike;
  const page = await service.query({
    uri: 'gameparam://fixture/Unscanned',
    direction: 'both',
    detail: 'context',
    depth: 1,
    limit: 4,
    includeHypotheses: false
  });
  const coverage2 = page.coverage;
  const stillNoNotFoundClaim = page.resolution !== 'not_found'
    || coverage2?.allowsNegativeClaim === false;
  record(
    'service_unscanned_path_preserves_coverage_limits',
    stillNoNotFoundClaim && (coverage2?.allowsNegativeClaim === false || page.resolution === 'not_found'),
    JSON.stringify({
      resolution: page.resolution,
      allowsNegativeClaim: coverage2?.allowsNegativeClaim,
      predicateComplete: coverage2?.predicateComplete
    })
  );
}

export async function runReferenceQuerySmoke(): Promise<void> {
  const decode = await resolveDecode();
  await testDecodeRejectsUriPlusTarget(decode);
  await testDecodeRejectsUnsafeIds(decode);

  const serviceMod = await loadCoreModule('../references/referenceQueryService.js');
  const projectionMod = await loadCoreModule('../references/referencePageProjection.js');

  // Service/projection symbols are required — fail closed if missing.
  requireFn(serviceMod, 'createReferenceQueryService');
  requireFn(serviceMod, 'ReferenceQueryService');
  requireFn(projectionMod, 'projectReferencePage');
  requireFn(projectionMod, 'incompleteCoverage');
  requireCtor(serviceMod, 'ReferenceQueryService');

  await testPreciseTargetRelationsPage(serviceMod);
  await testAmbiguousQueryDoesNotDeepRead(serviceMod);
  await testEmptyCoverageNotNotFound(projectionMod);

  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    smoke: 'reference-query',
    checks,
    failedCount: failed.length
  }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReferenceQuerySmoke().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('behavior_not_implemented:')) {
      // already printed structured fail
      return;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
}
