/**
 * 范围门禁的负向 fixture。
 *
 * 注入通道扰动的是治理 JSON（docs/governance/scope.json + gates.json），
 * 不是交接书。此前扰动的是 §18.2.1 里那份 1467 行内嵌 JSON——门禁只解析
 * 那个块，所以 fixture 也只能改它。那意味着这 38 条负例证明的是「markdown
 * 副本被改坏时门禁会红」，而真实退化发生在权威 JSON 里：副本与权威分叉了
 * 27/27 条，全部 fixture 照旧全绿。
 *
 * 现在门禁读治理 JSON，fixture 把扰动写进临时 governance root 再用
 * --governance-root 指过去。--input 仍指真实交接书：markdown 侧的 §3.1/§18.1/
 * §17.1/§18.3/§18.4 五张索引表仍是交叉引用的判定源，不该被 fixture 换掉。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from './subprocess-control.mjs';

const root = resolve(import.meta.dirname, '..');

const HANDOFF = resolve(root, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md');
const scopeSource = JSON.parse(await readFile(resolve(root, 'docs/governance/scope.json'), 'utf8'));
const gatesSource = JSON.parse(await readFile(resolve(root, 'docs/governance/gates.json'), 'utf8'));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'soulforge-release-scope-'));
const cases = [];

try {
  await expectResult('canonical-proposal', {}, 0, 'proposal-valid');
  await expectResult('canonical-strict-frozen', {}, 0, 'scope-approved', false);

  await expectResult(
    'strict-mode-fails-before-ruling',
    (scope) => {
      scope.proposalStatus = 'awaiting-user-ruling';
      scope.gameBuildRange.status = 'pending-user-ruling';
      scope.gameBuildRange.versionFamilies = [];
      scope.gameBuildRange.exactBuilds = [];
      scope.ruling = {
        status: 'pending-user-ruling',
        approvedBy: null,
        approvedAt: null,
        decisionRef: null
      };
      for (const entry of scope.scopeItems) {
        entry.decisionStatus = 'awaiting-user-ruling';
        entry.openRulings = ['fixture pending user ruling'];
      }
    },
    1,
    'RELEASE_SCOPE_NOT_FROZEN',
    false
  );

  await expectRejected('duplicate-scope-item', (scope) => {
    scope.scopeItems.push(structuredClone(scope.scopeItems[0]));
  }, 'SCOPE_ITEM_ID_DUPLICATE');

  // 删 gates.json 的最后一条（REL-COMPLIANCE）：提案的 gateCoverage 由它派生，
  // 少一条就对不上门禁内置的 EXPECTED_GATES。
  await expectRejected('missing-gate-coverage', (scope, gates) => {
    gates.gates.pop();
  }, 'GATE_COVERAGE_MISSING');

  await expectRejected('unknown-evidence', (scope) => {
    scope.scopeItems[0].evidenceRefs = ['EV-NOT-DEFINED'];
  }, 'EVIDENCE_REF_UNKNOWN');

  await expectRejected('private-fixture-masquerade', (scope) => {
    scope.corpusPolicy.privateFixtureRegistryIsReleaseCorpus = true;
  }, 'PRIVATE_FIXTURE_RELEASE_AUTHORITY_INVALID');

  // 这条现在真的证明了它该证明的事：绝对路径检查改读 scope.json 装配出的提案，
  // 此前扰动 markdown 副本时，权威里的绝对路径不会被这条负例覆盖。
  await expectRejected('absolute-path-leak', (scope) => {
    scope.scopeItems[0].nonClaims.push('C:/Users/example/private/sample.bin');
  }, 'ABSOLUTE_PATH_FORBIDDEN');

  await expectRejected('status-only-fake-approval', (scope) => {
    scope.ruling.approvedBy = '';
  }, 'RULING_APPROVER_MISSING');

  await expectRejected('broad-version-family', (scope) => {
    scope.gameBuildRange.versionFamilies = ['1.6.x'];
  }, 'APPROVED_GAME_VERSION_FAMILY_INVALID');

  await expectRejected('unknown-build-not-fail-closed', (scope) => {
    scope.gameBuildRange.unknownBuildPolicy = 'warn-and-continue';
  }, 'GAME_UNKNOWN_BUILD_POLICY_INVALID');

  await expectRejected('semantic-dsl-removed', (scope) => {
    const editors = item(scope, 'SCOPE-EDITORS');
    editors.operations = editors.operations.filter((operation) => operation !== 'project-canonical-dsl');
  }, 'FROZEN_OPERATION_MISSING');

  await expectRejected('raw-hex-boundary-removed', (scope) => {
    const editors = item(scope, 'SCOPE-EDITORS');
    editors.unsupportedOperations = editors.unsupportedOperations.filter((operation) => operation !== 'raw-hex-edit');
  }, 'FROZEN_UNSUPPORTED_BOUNDARY_MISSING');

  await expectRejected('frozen-editor-membership-drift', (scope) => {
    item(scope, 'SCOPE-EDITORS').editorIds[0] = 'safe-hex';
  }, 'FROZEN_EDITOR_MATRIX_INVALID');

  await expectRejected('writable-hex-reintroduced', (scope) => {
    item(scope, 'SCOPE-EDITORS').hexEvidenceView.writable = true;
  }, 'FROZEN_HEX_EVIDENCE_POLICY_INVALID');

  await expectRejected('live-authority-field-reintroduced', (scope) => {
    scope.scopeItems[0].currentAuthority = scope.scopeItems[0].authorityAtRuling;
    delete scope.scopeItems[0].authorityAtRuling;
  }, 'LEGACY_CURRENT_AUTHORITY_FORBIDDEN');

  await expectRejected('authority-snapshot-source-drift', (scope) => {
    scope.authoritySnapshotPolicy.liveAuthoritySource = 'scope-items';
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('external-distribution-boundary-removed', (scope) => {
    const compliance = item(scope, 'SCOPE-COMPLIANCE');
    compliance.unsupportedOperations = compliance.unsupportedOperations.filter((operation) => operation !== 'external-distribution');
  }, 'FROZEN_UNSUPPORTED_BOUNDARY_MISSING');

  await expectRejected('unsigned-nsis-hash-removed', (scope) => {
    const release = item(scope, 'SCOPE-RELEASE');
    release.operations = release.operations.filter((operation) => operation !== 'verify-installer-artifact-hash');
  }, 'FROZEN_OPERATION_MISSING');

  await expectRejected('code-signing-reintroduced', (scope) => {
    item(scope, 'SCOPE-RELEASE').operations.push('package-signed-nsis-x64');
  }, 'FROZEN_OPERATION_FORBIDDEN');

  await expectRejected('legacy-sign-operation-reintroduced', (scope) => {
    item(scope, 'SCOPE-RELEASE').operations.push('sign');
  }, 'FROZEN_OPERATION_FORBIDDEN');

  await expectRejected('smithbox-source-revision-drift', (scope) => {
    scope.paramMetadataSourcePolicy.sourceCommit = '0000000000000000000000000000000000000000';
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('smithbox-redistribution-reintroduced', (scope) => {
    scope.paramMetadataSourcePolicy.redistribution = 'bundled';
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('real-provider-credentials-required', (scope) => {
    scope.providerCredentialPolicy.realProviderCredentialsRequiredForV05Acceptance = true;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('offline-provider-conformance-removed', (scope) => {
    const ai = item(scope, 'SCOPE-AI');
    ai.operations = ai.operations.filter((operation) => operation !== 'offline-protocol-conformance');
  }, 'FROZEN_OPERATION_MISSING');

  await expectRejected('me3-provisioning-shifted-to-user', (scope) => {
    scope.runtimeToolPolicy.provisioningResponsibility = 'repository-owner';
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('representative-render-hardware-reintroduced', (scope) => {
    scope.renderingAcceptancePolicy.representativeHardwareTiersRequired = true;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('editor-quantitative-threshold-reintroduced', (scope) => {
    scope.quantitativeAcceptancePolicy.editorCapacityOrLatencyThresholdsRequired = true;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('installer-quantitative-budget-reintroduced', (scope) => {
    scope.quantitativeAcceptancePolicy.installerSizeOrTimeBudgetsRequired = true;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('bounded-editor-access-removed', (scope) => {
    scope.quantitativeAcceptancePolicy.boundedEditorAccessRequired = false;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('installer-lifecycle-integrity-removed', (scope) => {
    scope.quantitativeAcceptancePolicy.installerLifecycleIntegrityRequired = false;
  }, 'FROZEN_POLICY_VALUE_INVALID');

  await expectRejected('editor-no-threshold-boundary-removed', (scope) => {
    const editors = item(scope, 'SCOPE-EDITORS');
    editors.unsupportedOperations = editors.unsupportedOperations.filter(
      (operation) => operation !== 'quantitative-capacity-or-latency-threshold-as-v05-gate'
    );
  }, 'FROZEN_UNSUPPORTED_BOUNDARY_MISSING');

  await expectRejected('installer-no-budget-boundary-removed', (scope) => {
    const release = item(scope, 'SCOPE-RELEASE');
    release.unsupportedOperations = release.unsupportedOperations.filter(
      (operation) => operation !== 'installer-size-or-time-budget-as-v05-gate'
    );
  }, 'FROZEN_UNSUPPORTED_BOUNDARY_MISSING');

  await expectRejected('render-benchmark-gate-reintroduced', (scope) => {
    item(scope, 'SCOPE-RENDERING').operations.push('benchmark-both-backends');
  }, 'FROZEN_OPERATION_FORBIDDEN');

  // REL-C 在 §18.3 为 open：把它伪装成 passed 必须被漂移检查拒绝。
  // （历史上此处用 REL-A；REL-A 已推进为 passed，伪装与现状一致不再构成负例。）
  await expectRejected('gate-pass-masquerade', (scope, gates) => {
    const relC = gate(gates, 'REL-C');
    relC.gateState = 'passed';
    relC.blockerRefs = [];
  }, 'GATE_COVERAGE_STATE_DRIFT');

  await expectRejected('deferred-item-without-target-release', (scope) => {
    delete item(scope, 'SCOPE-ASSET-MTD').deferredToRelease;
  }, 'DEFERRED_RELEASE_INVALID');

  await expectRejected('deferred-item-claims-v05-operation', (scope) => {
    item(scope, 'SCOPE-ASSET-MTD').operations.push('read-mtd-native-document');
  }, 'DEFERRED_OPERATIONS_FORBIDDEN');

  await expectRejected('supported-item-claims-deferred-release', (scope) => {
    item(scope, 'SCOPE-FMG').deferredToRelease = 'V0.6';
  }, 'DEFERRED_RELEASE_UNEXPECTED');

  await expectRejected('deferred-item-targets-unapproved-release', (scope) => {
    item(scope, 'SCOPE-ASSET-MTD').deferredToRelease = 'V0.7';
  }, 'DEFERRED_RELEASE_INVALID');

  // V0.6 承接后真实数据已无 deferred Gate（REL-E/REL-I 恢复 passed），
  // 下面三条从 REL-I 反造 deferred 状态，验证延期 Gate 规则仍会触发。
  await expectRejected('deferred-gate-carries-blocker', (scope, gates) => {
    const relI = gate(gates, 'REL-I');
    relI.gateState = 'deferred';
    relI.blockerRefs = ['BLK-RENDER-HARDWARE'];
  }, 'DEFERRED_GATE_WITH_BLOCKER');

  await expectRejected('deferred-gate-still-has-supported-scope', (scope, gates) => {
    gate(gates, 'REL-I').gateState = 'deferred';
  }, 'DEFERRED_GATE_WITH_SUPPORTED_SCOPE');

  await expectRejected('fully-deferred-gate-written-as-open', (scope, gates) => {
    const rendering = item(scope, 'SCOPE-RENDERING');
    rendering.proposedSupport = 'deferred';
    rendering.deferredToRelease = 'V0.6';
    rendering.operations = [];
    gate(gates, 'REL-I').gateState = 'open';
  }, 'FULLY_DEFERRED_GATE_STATE_INVALID');

  await expectRejected('deferred-preview-editor-counted-as-release', (scope) => {
    item(scope, 'SCOPE-EDITORS').deferredPreviewEditors.countedAsReleaseEditor = true;
  }, 'DEFERRED_PREVIEW_EDITOR_POLICY_INVALID');

  await expectRejected('deferred-preview-editor-made-writable', (scope) => {
    item(scope, 'SCOPE-EDITORS').deferredPreviewEditors.readOnly = false;
  }, 'DEFERRED_PREVIEW_EDITOR_POLICY_INVALID');

  await expectRejected('deferred-preview-editor-promoted-into-release-set', (scope) => {
    item(scope, 'SCOPE-EDITORS').deferredPreviewEditors.editorIds = ['msb', 'tae', 'esd', 'flver', 'param'];
  }, 'DEFERRED_PREVIEW_EDITOR_SET_INVALID');

  await expectRejected('script-editor-claimed-as-typed-mutation', (scope) => {
    item(scope, 'SCOPE-EDITORS').editorMutationModes.script = 'typed-mutation';
  }, 'FROZEN_EDITOR_MUTATION_MODE_INVALID');

  await expectRejected('deferred-editor-reintroduced-into-frozen-set', (scope) => {
    item(scope, 'SCOPE-EDITORS').editorIds.push('msb');
  }, 'FROZEN_EDITOR_MATRIX_INVALID');

  // scope.json 新增字段但没进提案键序：装配层会静默漏投，这条挡住它。
  await expectRejected('unprojected-scope-field', (scope) => {
    scope.futurePolicyNobodyValidates = { enabled: true };
  }, 'UNPROJECTED_SCOPE_FIELD');

  // schemaVersion 结构检查。改造后提案的 schemaVersion 就是 scope.json 的
  // 那一个，「提案与权威比对」变成自比恒真；换成 semver 形态判定才有负例可造。
  await expectRejected('schema-version-not-semver', (scope) => {
    scope.schemaVersion = '2.0';
  }, 'SCHEMA_VERSION_INVALID');
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
  await expectResult(name, mutate, 1, expectedCode);
}

/**
 * 把扰动写进独立的临时 governance root 再跑门禁。
 *
 * mutate 收到 (scope, gates) 两份深拷贝，对应 docs/governance 下的两个权威文件。
 * 传 {} 表示不扰动（正向用例）。
 *
 * 每个用例一个目录：共用目录会让前一条的扰动残留到下一条，而门禁全绿看起来
 * 完全正常——那正是「fixture 扰动必须还原」这类坑的形态。一次性目录比
 * 「用完改回去」更强：没有还原步骤可漏。
 */
