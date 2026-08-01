import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFERRED_PREVIEW_EDITOR_KINDS,
  isDeferredPreviewEditorKind,
  type EditorKind
} from '@soulforge/shared';
import {
  EDITOR_CAPABILITY_CONTRACTS,
  buildProposedReleaseEditorInventory,
  buildReleaseEditorFunctionalScaleSchemas,
  editorAllowsMutation,
  evaluateReleaseEditorAcceptance,
  listDeferredPreviewEditors,
  type EditorScaleSample,
  type ProposedReleaseEditorId,
  type ReleaseEditorAcceptanceResult,
  type ReleaseEditorInventoryItem
} from '../index.js';

function main(): void {
  const inventory = buildProposedReleaseEditorInventory();
  const schemas = buildReleaseEditorFunctionalScaleSchemas();
  assertInventoryDerivedFromCapabilities(inventory);
  assertFrozenScopeInventory(inventory);
  assertDeferredPreviewEditorsAreReadOnly();
  assertReadOnlyHexAndAssetExclusions();
  assertScaleContractsMatchCurrentSources();
  assertFunctionalSchemasHaveNoQuantitativeThresholds(schemas);

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
  assertCurrentScaleGap(
    currentScaleContractGaps,
    'script',
    'none',
    'EDITOR_PAGINATION_OR_VIRTUALIZATION_REQUIRED'
  );
  for (const releaseEditorId of ['bnd4', 'fmg', 'param', 'emevd'] as const) {
    const leftover = currentScaleContractGaps.find(
      (item) => item.releaseEditorId === releaseEditorId
    );
    if (leftover) {
      throw new Error(
        `${releaseEditorId} scale gap must be closed (pagination wired): ${JSON.stringify(leftover)}`
      );
    }
  }

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
  // V0.5 冻结清单收窄为五个；msb/tae/esd/flver 已延期至 V0.6，
  // 只保留标记只读预览，不得回到本清单。
  const expectedIds: ProposedReleaseEditorId[] = [
    'bnd4',
    'fmg',
    'param',
    'emevd',
    'script'
  ];
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

function assertFrozenScopeInventory(inventory: ReleaseEditorInventoryItem[]): void {
  const root = resolve('../..');
  const handoff = readFileSync(resolve(root, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md'), 'utf8');
  const match = handoff.match(
    /<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->/
  );
  const proposalJson = match?.[1];
  if (!proposalJson) throw new Error('frozen release-scope proposal is missing');
  const proposal = JSON.parse(proposalJson) as {
    scopeItems?: Array<{
      scopeItemId?: string;
      editorIds?: unknown;
      hexEvidenceView?: { included?: unknown; writable?: unknown };
    }>;
  };
  const editorScope = proposal.scopeItems?.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
  if (!editorScope || !Array.isArray(editorScope.editorIds)) {
    throw new Error('SCOPE-EDITORS must expose the exact frozen editorIds');
  }
  const actualIds = inventory.map((item) => item.releaseEditorId);
  if (JSON.stringify(actualIds) !== JSON.stringify(editorScope.editorIds)) {
    throw new Error(
      `runtime editor inventory drifted from frozen scope: ${JSON.stringify(actualIds)} != ${JSON.stringify(editorScope.editorIds)}`
    );
  }
  if (editorScope.hexEvidenceView?.included !== true
    || editorScope.hexEvidenceView.writable !== false) {
    throw new Error('SCOPE-EDITORS must keep Hex included as a read-only evidence view');
  }
}

/**
 * 已延期至 V0.6 的编辑器允许保留面板，但必须同时满足：
 * 不在 V0.5 冻结清单内、写路径关闭、带 V0.6 只读预览标记。
 * MSB 已有经真实文档验证的 typed mutation 写链，因此这里逐项断言
 * `releaseWriteEnabled=false` 与 `editorAllowsMutation` 实际拒绝，
 * 避免冻结清单外仍存在可写编辑器。
 */
function assertDeferredPreviewEditorsAreReadOnly(): void {
  const expectedDeferred: EditorKind[] = ['msb', 'tae', 'esd', 'flver'];
  const actualDeferred = [...listDeferredPreviewEditors()];
  if (JSON.stringify(actualDeferred) !== JSON.stringify(expectedDeferred)) {
    throw new Error(
      `deferred preview editor set drifted: ${JSON.stringify(actualDeferred)} != ${JSON.stringify(expectedDeferred)}`
    );
  }
  // core 能力契约（写入放行权威）与 shared 投影（renderer 打标来源）
  // 必须逐项一致，否则会出现 UI 显示只读但写路径仍开放的反向漂移。
  const sharedProjection = [...DEFERRED_PREVIEW_EDITOR_KINDS];
  if (JSON.stringify(actualDeferred) !== JSON.stringify(sharedProjection)) {
    throw new Error(
      `core capability contract and shared deferred projection disagree: ${JSON.stringify(actualDeferred)} != ${JSON.stringify(sharedProjection)}`
    );
  }
  for (const editorKind of actualDeferred) {
    if (!isDeferredPreviewEditorKind(editorKind)) {
      throw new Error(`shared projection does not mark ${editorKind} as a deferred preview editor`);
    }
  }
  for (const editorKind of expectedDeferred) {
    const contract = EDITOR_CAPABILITY_CONTRACTS[editorKind];
    if (contract.proposedReleaseEditorId !== null || contract.proposalOrder !== null) {
      throw new Error(`${editorKind} is deferred to V0.6 and must not claim a V0.5 release editor slot`);
    }
    if (contract.releaseWriteEnabled !== false) {
      throw new Error(`${editorKind} is deferred to V0.6 and must keep its write path closed`);
    }
    if (contract.deferredPreview?.deferredToRelease !== 'V0.6'
      || contract.deferredPreview.readOnly !== true
      || contract.deferredPreview.markedAsPreview !== true
      || contract.deferredPreview.countedAsReleaseEditor !== false) {
      throw new Error(`${editorKind} must declare a marked V0.6 read-only preview contract`);
    }
    for (const mutationKind of contract.mutationKinds) {
      if (editorAllowsMutation(editorKind, mutationKind)) {
        throw new Error(
          `${editorKind} still accepts ${mutationKind} while deferred to V0.6 as a read-only preview`
        );
      }
    }
  }

  // script 在 V0.5 只做只读证据投影 + 整个内层文件替换，不得声称 typed mutation。
  const script = EDITOR_CAPABILITY_CONTRACTS.script;
  if (script.proposedReleaseEditorId !== 'script'
    || script.releaseWriteEnabled !== true
    || script.deferredPreview !== null
    || script.mutationKinds.length !== 0) {
    throw new Error('script editor must stay in V0.5 as whole-inner-file replacement without typed mutation');
  }
}

function assertReadOnlyHexAndAssetExclusions(): void {
  const hex = EDITOR_CAPABILITY_CONTRACTS.hex;
  const raw = EDITOR_CAPABILITY_CONTRACTS.raw;
  const flver = EDITOR_CAPABILITY_CONTRACTS.flver;
  if (hex.proposedReleaseEditorId !== null
    || hex.mutationKinds.length !== 0
    || raw.mutationKinds.length !== 0) {
    throw new Error('Hex/raw evidence views must not expose release editor mutations');
  }
  if (flver.proposedReleaseEditorId !== null) {
    throw new Error('FLVER is a read-only asset view, not one of the frozen V0.5 semantic editors');
  }

  const root = resolve('../..');
  const panel = readFileSync(
    resolve(root, 'apps/desktop/src/renderer/src/editors/HexEditorPanel.tsx'),
    'utf8'
  );
  const app = readFileSync(resolve(root, 'apps/desktop/src/renderer/src/App.tsx'), 'utf8');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  for (const forbidden of ['onPatch', 'patchFirstByte', 'hex_byte_patch', '翻转本页首字节']) {
    if (panel.includes(forbidden)) {
      throw new Error(`read-only Hex panel still exposes ${forbidden}`);
    }
  }
  if (/<HexEditorPanel[\s\S]{0,500}\bonPatch=/u.test(app)) {
    throw new Error('App still wires a Hex mutation callback');
  }
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
      ['readFmgPage', 'FMG_PAGE_SIZE', 'pageCount', 'pageEntries']
    ],
    [
      'apps/desktop/src/renderer/src/editors/ParamTablePanel.tsx',
      ['readParamPage', 'PARAM_PAGE_SIZE', 'pageCount', 'pageRows']
    ],
    [
      'apps/desktop/src/renderer/src/editors/ParamDefPanel.tsx',
      ['readParamPage', 'PAGE_SIZE', 'pageCount', 'pageRows']
    ],
    [
      'apps/desktop/src/renderer/src/editors/Bnd4WorkbenchPanel.tsx',
      ['listContainerChildrenPage', 'pageCount', 'pageChildren']
    ],
    [
      'packages/core/src/editing/paramBridgeCommit.ts',
      ['const maxRows = input.maxRows ?? 500', '.slice(0, maxRows)']
    ],
    [
      'apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx',
      ['pageEvents.map', 'EVENTS_PAGE_SIZE']
    ],
    [
      'packages/core/src/emevd/dslRenderer.ts',
      ['renderEmevdPatchDslBounded', 'EMEVD_DSL_TEMPLATE_TRUNCATED']
    ],
    [
      'packages/core/src/editing/emevdFullDocument.ts',
      ['instructionPageSize', 'readFullEmevdDocumentViaBridge']
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
  if (schemas.length !== 5) throw new Error('expected one functional schema per V0.5 release editor');
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
