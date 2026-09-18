/**
 * Native read-proof smoke.
 *
 * Production authority: NativeReadProofStore + buildWriteRequirement.
 * Proofs are host facts from delivered native reads — never model `verified:true`,
 * never ledger tools, never fragment evidence for whole-object writes.
 */
import { pathToFileURL } from 'node:url';
import {
  buildWriteRequirement,
  NativeReadProofStore,
  type HostDeliveredNativeRead
} from '../editing/nativeReadProofStore.js';
import { fixtureHash } from './referenceOptimizationFixtures.js';
import type { ResourceVersion } from '../runtime/resourceVersion.js';
import type { NativeSourceIdentity } from '@soulforge/shared';

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

function fixtureIdentity(overrides?: Partial<NativeSourceIdentity>): NativeSourceIdentity {
  return {
    workspaceId: 'fixture-ws-proof',
    outerId: 'gameparam://fixture/NpcParam',
    childChain: ['FixtureNpcParam'],
    domain: 'param',
    namespace: 'FixtureNpcParam',
    objectKey: 'FixtureNpcParam#91000100',
    ...overrides
  };
}

function fixtureVersion(label: string, generation = 0): ResourceVersion {
  return {
    outerFileHash: fixtureHash(`proof-${label}-outer`),
    childHash: fixtureHash(`proof-${label}-child`),
    dataHash: fixtureHash(`proof-${label}-data`),
    generation,
    readerSchema: 'fixture-reader@1',
    metadataSchema: 'fixture-meta@1'
  };
}

function hostContext(principal = 'fixture-agent-1'): {
  principal: string;
  workspaceId: string;
  identityFor: (payload: unknown) => NativeSourceIdentity | null;
  versionHintFor?: (payload: unknown) => ResourceVersion | undefined;
} {
  return {
    principal,
    workspaceId: 'fixture-ws-proof',
    identityFor: (payload) => {
      const recordObj = (payload ?? {}) as Record<string, unknown>;
      if (Array.isArray(recordObj.edits)) {
        const first = recordObj.edits[0] as Record<string, unknown> | undefined;
        if (!first) return null;
        return fixtureIdentity({
          objectKey: `${String(first.table ?? 'FixtureNpcParam')}#${String(first.rowId ?? '91000100')}`,
          childChain: [String(first.table ?? 'FixtureNpcParam')]
        });
      }
      const table = typeof recordObj.table === 'string' ? recordObj.table : 'FixtureNpcParam';
      const rowId = typeof recordObj.rowId === 'number' ? recordObj.rowId : 91000100;
      const domain = typeof recordObj.domain === 'string' ? recordObj.domain : 'param';
      if (domain === 'emevd' || domain === 'script') {
        return fixtureIdentity({
          domain: domain as 'emevd' | 'script',
          outerId: typeof recordObj.sourceUri === 'string' ? recordObj.sourceUri : `${domain}://fixture/obj`,
          childChain: ['event'],
          namespace: domain,
          objectKey: typeof recordObj.objectKey === 'string' ? recordObj.objectKey : `${domain}#fixture`
        });
      }
      return fixtureIdentity({
        objectKey: `${table}#${rowId}`,
        childChain: [table]
      });
    }
  };
}

function acceptParamRead(store: NativeReadProofStore, input?: {
  principal?: string;
  version?: ResourceVersion;
  fieldId?: string;
  delivered?: boolean;
  finalVisibleFieldIds?: string[];
}): void {
  const principal = input?.principal ?? 'fixture-agent-1';
  const fieldId = input?.fieldId ?? 'hp';
  const version = input?.version ?? fixtureVersion('param-read');
  const identity = fixtureIdentity();
  const delivered = input?.delivered ?? true;
  const finalVisible = input?.finalVisibleFieldIds ?? (delivered ? [fieldId] : []);
  const observation: HostDeliveredNativeRead['observation'] = {
    kind: 'param-fields',
    fields: [{ fieldId, value: 800, delivered }],
    completeness: 'complete',
    truncated: false
  };
  store.acceptDeliveredRead({
    principal,
    workspaceId: 'fixture-ws-proof',
    identity,
    version,
    domain: 'param',
    observation,
    finalVisible: {
      hasTargetRead: delivered,
      deliveredFieldIds: finalVisible,
      projection: 'param_fields'
    }
  });
}

