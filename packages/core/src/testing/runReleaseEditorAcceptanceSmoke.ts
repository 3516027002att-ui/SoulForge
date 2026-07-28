import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EDITOR_CAPABILITY_CONTRACTS,
  buildPendingEditorScaleSamplingSchemas,
  buildProposedReleaseEditorInventory,
  evaluateReleaseEditorAcceptance,
  type EditorScaleSample,
  type ProposedReleaseEditorId,
  type ReleaseEditorAcceptanceResult,
  type ReleaseEditorInventoryItem
} from '../index.js';

function main(): void {
  const inventory = buildProposedReleaseEditorInventory();
  const schemas = buildPendingEditorScaleSamplingSchemas();
  assertInventoryDerivedFromCapabilities(inventory);
  assertScaleContractsMatchCurrentSources();
  assertAllThresholdsPending(schemas);

  const demoFallback = evaluateReleaseEditorAcceptance({
    sample: { ...buildContractFixture('safe-hex'), sourceMode: 'demo-fallback' }
  });
  assertRejectedWith(demoFallback, 'EDITOR_DEMO_FALLBACK_REJECTED');

  const syntheticSource = evaluateReleaseEditorAcceptance({
    sample: buildContractFixture('safe-hex')
  });
  assertRejectedWith(syntheticSource, 'EDITOR_SYNTHETIC_SOURCE_REJECTED');
  if (syntheticSource.evidenceKind !== 'candidate'
    || syntheticSource.evidenceAuthority !== 'candidate') {
    throw new Error('contract fixture must not elevate release evidence authority');
  }

  const missingNativeAuthority = evaluateReleaseEditorAcceptance({
    sample: {
      ...buildContractFixture('param'),
      documentAuthority: 'none',
      authorityLevel: 'unverified'
    }
  });
  assertRejectedWith(missingNativeAuthority, 'EDITOR_NATIVE_AUTHORITY_REQUIRED');

  const missingRevision = evaluateReleaseEditorAcceptance({
    sample: { ...buildContractFixture('safe-hex'), revision: null }
  });
  assertRejectedWith(missingRevision, 'EDITOR_REVISION_REQUIRED');

  const staleRevisionAccepted = evaluateReleaseEditorAcceptance({
    sample: { ...buildContractFixture('safe-hex'), rejectsStaleRevision: false }
  });
  assertRejectedWith(staleRevisionAccepted, 'EDITOR_REVISION_CONFLICT_NOT_REJECTED');

  const missingVirtualization = evaluateReleaseEditorAcceptance({
    sample: { ...buildContractFixture('safe-hex'), scaleAccess: 'none' }
  });
  assertRejectedWith(
    missingVirtualization,
    'EDITOR_PAGINATION_OR_VIRTUALIZATION_REQUIRED'
  );

  const prematurePass = evaluateReleaseEditorAcceptance({
    sample: buildContractFixture('safe-hex'),
    claimedReleaseDecision: 'pass'
  });
  assertRejectedWith(prematurePass, 'EDITOR_RELEASE_PASS_FORBIDDEN');
  assertDiagnostic(prematurePass, 'EDITOR_THRESHOLDS_PENDING');
  assertDiagnostic(prematurePass, 'EDITOR_HUMAN_ACCEPTANCE_PENDING');
  assertPendingDecision(prematurePass);

  const currentScaleContractGaps = inventory.flatMap((item) => {
    const diagnosticCode = expectedScaleGapDiagnostic(item.currentScaleAccess);
    if (diagnosticCode === null) return [];
    const currentContract = evaluateReleaseEditorAcceptance({
      sample: buildContractFixture(item.releaseEditorId)
    });
    assertRejectedWith(currentContract, diagnosticCode);
    return [{
      releaseEditorId: item.releaseEditorId,
      scaleAccess: item.currentScaleAccess,
      diagnosticCode
    }];
  });
  assertCurrentScaleGap(
    currentScaleContractGaps,
    'fmg',
    'bounded-window',
    'EDITOR_BOUNDED_WINDOW_NOT_RELEASE_SAFE'
  );
  assertCurrentScaleGap(
    currentScaleContractGaps,
    'emevd',
    'eager',
    'EDITOR_EAGER_MATERIALIZATION_NOT_RELEASE_SAFE'
  );

  console.log(JSON.stringify({
    ok: null,
    harnessStatus: 'candidate',
    evidenceKind: 'candidate',
    releaseGateDecision: 'pending',
    releasePassed: false,
    realAcceptanceRun: false,
    humanAcceptanceStatus: 'pending',
    scopeRulingStatus: 'pending',
    thresholdRulingStatus: 'pending',
    proposedInventory: inventory.map((item) => ({
      releaseEditorId: item.releaseEditorId,
      releaseIncluded: item.releaseIncluded,
      scalePrimitives: item.scalePrimitives,
      scaleAccess: item.currentScaleAccess
    })),
    currentScaleContractGaps,
    negativeFixtures: [
      'demo-fallback',
      'synthetic-source',
      'missing-native-authority',
      'missing-revision',
      'stale-revision-accepted',
      'missing-pagination-or-virtualization',
      'pass-claim-with-pending-thresholds'
    ],
    nonClaims: [
      '未运行真实 Electron 人机规模验收。',
      '未裁定发布编辑器清单、规模档位、容量或延迟阈值。',
      'contract fixture 只验证 harness，不能提升 editor/native authority 或 REL-F。'
    ]
  }, null, 2));
}

