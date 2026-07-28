import type {
  GameRuntimeAdapter,
  RuntimeCallContext,
  RuntimeCapability,
  RuntimeCapabilityState,
  RuntimeDiagnostics,
  RuntimeDiscoverySource,
  RuntimeLaunchRequest,
  RuntimeLaunchSession,
  RuntimeOperationResult,
  RuntimeDiagnostic,
  RuntimeProfileRef,
  RuntimeTerminationResult,
  RuntimeWorkspaceRef
} from './gameRuntimeAdapter.js';

export type Me3DiscoverySource = 'registry' | 'well-known' | 'path';

export type Me3SpawnFailure =
  | 'not-executable'
  | 'permission-denied'
  | 'process-unavailable'
  | 'unknown';

export interface Me3VersionProbeProcessResult {
  exitCode: number | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderrObserved: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  spawnFailure: Me3SpawnFailure | null;
}

export type Me3DetectionGatewayResult =
  | {
      status: 'not-found';
      checkedSources: readonly Me3DiscoverySource[];
    }
  | {
      status: 'ambiguous';
      candidateCount: number;
      discoverySources: readonly Me3DiscoverySource[];
    }
  | {
      status: 'probed';
      discoverySource: Me3DiscoverySource;
      process: Me3VersionProbeProcessResult;
    };

export interface Me3VersionProbeRequest {
  operation: 'version-probe';
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Privileged port implemented outside core. It owns executable discovery and
 * the fixed `me3 --version` subprocess, and must not return authority-bearing
 * paths, process ids, argv, cwd, or environment values.
 */
export interface Me3RuntimeGateway {
  probeVersion(request: Me3VersionProbeRequest): Promise<unknown>;
}

export interface Me3VersionPolicy {
  policyId: string;
  supportedVersions: readonly string[];
}

export interface Me3RuntimeAdapterOptions {
  gateway: Me3RuntimeGateway;
  versionPolicy?: Me3VersionPolicy;
}

const VERSION_LINE = /^me3 ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;
const SAFE_POLICY_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const MAX_VERSION_OUTPUT_CHARACTERS = 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_SUPPORTED_VERSION_COUNT = 256;
const DISCOVERY_SOURCES = new Set<Me3DiscoverySource>(['registry', 'well-known', 'path']);
const SPAWN_FAILURES = new Set<Me3SpawnFailure>([
  'not-executable',
  'permission-denied',
  'process-unavailable',
  'unknown'
]);

export class Me3RuntimeAdapter implements GameRuntimeAdapter {
  readonly adapterId = 'me3';
  readonly game = 'sekiro' as const;

  private readonly gateway: Me3RuntimeGateway;
  private readonly versionPolicy: Me3VersionPolicy | undefined;

  constructor(options: Me3RuntimeAdapterOptions) {
    this.gateway = options.gateway;
    this.versionPolicy = options.versionPolicy;
  }

  async detect(context: RuntimeCallContext): Promise<RuntimeCapability> {
    if (!Number.isSafeInteger(context.timeoutMs)
      || context.timeoutMs <= 0
      || context.timeoutMs > MAX_TIMER_DELAY_MS) {
      return capability('probe-failed', 'none', [diagnostic(
        'ME3_DETECTION_TIMEOUT_INVALID',
        'The me3 detection timeout must be a positive supported timer delay.'
      )]);
    }
    if (context.signal?.aborted) return cancelledCapability();

    const gatewayController = new AbortController();
    let gatewayPromise: Promise<unknown>;
    try {
      gatewayPromise = Promise.resolve(this.gateway.probeVersion({
        operation: 'version-probe',
        timeoutMs: context.timeoutMs,
        signal: gatewayController.signal
      }));
    } catch {
      gatewayController.abort('spawn-failed');
      if (context.signal?.aborted) return cancelledCapability();
      return capability('spawn-failed', 'none', [diagnostic(
        'ME3_PROBE_SPAWN_FAILED',
        'The privileged me3 detection gateway failed before returning a probe result.'
      )]);
    }

    const gatewayResult = await awaitGatewayProbe(
      gatewayPromise,
      context.timeoutMs,
      context.signal,
      gatewayController
    );
    if (gatewayResult.status === 'cancelled') return cancelledCapability();
    if (gatewayResult.status === 'timed-out') {
      return timedOutCapability(context.timeoutMs);
    }
    if (gatewayResult.status === 'rejected') {
      if (context.signal?.aborted) return cancelledCapability();
      return capability('spawn-failed', 'none', [diagnostic(
        'ME3_PROBE_SPAWN_FAILED',
        'The privileged me3 detection gateway failed before returning a probe result.'
      )]);
    }
    const rawResult = gatewayResult.value;

    // User cancellation is terminal even if a racing process close reports exit code zero.
    if (context.signal?.aborted) return cancelledCapability();

    let result: Me3DetectionGatewayResult | null;
    try {
      result = validateGatewayResponse(rawResult);
    } catch {
      result = null;
    }
    if (!result) {
      return capability('probe-failed', 'none', [diagnostic(
        'ME3_GATEWAY_RESPONSE_INVALID',
        'The privileged me3 detection gateway returned an invalid response.'
      )]);
    }

    if (result.status === 'not-found') {
      return capability('not-found', 'none', [diagnostic(
        'ME3_NOT_FOUND',
        'No me3 installation candidate was found.',
        { checkedSources: uniqueSources(result.checkedSources) }
      )]);
    }
    if (result.status === 'ambiguous') {
      return capability('ambiguous', 'multiple', [diagnostic(
        'ME3_INSTALLATION_AMBIGUOUS',
        'Multiple distinct me3 installation candidates were found.',
        {
          candidateCount: positiveCount(result.candidateCount),
          discoverySources: uniqueSources(result.discoverySources)
        }
      )]);
    }

    return this.classifyProbe(result.discoverySource, result.process, context.timeoutMs);
  }

