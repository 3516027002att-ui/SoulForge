import type {
  RuntimeCapability,
  RuntimeDiagnostic,
  RuntimeLaunchSession,
  RuntimeOperationResult,
  RuntimeProfileRef
} from '../runtime/gameRuntimeAdapter.js';
import {
  Me3RuntimeAdapter,
  type Me3DetectionGatewayResult,
  type Me3RuntimeGateway,
  type Me3VersionPolicy,
  type Me3VersionProbeProcessResult,
  type Me3VersionProbeRequest
} from '../runtime/me3RuntimeAdapter.js';

const FIXTURE_POLICY: Me3VersionPolicy = {
  policyId: 'fixture.me3-v0_12_1',
  supportedVersions: ['0.12.1']
};

class FakeMe3RuntimeGateway implements Me3RuntimeGateway {
  readonly requests: Me3VersionProbeRequest[] = [];

  constructor(
    private readonly handler: (
      request: Me3VersionProbeRequest
    ) => unknown | Promise<unknown>
  ) {}

  async probeVersion(request: Me3VersionProbeRequest): Promise<unknown> {
    this.requests.push(request);
    return this.handler(request);
  }
}

async function main(): Promise<void> {
  const observed: unknown[] = [];

  const invalidTimeoutGateway = fixedGateway(notFound());
  const invalidTimeout = await new Me3RuntimeAdapter({ gateway: invalidTimeoutGateway })
    .detect({ timeoutMs: 0 });
  expectCapability(invalidTimeout, 'probe-failed', 'ME3_DETECTION_TIMEOUT_INVALID');
  expectRequestCount(invalidTimeoutGateway, 0, 'invalid timeout');
  observed.push(invalidTimeout);

  const oversizedTimeout = await new Me3RuntimeAdapter({ gateway: invalidTimeoutGateway })
    .detect({ timeoutMs: Number.MAX_SAFE_INTEGER });
  expectCapability(oversizedTimeout, 'probe-failed', 'ME3_DETECTION_TIMEOUT_INVALID');
  expectRequestCount(invalidTimeoutGateway, 0, 'oversized timeout');
  observed.push(oversizedTimeout);

  const preCancelledController = new AbortController();
  preCancelledController.abort('fixture-pre-cancel');
  const preCancelledGateway = fixedGateway(probed(successfulProbe()));
  const preCancelled = await new Me3RuntimeAdapter({ gateway: preCancelledGateway }).detect({
    timeoutMs: 500,
    signal: preCancelledController.signal
  });
  expectCapability(preCancelled, 'cancelled', 'ME3_DETECTION_CANCELLED');
  expectRequestCount(preCancelledGateway, 0, 'pre-cancelled request');
  observed.push(preCancelled);

  const missingGateway = fixedGateway(notFound());
  const missing = await new Me3RuntimeAdapter({ gateway: missingGateway })
    .detect({ timeoutMs: 500 });
  expectCapability(missing, 'not-found', 'ME3_NOT_FOUND');
  expectFixedRequest(missingGateway.requests[0], 500);
  observed.push(missing);

  const ambiguousGateway = fixedGateway({
    status: 'ambiguous',
    candidateCount: 2,
    discoverySources: ['registry', 'path']
  });
  const ambiguous = await new Me3RuntimeAdapter({ gateway: ambiguousGateway })
    .detect({ timeoutMs: 500 });
  expectCapability(ambiguous, 'ambiguous', 'ME3_INSTALLATION_AMBIGUOUS');
  observed.push(ambiguous);

  const invalidGatewayResponses: Array<[string, unknown]> = [
    ['null', null],
    ['unknown-status', { status: 'ready' }],
    ['non-array-sources', { status: 'not-found', checkedSources: 'C:\\private\\me3.exe' }],
    ['invalid-candidate-count', {
      status: 'ambiguous',
      candidateCount: 0,
      discoverySources: ['registry']
    }],
    ['path-bearing-source', {
      status: 'probed',
      discoverySource: 'C:\\private\\me3.exe',
      process: successfulProbe()
    }],
    ['non-string-stdout', {
      status: 'probed',
      discoverySource: 'registry',
      process: { ...successfulProbe(), stdout: 42 }
    }],
    ['path-bearing-spawn-failure', {
      status: 'probed',
      discoverySource: 'registry',
      process: { ...successfulProbe(), spawnFailure: 'C:\\private\\me3.exe' }
    }],
    ['unknown-top-level-key', {
      ...notFound(),
      executablePath: 'C:\\private\\me3.exe'
    }],
    ['unknown-process-key', {
      status: 'probed',
      discoverySource: 'registry',
      process: { ...successfulProbe(), pid: 123 }
    }],
    ['oversized-stdout', {
      status: 'probed',
      discoverySource: 'registry',
      process: { ...successfulProbe(), stdout: 'x'.repeat(1025) }
    }]
  ];
  for (const [label, invalidResponse] of invalidGatewayResponses) {
    const rejected = await detect(invalidResponse, FIXTURE_POLICY);
    expectCapability(rejected, 'probe-failed', 'ME3_GATEWAY_RESPONSE_INVALID');
    assertNoAuthorityLeak(rejected);
    observed.push(rejected);
    if (JSON.stringify(rejected).includes('private')) {
      throw new Error(`gateway response leaked rejected fixture content: ${label}`);
    }
  }

  const policyUnset = await detect(probed(successfulProbe()));
  expectCapability(policyUnset, 'policy-unset', 'ME3_VERSION_POLICY_UNSET');
  expectDiagnostic(policyUnset.diagnostics, 'ME3_EXIT_ZERO_UNVERIFIED');
  observed.push(policyUnset);

  const malformedPolicies: Array<[string, unknown]> = [
    ['null-versions', { policyId: 'fixture.invalid', supportedVersions: null }],
    ['sparse-versions', {
      policyId: 'fixture.invalid',
      supportedVersions: new Array<string>(1)
    }],
    ['duplicate-versions', {
      policyId: 'fixture.invalid',
      supportedVersions: ['0.12.1', '0.12.1']
    }],
    ['unknown-key', { ...FIXTURE_POLICY, executablePath: 'C:\\private\\me3.exe' }],
    ['throwing-getter', Object.defineProperty(
      { policyId: 'fixture.invalid' },
      'supportedVersions',
      { enumerable: true, get: () => { throw new Error('private policy value'); } }
    )]
  ];
  for (const [label, malformedPolicy] of malformedPolicies) {
    const rejectedPolicy = await detect(
      probed(successfulProbe()),
      malformedPolicy as Me3VersionPolicy
    );
    expectCapability(rejectedPolicy, 'policy-unset', 'ME3_VERSION_POLICY_INVALID');
    expectDiagnostic(rejectedPolicy.diagnostics, 'ME3_EXIT_ZERO_UNVERIFIED');
    assertNoAuthorityLeak(rejectedPolicy);
    if (JSON.stringify(rejectedPolicy).includes('private')) {
      throw new Error(`invalid policy leaked rejected fixture content: ${label}`);
    }
    observed.push(rejectedPolicy);
  }

  const supportedGateway = fixedGateway(probed(successfulProbe()));
  const supported = await new Me3RuntimeAdapter({
    gateway: supportedGateway,
    versionPolicy: FIXTURE_POLICY
  }).detect({ timeoutMs: 500 });
  expectCapability(supported, 'exit-zero-unverified', 'ME3_EXIT_ZERO_UNVERIFIED');
  if (!supported.detected || !supported.compatible || supported.detectedVersion !== '0.12.1') {
    throw new Error(`expected compatible but unverified version probe: ${JSON.stringify(supported)}`);
  }
  if (supported.canPrepareProfile || supported.canLaunch) {
    throw new Error('contract-only detection must not enable profile generation or launch');
  }
  observed.push(supported);

  const unsupported = await detect(
    probed(successfulProbe({ stdout: 'me3 0.11.0\n' })),
    FIXTURE_POLICY
  );
  expectCapability(unsupported, 'unsupported-version', 'ME3_VERSION_UNSUPPORTED');
  observed.push(unsupported);

  const malformed = await detect(
    probed(successfulProbe({ stdout: 'C:\\private\\me3.exe 0.12.1\n' })),
    FIXTURE_POLICY
  );
  expectCapability(malformed, 'malformed-version', 'ME3_VERSION_OUTPUT_MALFORMED');
  observed.push(malformed);

  const truncated = await detect(
    probed(successfulProbe({ stdoutTruncated: true })),
    FIXTURE_POLICY
  );
  expectCapability(truncated, 'malformed-version', 'ME3_VERSION_OUTPUT_MALFORMED');
  observed.push(truncated);

  const nonzero = await detect(probed(successfulProbe({
    exitCode: 23,
    stderrObserved: true
  })), FIXTURE_POLICY);
  expectCapability(nonzero, 'probe-failed', 'ME3_VERSION_PROBE_FAILED');
  observed.push(nonzero);

  const spawnFailure = await detect(probed(successfulProbe({
    exitCode: 0,
    spawnFailure: 'permission-denied'
  })), FIXTURE_POLICY);
  expectCapability(spawnFailure, 'spawn-failed', 'ME3_PROBE_SPAWN_FAILED');
  observed.push(spawnFailure);

  const throwingGateway = new FakeMe3RuntimeGateway(() => {
    throw new Error('spawn failed at C:\\private\\me3.exe');
  });
  const thrownSpawnFailure = await new Me3RuntimeAdapter({ gateway: throwingGateway })
    .detect({ timeoutMs: 500 });
  expectCapability(thrownSpawnFailure, 'spawn-failed', 'ME3_PROBE_SPAWN_FAILED');
  observed.push(thrownSpawnFailure);

  const timedOut = await detect(probed(successfulProbe({
    exitCode: 0,
    timedOut: true
  })), FIXTURE_POLICY);
  expectCapability(timedOut, 'timed-out', 'ME3_DETECTION_TIMEOUT');
  expectNoDiagnostic(timedOut.diagnostics, 'ME3_EXIT_ZERO_UNVERIFIED');
  observed.push(timedOut);

  const nonCooperativeTimeoutGateway = new FakeMe3RuntimeGateway(
    () => new Promise<never>(() => undefined)
  );
  const enforcedTimeout = await new Me3RuntimeAdapter({
    gateway: nonCooperativeTimeoutGateway,
    versionPolicy: FIXTURE_POLICY
  }).detect({ timeoutMs: 20 });
  expectCapability(enforcedTimeout, 'timed-out', 'ME3_DETECTION_TIMEOUT');
  expectRequestCount(nonCooperativeTimeoutGateway, 1, 'non-cooperative timeout');
  expectGatewaySignalAborted(nonCooperativeTimeoutGateway.requests[0], 'non-cooperative timeout');
  observed.push(enforcedTimeout);

  const nonCooperativeCancelController = new AbortController();
  const nonCooperativeCancelGateway = new FakeMe3RuntimeGateway(
    () => new Promise<never>(() => undefined)
  );
  const enforcedCancellationPromise = new Me3RuntimeAdapter({
    gateway: nonCooperativeCancelGateway,
    versionPolicy: FIXTURE_POLICY
  }).detect({
    timeoutMs: 5_000,
    signal: nonCooperativeCancelController.signal
  });
  nonCooperativeCancelController.abort('fixture-non-cooperative-gateway');
  const enforcedCancellation = await enforcedCancellationPromise;
  expectCapability(enforcedCancellation, 'cancelled', 'ME3_DETECTION_CANCELLED');
  expectRequestCount(nonCooperativeCancelGateway, 1, 'non-cooperative cancellation');
  expectFixedRequest(nonCooperativeCancelGateway.requests[0], 5_000);
  expectGatewaySignalAborted(
    nonCooperativeCancelGateway.requests[0],
    'non-cooperative cancellation'
  );
  observed.push(enforcedCancellation);

  const cancelled = await detect(probed(successfulProbe({
    exitCode: 0,
    cancelled: true
  })), FIXTURE_POLICY);
  expectCapability(cancelled, 'cancelled', 'ME3_DETECTION_CANCELLED');
  expectNoDiagnostic(cancelled.diagnostics, 'ME3_EXIT_ZERO_UNVERIFIED');
  observed.push(cancelled);

  const racingController = new AbortController();
  const racingGateway = new FakeMe3RuntimeGateway((request) => {
    if (!request.signal || request.signal === racingController.signal) {
      throw new Error('adapter did not isolate the privileged gateway signal');
    }
    racingController.abort('fixture-close-race');
    return probed(successfulProbe({ exitCode: 0 }));
  });
  const cancelledRace = await new Me3RuntimeAdapter({
    gateway: racingGateway,
    versionPolicy: FIXTURE_POLICY
  }).detect({ timeoutMs: 500, signal: racingController.signal });
  expectCapability(cancelledRace, 'cancelled', 'ME3_DETECTION_CANCELLED');
  expectNoDiagnostic(cancelledRace.diagnostics, 'ME3_EXIT_ZERO_UNVERIFIED');
  expectGatewaySignalAborted(racingGateway.requests[0], 'abort-signal close race');
  observed.push(cancelledRace);

  const rejectingController = new AbortController();
  const rejectingGateway = new FakeMe3RuntimeGateway(() => {
    rejectingController.abort('fixture-reject-race');
    throw new Error('cancelled at C:\\private\\me3.exe');
  });
  const cancelledReject = await new Me3RuntimeAdapter({
    gateway: rejectingGateway,
    versionPolicy: FIXTURE_POLICY
  }).detect({ timeoutMs: 500, signal: rejectingController.signal });
  expectCapability(cancelledReject, 'cancelled', 'ME3_DETECTION_CANCELLED');
  observed.push(cancelledReject);

  const unsupportedGateway = fixedGateway(probed(successfulProbe()));
  const adapter = new Me3RuntimeAdapter({
    gateway: unsupportedGateway,
    versionPolicy: FIXTURE_POLICY
  });
  const profile: RuntimeProfileRef = {
    profileId: 'fixture-profile',
    workspaceSessionId: 'fixture-workspace',
    game: 'sekiro',
    profileVersion: 'v1',
    contentSha256: '0'.repeat(64)
  };
  const session: RuntimeLaunchSession = {
    sessionId: 'fixture-session',
    game: 'sekiro',
    state: 'starting',
    startedAt: '2026-07-25T00:00:00.000Z',
    diagnostics: []
  };
  const unsupportedOperations = await Promise.all([
    adapter.prepareProfile(
      { workspaceSessionId: 'fixture-workspace', game: 'sekiro' },
      { timeoutMs: 500 }
    ),
    adapter.launch({ profile, operationId: 'fixture-operation' }, { timeoutMs: 500 }),
    adapter.collectDiagnostics(session, { timeoutMs: 500 }),
    adapter.terminate(session, { timeoutMs: 500 })
  ]);
  for (const result of unsupportedOperations) {
    expectUnsupported(result);
    observed.push(result);
  }
  expectRequestCount(unsupportedGateway, 0, 'unsupported operations');

  for (const value of observed) assertNoAuthorityLeak(value);

  console.log(JSON.stringify({
    ok: true,
    status: 'fixture-confirmed',
    authority: 'fixture-confirmed',
    nativeRuntimeAuthority: false,
    realMe3Executed: false,
    realSekiroExecuted: false,
    cases: [
      'invalid-timeout',
      'oversized-timeout',
      'pre-cancelled',
      'not-found',
      'ambiguous',
      'gateway-invalid-schema',
      'policy-unset',
      'policy-invalid-schema',
      'exit-zero-unverified',
      'unsupported-version',
      'malformed-version',
      'truncated-version',
      'nonzero-exit',
      'spawn-failure',
      'gateway-throw-redaction',
      'timeout-exit-zero-race',
      'non-cooperative-gateway-timeout',
      'non-cooperative-gateway-cancellation',
      'cancel-exit-zero-race',
      'abort-signal-close-race',
      'abort-signal-reject-race',
      'unsupported-runtime-operations'
    ],
    nonClaims: [
      'No real me3 executable or Sekiro process was discovered or started.',
      'A matching version fixture and exit code zero do not establish launch readiness.',
      'Profile generation, launch, diagnostics collection, termination, signing, and native runtime authority remain unimplemented.'
    ]
  }, null, 2));
}

