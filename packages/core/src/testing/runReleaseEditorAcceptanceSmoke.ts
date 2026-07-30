import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EDITOR_CAPABILITY_CONTRACTS,
  buildProposedReleaseEditorInventory,
  buildReleaseEditorFunctionalScaleSchemas,
  evaluateReleaseEditorAcceptance,
  type EditorScaleSample,
  type ProposedReleaseEditorId,
  type ReleaseEditorAcceptanceResult,
  type ReleaseEditorInventoryItem
} from '../index.js';

function main(): void {
  const inventory = buildProposedReleaseEditorInventory();
  const schemas = buildReleaseEditorFunctionalScaleSchemas();
  assertInventoryDerivedFromCapabilities(inventory);
  assertScaleContractsMatchCurrentSources();
  assertFunctionalSchemasHaveNoQuantitativeThresholds(schemas);

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
  assertDiagnostic(prematurePass, 'EDITOR_FUNCTIONAL_ACCEPTANCE_PENDING');
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
    realFunctionalAcceptanceRun: false,
    functionalAcceptanceStatus: 'pending',
    scopeRulingStatus: 'user-approved',
    quantitativeThresholdsRequired: false,
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
      'pass-claim-without-real-functional-evidence'
    ],
    nonClaims: [
      '未运行真实 Electron 真实文档功能验收。',
      'V0.5 不要求编辑器容量、延迟、规模档位或 benchmark 阈值。',
      'contract fixture 只验证 harness，不能提升 editor/native authority 或 REL-F。'
    ]
  }, null, 2));
}

function assertInventoryDerivedFromCapabilities(
  inventory: ReleaseEditorInventoryItem[]
): void {
  const expectedIds: ProposedReleaseEditorId[] = ['safe-hex', 'fmg', 'param', 'emevd', 'msb', 'tae', 'esd', 'flver'];
  if (JSON.stringify(inventory.map((item) => item.releaseEditorId)) !== JSON.stringify(expectedIds)) {
    throw new Error('release editor inventory/order drifted');
  }
  if (inventory.some((item) => item.scopeRulingStatus !== 'user-approved'
    || item.releaseIncluded !== true)) {
    throw new Error('approved release inventory must remain included/user-approved');
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

function assertFunctionalSchemasHaveNoQuantitativeThresholds(
  schemas: ReturnType<typeof buildReleaseEditorFunctionalScaleSchemas>
): void {
  if (schemas.length !== 8) throw new Error('expected one functional schema per current editor');
  for (const schema of schemas) {
    if (schema.scopeRulingStatus !== 'user-approved'
      || schema.quantitativeThresholdsRequired !== false
      || schema.acceptedAccessModes.length !== 4) {
      throw new Error(`${schema.releaseEditorId} functional scale policy drifted`);
    }
  }
  if (/capacity|latency|maximumMs|minimum|maximum|tierId/u.test(JSON.stringify(schemas))) {
    throw new Error('functional scale schema reintroduced a quantitative acceptance field');
  }
}

function buildContractFixture(releaseEditorId: ProposedReleaseEditorId): EditorScaleSample {
  const inventory = buildProposedReleaseEditorInventory();
  const editor = inventory.find((item) => item.releaseEditorId === releaseEditorId);
  if (!editor) throw new Error(`unknown editor fixture ${releaseEditorId}`);
  return {
    schemaVersion: 2,
    releaseEditorId,
    sourceMode: 'synthetic',
    documentAuthority: editor.documentAuthorityRequirement,
    authorityLevel: editor.documentAuthorityRequirement === 'raw-byte-document'
      ? 'raw-byte-authority'
      : 'partial',
    revision: 'contract-fixture-revision',
    rejectsStaleRevision: true,
    observedMutationKinds: [...editor.mutationKinds],
    scaleAccess: editor.currentScaleAccess
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
    || result.scopeRulingStatus !== 'user-approved'
    || result.quantitativeThresholdsRequired !== false
    || result.functionalAcceptanceStatus !== 'pending'
    || result.realFunctionalAcceptanceRun) {
    throw new Error(`${result.releaseEditorId} must remain pending until real functional evidence exists`);
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