function assertInventoryDerivedFromCapabilities(
  inventory: ReleaseEditorInventoryItem[]
): void {
  const expectedIds: ProposedReleaseEditorId[] = ['safe-hex', 'fmg', 'param', 'emevd', 'msb'];
  if (JSON.stringify(inventory.map((item) => item.releaseEditorId)) !== JSON.stringify(expectedIds)) {
    throw new Error('release editor inventory/order drifted');
  }
  if (inventory.some((item) => item.scopeRulingStatus !== 'pending'
    || item.releaseIncluded !== null)) {
    throw new Error('unruled release inventory must remain null/pending');
  }
  for (const item of inventory) {
    const contract = EDITOR_CAPABILITY_CONTRACTS[item.editorKind];
    if (JSON.stringify(item.mutationKinds) !== JSON.stringify(contract.mutationKinds)
      || item.revisionContract !== contract.revisionContract
      || JSON.stringify(item.scalePrimitives) !== JSON.stringify(contract.scalePrimitives)
      || item.currentScaleAccess !== contract.scaleAccess) {
      throw new Error(`release inventory is not derived from ${item.editorKind} capability contract`);
    }
  }
}

function assertScaleContractsMatchCurrentSources(): void {
  const root = resolve('../..');
  const sourceChecks: Array<[string, string[]]> = [
    [
      'apps/desktop/src/renderer/src/editors/HexEditorPanel.tsx',
      ['const pageSize = 16', 'pageBytes']
    ],
    [
      'packages/core/src/preview/openResourcePreview.ts',
      ['const DEFAULT_MAX_BYTES = 64 * 1024', 'truncated']
    ],
    [
      'apps/desktop/src/renderer/src/editors/FmgWorkbenchPanel.tsx',
      ['filtered.slice(0, 200)']
    ],
    [
      'apps/desktop/src/renderer/src/editors/ParamTablePanel.tsx',
      ['const pageSize = 20', 'pageRows = filtered.slice']
    ],
    [
      'packages/core/src/editing/paramBridgeCommit.ts',
      ['const maxRows = input.maxRows ?? 500', '.slice(0, maxRows)']
    ],
    [
      'apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx',
      ['document.events.map']
    ],
    [
      'apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx',
      ['maxNodes: props.maxNodes ?? 2000', 'chunkSize: 512',
        'buildSceneDrawList(manifest, { maxItems: props.maxNodes ?? 2000 })']
    ]
  ];
  for (const [relativePath, tokens] of sourceChecks) {
    const source = readFileSync(resolve(root, relativePath), 'utf8');
    for (const token of tokens) {
      if (!source.includes(token)) {
        throw new Error(`editor scale contract source drift: ${relativePath} missing ${token}`);
      }
    }
  }
}