async function detect(
  result: unknown,
  versionPolicy?: Me3VersionPolicy
): Promise<RuntimeCapability> {
  return new Me3RuntimeAdapter({
    gateway: fixedGateway(result),
    ...(versionPolicy ? { versionPolicy } : {})
  }).detect({ timeoutMs: 500 });
}

function fixedGateway(result: unknown): FakeMe3RuntimeGateway {
  return new FakeMe3RuntimeGateway(() => result);
}

function notFound(): Me3DetectionGatewayResult {
  return {
    status: 'not-found',
    checkedSources: ['registry', 'well-known', 'path']
  };
}

function probed(process: Me3VersionProbeProcessResult): Me3DetectionGatewayResult {
  return { status: 'probed', discoverySource: 'registry', process };
}

function successfulProbe(
  overrides: Partial<Me3VersionProbeProcessResult> = {}
): Me3VersionProbeProcessResult {
  return {
    exitCode: 0,
    stdout: 'me3 0.12.1\n',
    stdoutTruncated: false,
    stderrObserved: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    spawnFailure: null,
    ...overrides
  };
}

function expectCapability(
  capability: RuntimeCapability,
  state: RuntimeCapability['state'],
  diagnosticCode: string
): void {
  if (capability.state !== state
    || capability.authority !== 'unverified'
    || capability.nativeRuntimeAuthority !== false
    || capability.canLaunch
    || capability.canPrepareProfile) {
    throw new Error(`unexpected ${state} capability: ${JSON.stringify(capability)}`);
  }
  expectDiagnostic(capability.diagnostics, diagnosticCode);
}

