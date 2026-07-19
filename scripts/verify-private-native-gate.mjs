/**
 * P7 private native gate — runs real native checks when env roots exist,
 * otherwise records an honest skip without claiming V0.5 complete.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessNativeGateStep,
  extractLastJsonObject,
  summarizeNativeGateReport
} from './native-gate-report.mjs';
import {
  loadNativeFixtureRegistry,
  NativeFixtureRegistryError,
  summarizeNativeFixtureRegistry
} from './native-fixture-registry.mjs';
import { runNativeGateCommand } from './native-gate-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch =
  process.env.SOULFORGE_SCRATCH
  ?? resolve(process.env.TEMP ?? '/tmp', 'soulforge-private-native-gate');

const sekiro = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
const nativeFixture = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() || '';
const nativeRegistry = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() || '';
const allowSkip = process.argv.includes('--allow-skip');

await mkdir(scratch, { recursive: true });

const report = {
  ok: true,
  gate: 'private-native',
  timestamp: new Date().toISOString(),
  sekiroRootPresent: Boolean(sekiro),
  nativeFixturePresent: Boolean(nativeFixture),
  nativeRegistryPresent: Boolean(nativeRegistry),
  steps: /** @type {Array<Record<string, unknown>>} */ ([]),
  status: 'unknown',
  message: ''
};

const missingEnvironment = [
  ...(!sekiro ? ['SOULFORGE_SEKIRO_GAME_ROOT'] : []),
  ...(!nativeFixture ? ['SOULFORGE_NATIVE_FIXTURE_ROOT'] : []),
  ...(!nativeRegistry ? ['SOULFORGE_NATIVE_FIXTURE_REGISTRY'] : [])
];

if (missingEnvironment.length > 0) {
  const allPrivateEnvironmentMissing = !sekiro && !nativeFixture && !nativeRegistry;
  report.ok = allowSkip && allPrivateEnvironmentMissing;
  report.status = allPrivateEnvironmentMissing ? 'skipped' : 'failed';
  report.message = allPrivateEnvironmentMissing
    ? `unverified-private-native-environment: 缺少 ${missingEnvironment.join(', ')}；私有 native 门禁未执行。`
    : `incomplete-private-native-environment: 缺少 ${missingEnvironment.join(', ')}；部分配置不得跳过。`;
  report.steps.push({
    name: 'environment',
    ok: report.ok,
    skipped: allPrivateEnvironmentMissing,
    configuration: allPrivateEnvironmentMissing ? 'absent' : 'partial',
    reason: report.message,
    missing: missingEnvironment
  });
  const outPath = resolve(scratch, 'private-native-gate.json');
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
  process.exitCode = report.ok ? 0 : 2;
  process.exit();
}

let registry;
try {
  registry = await loadNativeFixtureRegistry({
    registryPath: nativeRegistry,
    fixtureRoot: nativeFixture
  });
  const requiredRoles = [
    'bnd4-primary', 'fmg-primary', 'param-primary', 'emevd-primary', 'msb-primary'
  ];
  const missingRoles = requiredRoles.filter((role) => !registry.roles[role]);
  const dcxFixtures = registry.fixtures.filter((fixture) =>
    fixture.expectedAssertions.includes('dcx-document'));
  const missingDcxFormats = ['DCX-DFLT', 'DCX-KRAK'].filter((format) =>
    !dcxFixtures.some((fixture) => fixture.format === format));
  if (missingRoles.length > 0 || missingDcxFormats.length > 0) {
    throw new NativeFixtureRegistryError(
      'NATIVE_FIXTURE_SUITE_INCOMPLETE',
      `严格私有门禁缺少 roles=[${missingRoles.join(', ')}]，DCX formats=[${missingDcxFormats.join(', ')}]。`
    );
  }
  const summary = summarizeNativeFixtureRegistry(registry, 20);
  report.steps.push({
    name: 'native-fixture-registry',
    ok: true,
    structured: {
      schemaVersion: summary.schemaVersion,
      registryDigest: summary.registryDigest,
      fixtureCount: summary.fixtureCount,
      fixtures: summary.fixtures,
      fixturesTruncated: summary.fixturesTruncated
    }
  });
} catch (error) {
  const known = error instanceof NativeFixtureRegistryError;
  report.ok = false;
  report.status = 'failed';
  report.message = '私有 native registry 无效或发布语料角色不完整；门禁未执行。';
  report.steps.push({
    name: 'native-fixture-registry',
    ok: false,
    code: known ? error.code : 'NATIVE_FIXTURE_REGISTRY_UNEXPECTED',
    message: known ? error.message : 'native fixture registry 校验发生未预期错误。',
    ...(known && error.fixtureId ? { fixtureId: error.fixtureId } : {})
  });
  const outPath = resolve(scratch, 'private-native-gate.json');
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
  process.exitCode = 1;
  process.exit();
}