  prepareProfile(
    _workspace: RuntimeWorkspaceRef,
    _context: RuntimeCallContext
  ): Promise<RuntimeOperationResult<RuntimeProfileRef>> {
    return Promise.resolve(unsupportedOperation('prepare-profile'));
  }

  launch(
    _request: RuntimeLaunchRequest,
    _context: RuntimeCallContext
  ): Promise<RuntimeOperationResult<RuntimeLaunchSession>> {
    return Promise.resolve(unsupportedOperation('launch'));
  }

  collectDiagnostics(
    _session: RuntimeLaunchSession,
    _context: RuntimeCallContext
  ): Promise<RuntimeOperationResult<RuntimeDiagnostics>> {
    return Promise.resolve(unsupportedOperation('collect-diagnostics'));
  }

  terminate(
    _session: RuntimeLaunchSession,
    _context: RuntimeCallContext
  ): Promise<RuntimeOperationResult<RuntimeTerminationResult>> {
    return Promise.resolve(unsupportedOperation('terminate'));
  }

  private classifyProbe(
    source: Me3DiscoverySource,
    process: Me3VersionProbeProcessResult,
    timeoutMs: number
  ): RuntimeCapability {
    if (process.cancelled) return cancelledCapability(source);
    if (process.timedOut) {
      return capability('timed-out', source, [diagnostic(
        'ME3_DETECTION_TIMEOUT',
        'The me3 version probe timed out and is not a successful detection.',
        { timeoutMs }
      )]);
    }
    if (process.spawnFailure !== null) {
      return capability('spawn-failed', source, [diagnostic(
        'ME3_PROBE_SPAWN_FAILED',
        'The me3 version probe could not be started.',
        { reason: process.spawnFailure }
      )]);
    }
    if (process.exitCode !== 0) {
      return capability('probe-failed', source, [diagnostic(
        'ME3_VERSION_PROBE_FAILED',
        'The me3 version probe exited unsuccessfully.',
        {
          exitCode: process.exitCode,
          stderrObserved: process.stderrObserved,
          stdoutTruncated: process.stdoutTruncated,
          stderrTruncated: process.stderrTruncated
        }
      )]);
    }

    const version = parseVersionOutput(process.stdout, process.stdoutTruncated);
    if (!version) {
      return capability('malformed-version', source, [diagnostic(
        'ME3_VERSION_OUTPUT_MALFORMED',
        'The me3 version probe returned an unrecognized or truncated version line.',
        {
          stdoutTruncated: process.stdoutTruncated,
          stderrObserved: process.stderrObserved,
          stderrTruncated: process.stderrTruncated
        }
      )]);
    }

    const exitZeroDiagnostic = diagnostic(
      'ME3_EXIT_ZERO_UNVERIFIED',
      'A zero exit code and matching version line do not establish launch readiness or native runtime authority.',
      { detectedVersion: version }
    );
    const policy = validatePolicy(this.versionPolicy);
    if (!policy.ok) {
      return capability('policy-unset', source, [
        exitZeroDiagnostic,
        diagnostic(policy.code, policy.message)
      ], { detectedVersion: version });
    }
    if (!policy.supportedVersions.has(version)) {
      return capability('unsupported-version', source, [
        exitZeroDiagnostic,
        diagnostic(
          'ME3_VERSION_UNSUPPORTED',
          'The detected me3 version is not present in the exact compatibility allowlist.',
          { detectedVersion: version, versionPolicyId: policy.policyId }
        )
      ], { detectedVersion: version, versionPolicyId: policy.policyId });
    }

    return capability('exit-zero-unverified', source, [exitZeroDiagnostic], {
      detectedVersion: version,
      versionPolicyId: policy.policyId,
      compatible: true
    });
  }
}

function parseVersionOutput(stdout: string, truncated: boolean): string | null {
  if (truncated || stdout.length > MAX_VERSION_OUTPUT_CHARACTERS) return null;
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  return VERSION_LINE.exec(lines[0]!)?.[1] ?? null;
}

function validateGatewayResponse(value: unknown): Me3DetectionGatewayResult | null {
  const record = asPlainRecord(value);
  if (!record || typeof record.status !== 'string') return null;

  if (record.status === 'not-found') {
    if (!hasExactKeys(record, ['status', 'checkedSources'])) return null;
    const checkedSources = validateSources(record.checkedSources);
    return checkedSources ? { status: 'not-found', checkedSources } : null;
  }

  if (record.status === 'ambiguous') {
    if (!hasExactKeys(record, ['status', 'candidateCount', 'discoverySources'])) return null;
    if (typeof record.candidateCount !== 'number'
      || !Number.isSafeInteger(record.candidateCount)
      || record.candidateCount < 2) return null;
    const discoverySources = validateSources(record.discoverySources);
    return discoverySources
      ? { status: 'ambiguous', candidateCount: record.candidateCount, discoverySources }
      : null;
  }

  if (record.status === 'probed') {
    if (!hasExactKeys(record, ['status', 'discoverySource', 'process'])) return null;
    if (!isDiscoverySource(record.discoverySource)) return null;
    const process = validateProcessResult(record.process);
    return process
      ? { status: 'probed', discoverySource: record.discoverySource, process }
      : null;
  }

  return null;
}

function validateProcessResult(value: unknown): Me3VersionProbeProcessResult | null {
  const record = asPlainRecord(value);
  if (!record || !hasExactKeys(record, [
    'exitCode',
    'stdout',
    'stdoutTruncated',
    'stderrObserved',
    'stderrTruncated',
    'timedOut',
    'cancelled',
    'spawnFailure'
  ])) return null;

  const exitCode = record.exitCode;
  if (exitCode !== null
    && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) return null;
  if (typeof record.stdout !== 'string'
    || record.stdout.length > MAX_VERSION_OUTPUT_CHARACTERS) return null;
  if (typeof record.stdoutTruncated !== 'boolean'
    || typeof record.stderrObserved !== 'boolean'
    || typeof record.stderrTruncated !== 'boolean'
    || typeof record.timedOut !== 'boolean'
    || typeof record.cancelled !== 'boolean') return null;
  if (record.timedOut && record.cancelled) return null;

  const spawnFailure = record.spawnFailure;
  if (spawnFailure !== null
    && (typeof spawnFailure !== 'string'
      || !SPAWN_FAILURES.has(spawnFailure as Me3SpawnFailure))) return null;

  return {
    exitCode,
    stdout: record.stdout,
    stdoutTruncated: record.stdoutTruncated,
    stderrObserved: record.stderrObserved,
    stderrTruncated: record.stderrTruncated,
    timedOut: record.timedOut,
    cancelled: record.cancelled,
    spawnFailure: spawnFailure as Me3SpawnFailure | null
  };
}

function validateSources(value: unknown): Me3DiscoverySource[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > DISCOVERY_SOURCES.size) {
    return null;
  }
  const result: Me3DiscoverySource[] = [];
  const seen = new Set<Me3DiscoverySource>();
  for (const source of value) {
    if (!isDiscoverySource(source) || seen.has(source)) return null;
    seen.add(source);
    result.push(source);
  }
  return result;
}