function expectUnsupported(result: RuntimeOperationResult<unknown>): void {
  if (result.ok || result.status !== 'unsupported' || result.authority !== 'unverified') {
    throw new Error(`expected unsupported runtime operation: ${JSON.stringify(result)}`);
  }
  expectDiagnostic(result.diagnostics, 'ME3_RUNTIME_OPERATION_NOT_IMPLEMENTED');
}

function expectDiagnostic(diagnostics: readonly RuntimeDiagnostic[], code: string): void {
  if (!diagnostics.some((item) => item.code === code)) {
    throw new Error(`expected diagnostic ${code}: ${JSON.stringify(diagnostics)}`);
  }
}

function expectNoDiagnostic(diagnostics: readonly RuntimeDiagnostic[], code: string): void {
  if (diagnostics.some((item) => item.code === code)) {
    throw new Error(`unexpected diagnostic ${code}: ${JSON.stringify(diagnostics)}`);
  }
}

function expectFixedRequest(
  request: Me3VersionProbeRequest | undefined,
  timeoutMs: number
): void {
  if (!request || request.operation !== 'version-probe' || request.timeoutMs !== timeoutMs) {
    throw new Error(`unexpected gateway request: ${JSON.stringify(request)}`);
  }
  assertNoAuthorityLeak(request);
}