const registeredEnvironment = {
  SOULFORGE_NATIVE_FIXTURE_REGISTRY: nativeRegistry,
  SOULFORGE_NATIVE_FIXTURE_BND4: registry.roles['bnd4-primary'].absolutePath,
  SOULFORGE_NATIVE_FIXTURE_FMG: registry.roles['fmg-primary'].absolutePath,
  SOULFORGE_NATIVE_FIXTURE_PARAM: registry.roles['param-primary'].absolutePath,
  SOULFORGE_NATIVE_FIXTURE_EMEVD: registry.roles['emevd-primary'].absolutePath,
  SOULFORGE_NATIVE_FIXTURE_MSB: registry.roles['msb-primary'].absolutePath
};

// Both roots are required. The first step must prove a real Sekiro runtime can
// decompress a real KRAK fixture; failure-close diagnostics are not sufficient.
const steps = [
  { name: 'bridge:verify:oodle:real', cmd: 'npm', args: ['run', 'bridge:verify:oodle:real'] },
  { name: 'bridge:verify:dcx-documents', cmd: 'npm', args: ['run', 'bridge:verify:dcx-documents'] },
  { name: 'bridge:verify:bnd4-writer', cmd: 'npm', args: ['run', 'bridge:verify:bnd4-writer'] },
  { name: 'bridge:verify:bnd4-transaction', cmd: 'npm', args: ['run', 'bridge:verify:bnd4-transaction'] },
  { name: 'bridge:verify:emevd:corpus', cmd: 'npm', args: ['run', 'bridge:verify:emevd:corpus'] },
  { name: 'bridge:verify:emevd:transaction', cmd: 'npm', args: ['run', 'bridge:verify:emevd:transaction'] },
  { name: 'bridge:verify:fmg', cmd: 'npm', args: ['run', 'bridge:verify:fmg'] },
  { name: 'bridge:verify:fmg:transaction', cmd: 'npm', args: ['run', 'bridge:verify:fmg:transaction'] },
  { name: 'bridge:verify:param', cmd: 'npm', args: ['run', 'bridge:verify:param'] },
  { name: 'bridge:verify:msb', cmd: 'npm', args: ['run', 'bridge:verify:msb'] },
  { name: 'bridge:verify:msb:transaction', cmd: 'npm', args: ['run', 'bridge:verify:msb:transaction'] }
];

let failed = false;
for (const step of steps) {
  const result = await runNativeGateCommand(step.cmd, step.args, {
    cwd: root,
    env: {
      ...process.env,
      SOULFORGE_SEKIRO_GAME_ROOT: sekiro,
      SOULFORGE_NATIVE_FIXTURE_ROOT: nativeFixture,
      ...registeredEnvironment
    }
  });
  const structured = extractLastJsonObject(`${result.stdout}\n${result.stderr}`);
  const assessment = assessNativeGateStep(result.exitCode ?? result.code, structured);
  const assertionReasons = assessRegisteredAssertions(step.name, structured, registry);
  // MSB part/region transform path may remain authority=candidate while still
  // providing explicit non-claim boundary evidence. Do not fail solely on that.
  if (step.name === 'bridge:verify:msb') {
    assessment.reasons = assessment.reasons.filter((reason) => reason !== 'authority-candidate');
  }
  assessment.reasons.push(...assertionReasons);
  const ok = assessment.reasons.length === 0;
  if (!ok) failed = true;
  report.steps.push({
    name: step.name,
    ok,
    code: result.exitCode ?? result.code,
    ...(result.spawnErrorCode ? { spawnErrorCode: result.spawnErrorCode } : {}),
    reasons: assessment.reasons,
    structured: summarizeNativeGateReport(structured)
  });
}