function isDiscoverySource(value: unknown): value is Me3DiscoverySource {
  return typeof value === 'string' && DISCOVERY_SOURCES.has(value as Me3DiscoverySource);
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validatePolicy(policy: unknown):
  | { ok: true; policyId: string; supportedVersions: ReadonlySet<string> }
  | { ok: false; code: string; message: string } {
  try {
    return validatePolicyValue(policy);
  } catch {
    return invalidPolicy();
  }
}

function validatePolicyValue(policy: unknown):
  | { ok: true; policyId: string; supportedVersions: ReadonlySet<string> }
  | { ok: false; code: string; message: string } {
  if (policy === undefined) {
    return {
      ok: false,
      code: 'ME3_VERSION_POLICY_UNSET',
      message: 'No production me3 compatibility allowlist has been configured.'
    };
  }
  const record = asPlainRecord(policy);
  if (!record || !hasExactKeys(record, ['policyId', 'supportedVersions'])) return invalidPolicy();
  if (typeof record.policyId !== 'string' || !SAFE_POLICY_ID.test(record.policyId)) {
    return invalidPolicy();
  }
  if (!Array.isArray(record.supportedVersions)
    || record.supportedVersions.length === 0
    || record.supportedVersions.length > MAX_SUPPORTED_VERSION_COUNT) return invalidPolicy();

  const supportedVersions = new Set<string>();
  for (const value of record.supportedVersions) {
    if (typeof value !== 'string'
      || !VERSION_LINE.test(`me3 ${value}`)
      || supportedVersions.has(value)) return invalidPolicy();
    supportedVersions.add(value);
  }
  return { ok: true, policyId: record.policyId, supportedVersions };
}

function invalidPolicy(): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'ME3_VERSION_POLICY_INVALID',
    message: 'The me3 compatibility policy must be a bounded exact-version allowlist.'
  };
}

