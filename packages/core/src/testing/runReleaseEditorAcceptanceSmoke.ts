import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeferredPreviewEditorKind } from '@soulforge/shared';
import {
  EDITOR_CAPABILITY_CONTRACTS,
  buildProposedReleaseEditorInventory,
  buildReleaseEditorFunctionalScaleSchemas,
  editorAllowsMutation,
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
  const approvedEditorContract = assertReviewedEditorContract(inventory);
  assertReopenedWriteEditors();
  assertReadOnlyHexAndAssetExclusions();
  assertScaleContractsMatchCurrentSources();
  assertFunctionalSchemasHaveNoQuantitativeThresholds(schemas, inventory);

  const demoFallback = evaluateReleaseEditorAcceptance({
    sample: { ...buildContractFixture('bnd4'), sourceMode: 'demo-fallback' }
  });
  assertRejectedWith(demoFallback, 'EDITOR_DEMO_FALLBACK_REJECTED');

  const syntheticSource = evaluateReleaseEditorAcceptance({
    sample: buildContractFixture('bnd4')
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
    sample: { ...buildContractFixture('bnd4'), revision: null }
  });
  assertRejectedWith(missingRevision, 'EDITOR_REVISION_REQUIRED');

  const staleRevisionAccepted = evaluateReleaseEditorAcceptance({
    sample: { ...buildContractFixture('bnd4'), rejectsStaleRevision: false }
  });
  assertRejectedWith(staleRevisionAccepted, 'EDITOR_REVISION_CONFLICT_NOT_REJECTED');

  const missingVirtualization = evaluateReleaseEditorAcceptance({
    sample: { ...buildContractFixture('bnd4'), scaleAccess: 'none' }
  });
  assertRejectedWith(
    missingVirtualization,
    'EDITOR_PAGINATION_OR_VIRTUALIZATION_REQUIRED'
  );

  const prematurePass = evaluateReleaseEditorAcceptance({
    sample: buildContractFixture('bnd4'),
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
    approvedEditorContract,
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
      '当前不以编辑器容量、延迟、规模档位或 benchmark 阈值作为开发门槛。',
      'contract fixture 只验证 harness，不能提升 editor/native authority 或 REL-F。'
    ]
  }, null, 2));
}