function acceptWholeEmevd(store: NativeReadProofStore, input?: {
  principal?: string;
  version?: ResourceVersion;
  fullText?: string;
  truncated?: boolean;
  completeness?: 'complete' | 'partial' | 'windowed' | 'summary_only';
  projection?: string;
  deliveredRanges?: Array<[number, number]>;
}): void {
  const principal = input?.principal ?? 'fixture-agent-1';
  const fullText = input?.fullText ?? 'def Event():\n    End\n';
  const total = Buffer.byteLength(fullText, 'utf8');
  const version = input?.version ?? fixtureVersion('emevd-read');
  const identity = fixtureIdentity({
    domain: 'emevd',
    outerId: 'emevd://fixture/m14/event/1400100',
    childChain: ['event', '1400100'],
    namespace: 'event',
    objectKey: 'event#1400100'
  });
  store.acceptDeliveredRead({
    principal,
    workspaceId: 'fixture-ws-proof',
    identity,
    version,
    domain: 'emevd',
    observation: {
      kind: 'emevd-full-dsl',
      fullText,
      deliveredRanges: input?.deliveredRanges ?? [[0, total]],
      completeness: input?.completeness ?? 'complete',
      truncated: input?.truncated ?? false
    },
    finalVisible: {
      hasTargetRead: true,
      deliveredFieldIds: [],
      projection: input?.projection ?? 'complete_native_dsl'
    }
  });
}

function testReadThenMutateWithoutLedger(): void {
  const store = new NativeReadProofStore({ generation: 0 });
  acceptParamRead(store);
  const requirement = buildWriteRequirement('mutate_param_fields', {
    edits: [{ table: 'FixtureNpcParam', rowId: 91000100, fieldId: 'hp', value: 900 }]
  }, hostContext());
  if (!('targets' in requirement)) {
    record('read_then_mutate_without_ledger_tool', false, `requirement failed: ${JSON.stringify(requirement)}`);
    return;
  }
  const check = store.requireCoverage(requirement);
  record(
    'read_then_mutate_without_ledger_tool',
    check.ok === true,
    check.ok ? `proofId=${check.proofId}` : `code=${check.code}`
  );
  store.dispose();
}

function testModelSuppliedVerifiedDoesNothing(): void {
  const store = new NativeReadProofStore({ generation: 0 });
  // No host-delivered read — only a model-shaped claim that would say verified:true.
  const modelClaim = {
    verified: true,
    fieldId: 'hp',
    identity: fixtureIdentity(),
    source: 'model-ledger',
    mutationBudget: 1
  };
  void modelClaim;
  const requirement = buildWriteRequirement('mutate_param_fields', {
    edits: [{ table: 'FixtureNpcParam', rowId: 91000100, fieldId: 'hp', value: 900 }]
  }, hostContext());
  if (!('targets' in requirement)) {
    record('model_supplied_verified_true_does_nothing', false, 'requirement invalid');
    return;
  }
  const check = store.requireCoverage(requirement);
  record(
    'model_supplied_verified_true_does_nothing',
    check.ok === false && check.code === 'NATIVE_READ_REQUIRED',
    check.ok ? 'model claim unexpectedly authorized write' : `code=${check.code}`
  );
  store.dispose();
}