function expectRequestCount(
  gateway: FakeMe3RuntimeGateway,
  expected: number,
  label: string
): void {
  if (gateway.requests.length !== expected) {
    throw new Error(`${label} issued ${gateway.requests.length} gateway requests; expected ${expected}`);
  }
}

function expectGatewaySignalAborted(
  request: Me3VersionProbeRequest | undefined,
  label: string
): void {
  if (!request?.signal?.aborted) {
    throw new Error(`${label} did not abort the privileged gateway signal`);
  }
}

function assertNoAuthorityLeak(value: unknown): void {
  const forbiddenKeys = new Set([
    'absolutePath',
    'argv',
    'cwd',
    'env',
    'executable',
    'executablePath',
    'gamePath',
    'pid',
    'processId',
    'profilePath',
    'sourcePath'
  ]);
  visit(value, (key, child) => {
    if (forbiddenKeys.has(key)) throw new Error(`authority-bearing key leaked: ${key}`);
    if (typeof child === 'string'
      && (/(?:^|[\s('"=])[A-Za-z]:[\\/]/u.test(child)
        || /(?:^|[\s('"=])\\\\[^\\/\s]+[\\/]/u.test(child)
        || /file:\/\/\/[A-Za-z]:\//iu.test(child))) {
      throw new Error(`absolute path leaked through runtime DTO: ${child}`);
    }
  });
}

function visit(
  value: unknown,
  visitor: (key: string, value: unknown) => void,
  key = ''
): void {
  visitor(key, value);
  if (Array.isArray(value)) {
    value.forEach((item) => visit(item, visitor));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    visit(child, visitor, childKey);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
