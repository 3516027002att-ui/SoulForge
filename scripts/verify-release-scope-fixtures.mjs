import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from './subprocess-control.mjs';

const root = resolve(import.meta.dirname, '..');
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

  await expectRejected('gate-pass-masquerade', (proposal) => {
    const relA = proposal.gateCoverage.find((gate) => gate.gateId === 'REL-A');
    relA.currentState = 'passed';
    relA.blockerRefs = [];
  }, 'GATE_COVERAGE_STATE_DRIFT');
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
  const match = document.match(
    /<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->/
  );
  if (!match) throw new Error('canonical proposal block missing');
  return JSON.parse(match[1]);
}

function replaceProposal(document, proposal) {
  const serialized = JSON.stringify(proposal, null, 2);
  return document.replace(
    /(<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->\s*```json\s*)[\s\S]*?(\s*```\s*<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->)/,
    `$1${serialized}\n$2`
  );
}