report.status = failed ? 'failed' : 'passed';
report.ok = !failed;
report.message = failed
  ? '私有 native 门禁有失败步骤；不得声明 V0.5 全绿。'
  : '私有 native 门禁步骤通过（仍不等于 section-28 真游戏启动）。';

const outPath = resolve(scratch, 'private-native-gate.json');
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
process.exitCode = failed ? 1 : 0;

function assessRegisteredAssertions(stepName, structured, loadedRegistry) {
  if (stepName === 'bridge:verify:param') {
    const fixture = loadedRegistry.roles['param-primary'];
    if (!fixture?.expectedAssertions.includes('param-field-staging-roundtrip')) return [];
    const evidence = structured?.fieldMutation;
    const offsets = evidence?.changedByteOffsets;
    if (evidence?.stagingRereadVerified !== true
      || !Array.isArray(offsets)
      || offsets.length === 0
      || offsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0)
      || evidence?.nonClaim !== 'fixture-only field; native .paramdef semantics remain unverified') {
      return ['param-field-staging-roundtrip-evidence-missing'];
    }
    return [];
  }
  if (stepName === 'bridge:verify:emevd:transaction') {
    const fixture = loadedRegistry.roles['emevd-primary'];
    const reasons = [];
    if (fixture?.expectedCapabilities.includes('reorder')
      && (structured?.eventReorderSemanticPatchIrCommitVerified !== true
        || structured?.eventSemanticHashIdentityVerified !== true)) {
      reasons.push('emevd-event-reorder-positive-evidence-missing');
    }
    if (fixture?.expectedCapabilities.includes('crud')
      && (structured?.eventAddSemanticPatchIrCommitVerified !== true
        || structured?.eventAddCanonicalHashVerified !== true
        || structured?.eventDeleteSemanticPatchIrCommitVerified !== true
        || structured?.eventSnapshotRoundTripVerified !== true
        || structured?.eventDuplicateSemanticPatchIrCommitVerified !== true
        || structured?.eventDuplicateSnapshotCloneVerified !== true
        || structured?.instructionAddSemanticPatchIrCommitVerified !== true
        || structured?.instructionAddBridgeAuthoredSnapshotVerified !== true
        || structured?.instructionAddNonCanonicalBase64Blocked !== true
        || structured?.instructionAddParameterCount !== 0
        || structured?.instructionAddLayerOffset !== -1
        || structured?.instructionDuplicateSemanticPatchIrCommitVerified !== true
        || structured?.instructionSnapshotCloneVerified !== true
        || structured?.instructionDeleteSemanticPatchIrCommitVerified !== true
        || structured?.instructionDeleteSnapshotRoundTripVerified !== true
        || !Number.isSafeInteger(structured?.deletedEventInstructionCount)
        || structured.deletedEventInstructionCount <= 0
        || !Number.isSafeInteger(structured?.duplicatedInstructionParameterCount)
        || structured.duplicatedInstructionParameterCount <= 0)) {
      reasons.push('emevd-event-instruction-crud-positive-evidence-missing');
    }
    if (fixture?.expectedCapabilities.includes('reorder')
      && (structured?.instructionReorderSemanticPatchIrCommitVerified !== true
        || structured?.instructionReorderCompleteOrderGuardVerified !== true)) {
      reasons.push('emevd-instruction-reorder-positive-evidence-missing');
    }
    if (fixture?.expectedCapabilities.includes('rollback-resource-entry')
      && (structured?.eventReorderResourceEntryRollbackVerified !== true
        || structured?.eventReorderAppendInverseVerified !== true
        || structured?.eventAddResourceEntryRollbackVerified !== true
        || structured?.eventDeleteResourceEntryRollbackVerified !== true
        || structured?.eventDuplicateResourceEntryRollbackVerified !== true
        || structured?.instructionAddResourceEntryRollbackVerified !== true
        || structured?.instructionDuplicateResourceEntryRollbackVerified !== true
        || structured?.instructionDeleteResourceEntryRollbackVerified !== true
        || structured?.instructionReorderResourceEntryRollbackVerified !== true)) {
      reasons.push('emevd-event-instruction-resource-entry-rollback-evidence-missing');
    }
    if (fixture?.expectedCapabilities.includes('rollback-operation')
      && (structured?.stagingRereadVerified !== true
        || structured?.patchIrCommitVerified !== true
        || structured?.operationRollbackVerified !== true
        || structured?.rollbackRestoredOuterBytes !== true
        || structured?.eventReorderOperationRollbackVerified !== true
        || structured?.eventAddOperationRollbackVerified !== true
        || structured?.eventDeleteOperationRollbackVerified !== true
        || structured?.eventDuplicateOperationRollbackVerified !== true
        || structured?.instructionAddOperationRollbackVerified !== true
        || structured?.instructionDuplicateOperationRollbackVerified !== true
        || structured?.instructionDeleteOperationRollbackVerified !== true
        || structured?.instructionReorderOperationRollbackVerified !== true)) {
      reasons.push('emevd-operation-rollback-evidence-missing');
    }
    if (structured?.originalFixtureUntouched !== true) {
      reasons.push('emevd-source-read-only-evidence-missing');
    }
    return reasons;
  }
  if (stepName === 'bridge:verify:fmg:transaction') {
    const fixture = loadedRegistry.roles['fmg-primary'];
    const reasons = [];
    if (fixture?.expectedCapabilities.includes('reorder')
      && (structured?.semanticPatchIrNodeReorderCommitVerified !== true
        || structured?.typedDuplicateDiffTextReorderVerified !== true)) {
      reasons.push('fmg-reorder-positive-evidence-missing');
    }
    if (fixture?.expectedCapabilities.includes('rollback-resource-entry')
      && structured?.reorderResourceEntryRollbackVerified !== true) {
      reasons.push('fmg-reorder-resource-entry-rollback-evidence-missing');
    }
    if (fixture?.expectedCapabilities.includes('rollback-operation')
      && structured?.reorderOperationRollbackVerified !== true) {
      reasons.push('fmg-reorder-operation-rollback-evidence-missing');
    }
    if (structured?.originalFixtureUntouched !== true) {
      reasons.push('fmg-source-read-only-evidence-missing');
    }
    return reasons;
  }
  if (stepName === 'bridge:verify:msb:transaction') {
    const fixture = loadedRegistry.roles['msb-primary'];
    const reasons = [];
    if (fixture?.expectedCapabilities.includes('write-staging')
      && (structured?.semanticPatchIrFieldCommitVerified !== true
        || structured?.partPositionResourceEntryRollbackVerified !== true
        || structured?.regionPositionResourceEntryRollbackVerified !== true)) {
      reasons.push('msb-part-region-position-positive-evidence-missing');
    }
    if (fixture?.expectedCapabilities.includes('rollback-resource-entry')
      && (structured?.partPositionResourceEntryRollbackVerified !== true
        || structured?.regionPositionResourceEntryRollbackVerified !== true)) {
      reasons.push('msb-part-region-resource-entry-rollback-evidence-missing');
    }
    if (structured?.originalDcxFixtureUntouched !== true
      || structured?.authorityStillCandidate !== true
      || structured?.fullEntityCrudClaimed !== false) {
      reasons.push('msb-authority-boundary-evidence-missing');
    }
    return reasons;
  }
  return [];
}
