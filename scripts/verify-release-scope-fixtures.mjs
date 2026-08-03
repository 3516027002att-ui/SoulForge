import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from './subprocess-control.mjs';

const root = resolve(import.meta.dirname, '..');

/**
 * 提案块内侧包着一层投影标记（该块是 scope.json + gates.json 的投影）。
 * 标记是可选的：fixture 会构造不含标记的变体，两种形态都必须能取出提案。
 *
 * 声明必须在顶层最先执行的语句之前——本文件用 top-level await 直接跑用例，
 * const 放到函数定义旁边会撞上 TDZ（实测 ReferenceError: Cannot access before
 * initialization），因为第一个用例在 const 求值之前就调用了 extractProposal。
 */
const PROPOSAL_BLOCK_PATTERN =
  /(<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->\s*(?:<!--\s*SOULFORGE_PROJECTION_BEGIN:scope-proposal\s*-->\s*)?```json\s*)([\s\S]*?)(\s*```\s*(?:<!--\s*SOULFORGE_PROJECTION_END:scope-proposal\s*-->\s*)?<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->)/;

const source = await readFile(resolve(root, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md'), 'utf8');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'soulforge-release-scope-'));
const cases = [];

try {
  await expectResult('canonical-proposal', source, 0, 'proposal-valid');
  await expectResult('canonical-strict-frozen', source, 0, 'scope-approved', false);

  const pendingProposal = extractProposal(source);
  pendingProposal.proposalStatus = 'awaiting-user-ruling';
  pendingProposal.gameBuildRange.status = 'pending-user-ruling';
  pendingProposal.gameBuildRange.versionFamilies = [];
  pendingProposal.gameBuildRange.exactBuilds = [];
  pendingProposal.ruling = {
    status: 'pending-user-ruling',
    approvedBy: null,
    approvedAt: null,
    decisionRef: null
  };
  for (const item of pendingProposal.scopeItems) {
    item.decisionStatus = 'awaiting-user-ruling';
    item.openRulings = ['fixture pending user ruling'];
  }
  await expectResult(
    'strict-mode-fails-before-ruling',
    replaceProposal(source, pendingProposal),
    1,
    'RELEASE_SCOPE_NOT_FROZEN',
    false
  );

  await expectRejected('duplicate-scope-item', (proposal) => {
    proposal.scopeItems.push(structuredClone(proposal.scopeItems[0]));
  }, 'SCOPE_ITEM_ID_DUPLICATE');

  await expectRejected('missing-gate-coverage', (proposal) => {
    proposal.gateCoverage.pop();
  }, 'GATE_COVERAGE_MISSING');

  await expectRejected('unknown-evidence', (proposal) => {
    proposal.scopeItems[0].evidenceRefs = ['EV-NOT-DEFINED'];
  }, 'EVIDENCE_REF_UNKNOWN');

  await expectRejected('private-fixture-masquerade', (proposal) => {
    proposal.corpusPolicy.privateFixtureRegistryIsReleaseCorpus = true;
  }, 'PRIVATE_FIXTURE_RELEASE_AUTHORITY_INVALID');

  await expectRejected('absolute-path-leak', (proposal) => {
    proposal.scopeItems[0].nonClaims.push('C:/Users/example/private/sample.bin');
  }, 'ABSOLUTE_PATH_FORBIDDEN');

  await expectRejected('status-only-fake-approval', (proposal) => {
    proposal.ruling.approvedBy = '';
  }, 'RULING_APPROVER_MISSING');

  await expectRejected('broad-version-family', (proposal) => {
    proposal.gameBuildRange.versionFamilies = ['1.6.x'];
  }, 'APPROVED_GAME_VERSION_FAMILY_INVALID');

  await expectRejected('unknown-build-not-fail-closed', (proposal) => {
    proposal.gameBuildRange.unknownBuildPolicy = 'warn-and-continue';
  }, 'GAME_UNKNOWN_BUILD_POLICY_INVALID');

  await expectRejected('semantic-dsl-removed', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.operations = editors.operations.filter((operation) => operation !== 'project-canonical-dsl');
  }, 'FROZEN_OPERATION_MISSING');

  await expectRejected('raw-hex-boundary-removed', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.unsupportedOperations = editors.unsupportedOperations.filter((operation) => operation !== 'raw-hex-edit');
  }, 'FROZEN_UNSUPPORTED_BOUNDARY_MISSING');

  await expectRejected('frozen-editor-membership-drift', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.editorIds[0] = 'safe-hex';
  }, 'FROZEN_EDITOR_MATRIX_INVALID');

  await expectRejected('writable-hex-reintroduced', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.hexEvidenceView.writable = true;
  }, 'FROZEN_HEX_EVIDENCE_POLICY_INVALID');

  await expectRejected('live-authority-field-reintroduced', (proposal) => {
    proposal.scopeItems[0].currentAuthority = proposal.scopeItems[0].authorityAtRuling;
    delete proposal.scopeItems[0].authorityAtRuling;
  }, 'LEGACY_CURRENT_AUTHORITY_FORBIDDEN');

  await expectRejected('authority-snapshot-source-drift', (proposal) => {
    proposal.authoritySnapshotPolicy.liveAuthoritySource = 'scope-items';
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('external-distribution-boundary-removed', (proposal) => {
    const compliance = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-COMPLIANCE');
    compliance.unsupportedOperations = compliance.unsupportedOperations.filter((operation) => operation !== 'external-distribution');
  }, 'FROZEN_UNSUPPORTED_BOUNDARY_MISSING');

  await expectRejected('unsigned-nsis-hash-removed', (proposal) => {
    const release = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RELEASE');
    release.operations = release.operations.filter((operation) => operation !== 'verify-installer-artifact-hash');
  }, 'FROZEN_OPERATION_MISSING');

  await expectRejected('code-signing-reintroduced', (proposal) => {
    const release = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RELEASE');
    release.operations.push('package-signed-nsis-x64');
  }, 'FROZEN_OPERATION_FORBIDDEN');

  await expectRejected('legacy-sign-operation-reintroduced', (proposal) => {
    const release = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RELEASE');
    release.operations.push('sign');
  }, 'FROZEN_OPERATION_FORBIDDEN');

  await expectRejected('smithbox-source-revision-drift', (proposal) => {
    proposal.paramMetadataSourcePolicy.sourceCommit = '0000000000000000000000000000000000000000';
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('smithbox-redistribution-reintroduced', (proposal) => {
    proposal.paramMetadataSourcePolicy.redistribution = 'bundled';
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('real-provider-credentials-required', (proposal) => {
    proposal.providerCredentialPolicy.realProviderCredentialsRequiredForV05Acceptance = true;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('offline-provider-conformance-removed', (proposal) => {
    const ai = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-AI');
    ai.operations = ai.operations.filter((operation) => operation !== 'offline-protocol-conformance');
  }, 'FROZEN_OPERATION_MISSING');

  await expectRejected('me3-provisioning-shifted-to-user', (proposal) => {
    proposal.runtimeToolPolicy.provisioningResponsibility = 'repository-owner';
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('representative-render-hardware-reintroduced', (proposal) => {
    proposal.renderingAcceptancePolicy.representativeHardwareTiersRequired = true;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('editor-quantitative-threshold-reintroduced', (proposal) => {
    proposal.quantitativeAcceptancePolicy.editorCapacityOrLatencyThresholdsRequired = true;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('installer-quantitative-budget-reintroduced', (proposal) => {
    proposal.quantitativeAcceptancePolicy.installerSizeOrTimeBudgetsRequired = true;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('bounded-editor-access-removed', (proposal) => {
    proposal.quantitativeAcceptancePolicy.boundedEditorAccessRequired = false;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('installer-lifecycle-integrity-removed', (proposal) => {
    proposal.quantitativeAcceptancePolicy.installerLifecycleIntegrityRequired = false;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('editor-no-threshold-boundary-removed', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.unsupportedOperations = editors.unsupportedOperations.filter(
      (operation) => operation !== 'quantitative-capacity-or-latency-threshold-as-v05-gate'
    );
  }, 'FROZEN_UNSUPPORTED_BOUNDARY_MISSING');

  await expectRejected('installer-no-budget-boundary-removed', (proposal) => {
    const release = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RELEASE');
    release.unsupportedOperations = release.unsupportedOperations.filter(
      (operation) => operation !== 'installer-size-or-time-budget-as-v05-gate'
    );
  }, 'FROZEN_UNSUPPORTED_BOUNDARY_MISSING');

  await expectRejected('render-benchmark-gate-reintroduced', (proposal) => {
    const rendering = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RENDERING');
    rendering.operations.push('benchmark-both-backends');
  }, 'FROZEN_OPERATION_FORBIDDEN');

  // REL-C 在 §18.3 为 open：把它伪装成 passed 必须被漂移检查拒绝。
  // （历史上此处用 REL-A；REL-A 已推进为 passed，伪装与现状一致不再构成负例。）
  await expectRejected('gate-pass-masquerade', (proposal) => {
    const relC = proposal.gateCoverage.find((gate) => gate.gateId === 'REL-C');
    relC.currentState = 'passed';
    relC.blockerRefs = [];
  }, 'GATE_COVERAGE_STATE_DRIFT');

  await expectRejected('deferred-item-without-target-release', (proposal) => {
    const rendering = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RENDERING');
    delete rendering.deferredToRelease;
  }, 'DEFERRED_RELEASE_INVALID');

  await expectRejected('deferred-item-claims-v05-operation', (proposal) => {
    const rendering = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RENDERING');
    rendering.operations.push('render-flver-msb-collision-navigation');
  }, 'DEFERRED_OPERATIONS_FORBIDDEN');

  await expectRejected('supported-item-claims-deferred-release', (proposal) => {
    const fmg = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-FMG');
    fmg.deferredToRelease = 'V0.6';
  }, 'DEFERRED_RELEASE_UNEXPECTED');

  await expectRejected('deferred-item-targets-unapproved-release', (proposal) => {
    const rendering = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RENDERING');
    rendering.deferredToRelease = 'V0.7';
  }, 'DEFERRED_RELEASE_INVALID');

  await expectRejected('deferred-gate-carries-blocker', (proposal) => {
    const relI = proposal.gateCoverage.find((gate) => gate.gateId === 'REL-I');
    relI.blockerRefs = ['BLK-RENDER-HARDWARE'];
  }, 'DEFERRED_GATE_WITH_BLOCKER');

  await expectRejected('deferred-gate-still-has-supported-scope', (proposal) => {
    const rendering = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-RENDERING');
    rendering.proposedSupport = 'supported';
    delete rendering.deferredToRelease;
    rendering.operations = ['functional-backend-smoke-on-owner-machine'];
  }, 'DEFERRED_GATE_WITH_SUPPORTED_SCOPE');

  await expectRejected('fully-deferred-gate-written-as-open', (proposal) => {
    const relI = proposal.gateCoverage.find((gate) => gate.gateId === 'REL-I');
    relI.currentState = 'open';
  }, 'FULLY_DEFERRED_GATE_STATE_INVALID');

  await expectRejected('deferred-preview-editor-counted-as-release', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.deferredPreviewEditors.countedAsReleaseEditor = true;
  }, 'DEFERRED_PREVIEW_EDITOR_POLICY_INVALID');

  await expectRejected('deferred-preview-editor-made-writable', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.deferredPreviewEditors.readOnly = false;
  }, 'DEFERRED_PREVIEW_EDITOR_POLICY_INVALID');

  await expectRejected('deferred-preview-editor-promoted-into-release-set', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.deferredPreviewEditors.editorIds = ['msb', 'tae', 'esd', 'flver', 'param'];
  }, 'DEFERRED_PREVIEW_EDITOR_SET_INVALID');

  await expectRejected('script-editor-claimed-as-typed-mutation', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.editorMutationModes.script = 'typed-mutation';
  }, 'FROZEN_EDITOR_MUTATION_MODE_INVALID');

  await expectRejected('deferred-editor-reintroduced-into-frozen-set', (proposal) => {
    const editors = proposal.scopeItems.find((item) => item.scopeItemId === 'SCOPE-EDITORS');
    editors.editorIds.push('msb');
  }, 'FROZEN_EDITOR_MATRIX_INVALID');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  status: 'passed',
  caseCount: cases.length,
  cases
}, null, 2));

async function expectRejected(name, mutate, expectedCode) {
  const proposal = extractProposal(source);
  mutate(proposal);
  await expectResult(name, replaceProposal(source, proposal), 1, expectedCode);
}

async function expectResult(name, document, expectedExit, expectedToken, proposalMode = true) {
  const input = join(temporaryRoot, `${name}.md`);
  await writeFile(input, document, 'utf8');
  const args = ['scripts/verify-release-scope.mjs'];
  if (proposalMode) args.push('--proposal');
  args.push(`--input=${input}`);
  const result = await runProcess({
    command: process.execPath,
    args,
    cwd: root,
    timeoutMs: 10_000
  });
  if (result.timedOut || result.cancelled || result.code !== expectedExit) {
    throw new Error(`${name}: expected exit ${expectedExit}, got ${result.code}; ${result.stderr}`);
  }
  if (!result.stdout.includes(expectedToken)) {
    throw new Error(`${name}: output did not contain ${expectedToken}: ${result.stdout}`);
  }
  cases.push({ name, expectedExit, expectedToken });
}

function extractProposal(document) {
  const match = document.match(PROPOSAL_BLOCK_PATTERN);
  if (!match) throw new Error('canonical proposal block missing');
  return JSON.parse(match[2]);
}

function replaceProposal(document, proposal) {
  const serialized = JSON.stringify(proposal, null, 2);
  return document.replace(PROPOSAL_BLOCK_PATTERN, `$1${serialized}\n$3`);
}