async function expectResult(name, mutate, expectedExit, expectedToken, proposalMode = true) {
  const governanceRoot = join(temporaryRoot, name);
  await mkdir(governanceRoot, { recursive: true });
  const scope = structuredClone(scopeSource);
  const gates = structuredClone(gatesSource);
  if (typeof mutate === 'function') mutate(scope, gates);
  await writeFile(join(governanceRoot, 'scope.json'), JSON.stringify(scope, null, 2), 'utf8');
  await writeFile(join(governanceRoot, 'gates.json'), JSON.stringify(gates, null, 2), 'utf8');

  const args = ['scripts/verify-release-scope.mjs'];
  if (proposalMode) args.push('--proposal');
  args.push(`--input=${HANDOFF}`, `--governance-root=${governanceRoot}`);
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

/** gates.json 里按 ID 取 Gate。提案侧的 currentState 对应这里的 gateState。 */
function gate(gates, gateId) {
  const found = gates.gates.find((entry) => entry.gateId === gateId);
  if (!found) throw new Error(`fixture 锚点 Gate 不存在：${gateId}`);
  return found;
}

/** scope.json 里按 ID 取条目。找不到就抛——锚点消失时必须失败而不是静默跳过断言。 */
function item(scope, scopeItemId) {
  const found = scope.scopeItems.find((entry) => entry.scopeItemId === scopeItemId);
  if (!found) throw new Error(`fixture 锚点条目不存在：${scopeItemId}`);
  return found;
}