function assertInventoryDerivedFromCapabilities(
  inventory: ReleaseEditorInventoryItem[]
): void {
  // inventory 是当前 core 能力契约的投影，不在此处复制某一版本的
  // editorIds；TAE/ESD 等过渡期编辑器可以正常进入该投影。
  const inventoryIds = inventory.map((item) => item.releaseEditorId);
  if (inventoryIds.length === 0 || new Set(inventoryIds).size !== inventoryIds.length) {
    throw new Error('release editor inventory must be non-empty and unique');
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

// Reviewed harness expectations retained from the owner-approved editor decision.
// This is a test fixture, not release evidence or a work-start authorization gate.
const REVIEWED_EDITOR_MUTATION_MODES = Object.freeze({
  bnd4: 'typed-mutation',
  fmg: 'typed-mutation',
  param: 'typed-mutation',
  emevd: 'typed-mutation',
  script: 'whole-inner-file-replacement',
  tae: 'typed-mutation',
  esd: 'typed-mutation'
} as const);

function assertReviewedEditorContract(
  inventory: ReleaseEditorInventoryItem[]
): { editorIds: string[]; transitionEditorIds: string[] } {
  const editorIds = Object.keys(REVIEWED_EDITOR_MUTATION_MODES);
  const inventoryIds = inventory.map((item) => item.releaseEditorId);
  if (JSON.stringify(inventoryIds) !== JSON.stringify(editorIds)) {
    throw new Error(
      `core editor inventory differs from the reviewed fixture: ${JSON.stringify(inventoryIds)}`
    );
  }
  if (EDITOR_CAPABILITY_CONTRACTS.script.mutationKinds.length !== 0) {
    throw new Error('script whole-inner-file replacement must not be promoted to typed mutation');
  }
  return { editorIds, transitionEditorIds: [] };
}

/**
 * 过渡期编辑器（msb/flver）的正向断言：既有 typed write 链可以继续开发，
 * 但它们不因本次范围过渡自动进入当前 release inventory；
 * 这只验证契约投影，不替代 native、Patch Engine、重读/恢复或 release Gate。
 */
function assertReopenedWriteEditors(): void {
  const msb = EDITOR_CAPABILITY_CONTRACTS.msb;
  if (msb.proposedReleaseEditorId !== null || msb.proposalOrder !== null) {
    throw new Error('msb must remain outside the current release inventory');
  }
  if (msb.releaseWriteEnabled !== true || msb.deferredPreview !== null) {
    throw new Error('msb must be write-enabled without a deferred preview contract (S36)');
  }
  if (isDeferredPreviewEditorKind('msb')) {
    throw new Error('shared deferred projection must not mark msb after S36 reopened writes');
  }
  for (const mutationKind of msb.mutationKinds) {
    if (!editorAllowsMutation('msb', mutationKind)) {
      throw new Error(`msb must allow its implemented mutation ${mutationKind} after S36`);
    }
  }

  const flver = EDITOR_CAPABILITY_CONTRACTS.flver;
  if (flver.proposedReleaseEditorId !== null || flver.proposalOrder !== null) {
    throw new Error('flver must remain outside the current release inventory');
  }
  if (flver.releaseWriteEnabled !== true || flver.deferredPreview !== null) {
    throw new Error('flver must be write-enabled without a deferred preview contract (S38)');
  }
  if (!flver.mutationKinds.includes('flver_material_slot_set')) {
    throw new Error('flver must declare its implemented material-slot-set mutation after S38');
  }
  if (isDeferredPreviewEditorKind('flver')) {
    throw new Error('shared deferred projection must not mark flver after S38 reopened writes');
  }
  for (const mutationKind of flver.mutationKinds) {
    if (!editorAllowsMutation('flver', mutationKind)) {
      throw new Error(`flver must allow its implemented mutation ${mutationKind} after S38`);
    }
  }
}

function assertReadOnlyHexAndAssetExclusions(): void {
  const hex = EDITOR_CAPABILITY_CONTRACTS.hex;
  const raw = EDITOR_CAPABILITY_CONTRACTS.raw;
  const msb = EDITOR_CAPABILITY_CONTRACTS.msb;
  const flver = EDITOR_CAPABILITY_CONTRACTS.flver;
  if (hex.proposedReleaseEditorId !== null
    || hex.releaseWriteEnabled !== false
    || raw.releaseWriteEnabled !== false
    || hex.mutationKinds.length !== 0
    || raw.mutationKinds.length !== 0
    || msb.proposedReleaseEditorId !== null
    || flver.proposedReleaseEditorId !== null) {
    throw new Error('Hex/raw evidence views and non-inventory asset editors must not be promoted into release inventory');
  }

  const root = resolve('../..');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  for (const forbiddenRendererChannel of [
    'resource.capabilities',
    'resource.saveRawReplace',
    'resource.saveRawByteRange'
  ]) {
    if (preload.includes(forbiddenRendererChannel)
      || ipc.includes(`'${forbiddenRendererChannel}'`)) {
      throw new Error(
        `renderer raw capability/write IPC must not be exposed: ${forbiddenRendererChannel}`
      );
    }
  }
}

function assertScaleContractsMatchCurrentSources(): void {
  const root = resolve('../..');
  // Renderer editor panels were removed from the repository (renderer UI
  // deleted); these checks now cover only the core sources that remain the
  // single bounded-access authority shared by any future UI.
  const sourceChecks: Array<[string, string[]]> = [
    [
      'packages/core/src/preview/openResourcePreview.ts',
      ['const DEFAULT_MAX_BYTES = 64 * 1024', 'truncated']
    ],
    [
      'packages/core/src/editing/paramBridgeCommit.ts',
      ['const maxRows = input.maxRows ?? 500', '.slice(0, maxRows)']
    ],
    [
      'packages/core/src/emevd/dslRenderer.ts',
      ['renderEmevdPatchDslBounded', 'EMEVD_DSL_TEMPLATE_TRUNCATED']
    ],
    [
      'packages/core/src/editing/emevdFullDocument.ts',
      ['instructionPageSize', 'readFullEmevdDocumentViaBridge']
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
  schemas: ReturnType<typeof buildReleaseEditorFunctionalScaleSchemas>,
  inventory: ReleaseEditorInventoryItem[]
): void {
  if (schemas.length !== inventory.length) {
    throw new Error('expected one functional schema per current release editor contract');
  }
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
    authorityLevel: 'partial',
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

main();