function capability(
  state: RuntimeCapabilityState,
  discoverySource: RuntimeDiscoverySource,
  diagnostics: RuntimeDiagnostic[],
  options: {
    detectedVersion?: string;
    versionPolicyId?: string;
    compatible?: boolean;
  } = {}
): RuntimeCapability {
  return {
    adapterId: 'me3',
    game: 'sekiro',
    state,
    detected: options.detectedVersion !== undefined,
    compatible: options.compatible ?? false,
    canPrepareProfile: false,
    canLaunch: false,
    discoverySource,
    ...(options.detectedVersion !== undefined
      ? { detectedVersion: options.detectedVersion }
      : {}),
    ...(options.versionPolicyId !== undefined
      ? { versionPolicyId: options.versionPolicyId }
      : {}),
    authority: 'unverified',
    nativeRuntimeAuthority: false,
    diagnostics
  };
}

function cancelledCapability(source: RuntimeDiscoverySource = 'none'): RuntimeCapability {
  return capability('cancelled', source, [diagnostic(
    'ME3_DETECTION_CANCELLED',
    'The me3 detection request was cancelled.'
  )]);
}

function timedOutCapability(timeoutMs: number): RuntimeCapability {
  return capability('timed-out', 'none', [diagnostic(
    'ME3_DETECTION_TIMEOUT',
    'The privileged me3 detection gateway did not return before the detection deadline.',
    { timeoutMs }
  )]);
}

type GatewayProbeOutcome =
  | { status: 'resolved'; value: unknown }
  | { status: 'rejected' }
  | { status: 'timed-out' }
  | { status: 'cancelled' };

function awaitGatewayProbe(
  gatewayPromise: Promise<unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  gatewayController: AbortController
): Promise<GatewayProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: GatewayProbeOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (outcome.status === 'timed-out' || outcome.status === 'cancelled') {
        gatewayController.abort(outcome.status);
      }
      resolve(outcome);
    };
    const onAbort = (): void => finish({ status: 'cancelled' });

    timer = setTimeout(() => finish({ status: 'timed-out' }), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    void gatewayPromise.then(
      (value) => finish({ status: 'resolved', value }),
      () => finish({ status: 'rejected' })
    );
    if (signal?.aborted) {
      finish({ status: 'cancelled' });
    }
  });
}

function unsupportedOperation<T>(operation: string): RuntimeOperationResult<T> {
  return {
    ok: false,
    status: 'unsupported',
    authority: 'unverified',
    diagnostics: [diagnostic(
      'ME3_RUNTIME_OPERATION_NOT_IMPLEMENTED',
      `The me3 runtime operation is not implemented in this contract-only slice: ${operation}.`,
      { operation }
    )]
  };
}

function diagnostic(code: string, message: string, details?: unknown): RuntimeDiagnostic {
  return {
    severity: 'error',
    code,
    message,
    ...(details === undefined ? {} : { details })
  };
}

function uniqueSources(sources: readonly Me3DiscoverySource[]): Me3DiscoverySource[] {
  return [...new Set(sources)];
}

function positiveCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