function assertAllThresholdsPending(
  schemas: ReturnType<typeof buildPendingEditorScaleSamplingSchemas>
): void {
  if (schemas.length !== 5) throw new Error('expected one sampling schema per proposed editor');
  for (const schema of schemas) {
    if (schema.scopeRulingStatus !== 'pending' || schema.tierRulingStatus !== 'pending') {
      throw new Error(`${schema.releaseEditorId} sampling rulings must remain pending`);
    }
    for (const tier of schema.tiers) {
      if (tier.rulingStatus !== 'pending') throw new Error(`${tier.tierId} must remain pending`);
      for (const capacity of tier.capacity) {
        if (capacity.minimum.rulingStatus !== 'pending' || capacity.minimum.value !== null
          || capacity.maximum.rulingStatus !== 'pending' || capacity.maximum.value !== null) {
          throw new Error(`${schema.releaseEditorId}/${tier.tierId} capacity threshold is not null/pending`);
        }
      }
      for (const latency of tier.latency) {
        if (latency.maximumMs.rulingStatus !== 'pending' || latency.maximumMs.value !== null) {
          throw new Error(`${schema.releaseEditorId}/${tier.tierId} latency threshold is not null/pending`);
        }
      }
    }
  }
}

function buildContractFixture(releaseEditorId: ProposedReleaseEditorId): EditorScaleSample {
  const inventory = buildProposedReleaseEditorInventory();
  const editor = inventory.find((item) => item.releaseEditorId === releaseEditorId);
  if (!editor) throw new Error(`unknown editor fixture ${releaseEditorId}`);
  const latencyMs: EditorScaleSample['latencyMs'] = {
    'first-interactive': 1,
    'background-complete': 2,
    'single-mutation-p95': 1
  };
  if (releaseEditorId === 'msb') {
    latencyMs['picking-p95'] = 1;
    latencyMs['box-selection-p95'] = 1;
  }
  return {
    schemaVersion: 1,
    releaseEditorId,
    sourceMode: 'synthetic',
    documentAuthority: editor.documentAuthorityRequirement,
    authorityLevel: editor.documentAuthorityRequirement === 'raw-byte-document'
      ? 'raw-byte-authority'
      : 'partial',
    revision: 'contract-fixture-revision',
    rejectsStaleRevision: true,
    observedMutationKinds: [...editor.mutationKinds],
    scaleAccess: editor.currentScaleAccess,
    tierId: null,
    capacity: Object.fromEntries(editor.scaleDimensions.map((dimension) => [dimension, 1])),
    latencyMs
  };
}

function assertRejectedWith(result: ReleaseEditorAcceptanceResult, code: string): void {
  if (result.acceptanceStatus !== 'rejected' || result.releasePassed) {
    throw new Error(`${code} fixture did not fail closed`);
  }
  assertDiagnostic(result, code);
  assertPendingDecision(result);
}

function assertDiagnostic(result: ReleaseEditorAcceptanceResult, code: string): void {
  if (!result.diagnostics.some((diagnostic) => diagnostic.code === code)) {
    throw new Error(`missing diagnostic ${code}`);
  }
}

function assertPendingDecision(result: ReleaseEditorAcceptanceResult): void {
  if (result.ok !== null
    || result.releaseGateDecision !== 'pending'
    || result.releasePassed
    || result.scopeRulingStatus !== 'pending'
    || result.thresholdRulingStatus !== 'pending'
    || result.humanAcceptanceStatus !== 'pending'
    || result.realHumanAcceptanceRun) {
    throw new Error(`${result.releaseEditorId} must remain null/pending without ruled thresholds and human evidence`);
  }
}

function expectedScaleGapDiagnostic(
  scaleAccess: ReleaseEditorInventoryItem['currentScaleAccess']
): string | null {
  if (scaleAccess === 'bounded-window') return 'EDITOR_BOUNDED_WINDOW_NOT_RELEASE_SAFE';
  if (scaleAccess === 'eager') return 'EDITOR_EAGER_MATERIALIZATION_NOT_RELEASE_SAFE';
  if (scaleAccess === 'none') return 'EDITOR_PAGINATION_OR_VIRTUALIZATION_REQUIRED';
  return null;
}

function assertCurrentScaleGap(
  gaps: Array<{
    releaseEditorId: ProposedReleaseEditorId;
    scaleAccess: ReleaseEditorInventoryItem['currentScaleAccess'];
    diagnosticCode: string;
  }>,
  releaseEditorId: ProposedReleaseEditorId,
  scaleAccess: ReleaseEditorInventoryItem['currentScaleAccess'],
  diagnosticCode: string
): void {
  const gap = gaps.find((item) => item.releaseEditorId === releaseEditorId);
  if (!gap || gap.scaleAccess !== scaleAccess || gap.diagnosticCode !== diagnosticCode) {
    throw new Error(`${releaseEditorId} current scale gap was not preserved honestly`);
  }
}

main();