function testFragmentCannotSatisfyWholeObjectWrite(): void {
  const store = new NativeReadProofStore({ generation: 0 });
  // Fragment/window projection — not whole-object native DSL.
  store.acceptDeliveredRead({
    principal: 'fixture-agent-1',
    workspaceId: 'fixture-ws-proof',
    identity: fixtureIdentity({
      domain: 'emevd',
      outerId: 'emevd://fixture/m14/event/1400100',
      childChain: ['event', '1400100'],
      namespace: 'event',
      objectKey: 'event#1400100'
    }),
    version: fixtureVersion('emevd-fragment'),
    domain: 'emevd',
    observation: {
      kind: 'emevd-full-dsl',
      fullText: 'def Event():\n    End\n',
      deliveredRanges: [[0, 4]],
      completeness: 'partial',
      truncated: true,
      capabilityNotes: ['outline_only']
    },
    finalVisible: {
      hasTargetRead: true,
      deliveredFieldIds: [],
      projection: 'emevd_outline_fragment'
    }
  });
  const requirement = buildWriteRequirement('apply_emevd_dsl', {
    sourceUri: 'emevd://fixture/m14/event/1400100',
    domain: 'emevd',
    objectKey: 'event#1400100'
  }, hostContext());
  if (!('targets' in requirement)) {
    record('fragment_evidence_cannot_satisfy_whole_object_write', false, 'requirement invalid');
    return;
  }
  const check = store.requireCoverage(requirement);
  record(
    'fragment_evidence_cannot_satisfy_whole_object_write',
    check.ok === false
      && (check.code === 'NATIVE_READ_REQUIRED' || check.code === 'NATIVE_READ_COVERAGE_INCOMPLETE'),
    check.ok ? 'fragment authorized whole-object write' : `code=${check.code}`
  );
  store.dispose();
}

function testStaleVersionRejected(): void {
  const store = new NativeReadProofStore({ generation: 0 });
  const readVersion = fixtureVersion('stale-read');
  acceptParamRead(store, { version: readVersion });
  const writeVersion = fixtureVersion('stale-write', 1);
  const requirement = buildWriteRequirement('mutate_param_fields', {
    edits: [{ table: 'FixtureNpcParam', rowId: 91000100, fieldId: 'hp', value: 900 }]
  }, {
    ...hostContext(),
    versionHintFor: () => writeVersion
  });
  if (!('targets' in requirement)) {
    record('stale_version_rejected', false, 'requirement invalid');
    return;
  }
  const check = store.requireCoverage(requirement);
  record(
    'stale_version_rejected',
    check.ok === false && check.code === 'NATIVE_READ_STALE',
    check.ok ? 'stale proof authorized write' : `code=${check.code}`
  );
  store.dispose();
}

function testSecondWriteSameVersionAllowed(): void {
  const store = new NativeReadProofStore({ generation: 0 });
  const version = fixtureVersion('same-version');
  acceptParamRead(store, { version });
  const requirement = buildWriteRequirement('mutate_param_fields', {
    edits: [{ table: 'FixtureNpcParam', rowId: 91000100, fieldId: 'hp', value: 900 }]
  }, {
    ...hostContext(),
    versionHintFor: () => version
  });
  if (!('targets' in requirement)) {
    record('second_write_same_version_allowed', false, 'requirement invalid');
    return;
  }
  const first = store.requireCoverage(requirement);
  const second = store.requireCoverage(requirement);
  record(
    'second_write_same_version_allowed',
    first.ok === true && second.ok === true,
    JSON.stringify({
      first: first.ok ? 'ok' : first.code,
      second: second.ok ? 'ok' : second.code,
      note: 'no one-shot mutation budget on read proofs'
    })
  );
  store.dispose();
}

function testCrossPrincipalProofRejected(): void {
  const store = new NativeReadProofStore({ generation: 0 });
  acceptParamRead(store, { principal: 'fixture-agent-A' });
  const requirement = buildWriteRequirement('mutate_param_fields', {
    edits: [{ table: 'FixtureNpcParam', rowId: 91000100, fieldId: 'hp', value: 900 }]
  }, hostContext('fixture-agent-B'));
  if (!('targets' in requirement)) {
    record('cross_principal_proof_rejected', false, 'requirement invalid');
    return;
  }
  const check = store.requireCoverage(requirement);
  record(
    'cross_principal_proof_rejected',
    check.ok === false && check.code === 'NATIVE_READ_REQUIRED',
    check.ok ? 'cross-principal proof reused' : `code=${check.code}`
  );
  store.dispose();
}

export function runNativeReadProofSmoke(): void {
  testReadThenMutateWithoutLedger();
  testModelSuppliedVerifiedDoesNothing();
  testFragmentCannotSatisfyWholeObjectWrite();
  testStaleVersionRejected();
  testSecondWriteSameVersionAllowed();
  testCrossPrincipalProofRejected();

  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    smoke: 'native-read-proof',
    checks,
    failedCount: failed.length
  }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runNativeReadProofSmoke();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
