import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadNativeFixtureRegistry,
  NativeFixtureRegistryError
} from './native-fixture-registry.mjs';
import { runNativeGateCommand } from './native-gate-process.mjs';
import { assessNativeGateStep, extractLastJsonObject } from './native-gate-report.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const registryPath = process.argv[2]
  ?? process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
const fixtureRoot = process.argv[3]
  ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();

if (!registryPath || !fixtureRoot) {
  fail('EMEVD_CORPUS_ENVIRONMENT_REQUIRED', 'EMEVD corpus 要求仓库外 registry 与 fixture root。', 2);
}

let registry;
try {
  registry = await loadNativeFixtureRegistry({ registryPath, fixtureRoot });
} catch (error) {
  const known = error instanceof NativeFixtureRegistryError;
  fail(
    known ? error.code : 'EMEVD_CORPUS_REGISTRY_FAILED',
    known ? error.message : 'EMEVD corpus registry 校验发生未预期错误。',
    1
  );
}

const fixtures = registry.fixtures.filter((fixture) => fixture.format === 'EMEVD');
if (fixtures.length === 0) {
  fail('EMEVD_CORPUS_EMPTY', 'registry 没有登记 EMEVD fixture。', 1);
}

const runnerPath = resolve(root, 'packages/core/dist/testing/runNativeEmevdSmoke.js');
if (!existsSync(runnerPath)) {
  fail('EMEVD_CORPUS_RUNNER_NOT_BUILT', '请先构建 @soulforge/core 再运行 EMEVD corpus。', 1);
}

const verifiedFixtures = [];
const failures = [];
let totalEvents = 0;
let totalInstructions = 0;
let layerCountZero = 0;
let layerCountNonZero = 0;
let duplicateIdFixtureCount = 0;
let instructionCrudFixtureCount = 0;
let parameterRemapFixtureCount = 0;
let dfltWrapperCount = 0;
let containerByteIdenticalCount = 0;

for (const fixture of fixtures) {
  const result = await runNativeGateCommand(process.execPath, [runnerPath, fixture.absolutePath], {
    cwd: root,
    env: process.env
  });
  const structured = extractLastJsonObject(`${result.stdout}\n${result.stderr}`);
  const assessment = assessNativeGateStep(result.exitCode ?? result.code, structured);
  const assertionReasons = assessAssertions(fixture, structured);
  const reasons = [...assessment.reasons, ...assertionReasons];
  if (reasons.length > 0) {
    failures.push({
      fixtureId: fixture.fixtureId,
      sha256: fixture.actualSha256,
      variant: fixture.variant,
      reasons
    });
    continue;
  }

  const eventCount = Number(structured.eventCount);
  const instructionCount = Number(structured.instructionCount);
  const layerCount = Number(structured.layerCount);
  totalEvents += eventCount;
  totalInstructions += instructionCount;
  if (layerCount === 0) layerCountZero += 1;
  else layerCountNonZero += 1;
  if (structured.containerKind === 'dcx' && structured.compressionFormat === 'DFLT') {
    dfltWrapperCount += 1;
  }
  if (structured.containerByteIdenticalNoop === true) containerByteIdenticalCount += 1;
  const duplicateIdIdentityVerified = structured.duplicateIdIdentity?.ambiguousIdBlocked === true
    && structured.duplicateIdIdentity?.indexTargetVerified === true
    && structured.duplicateIdIdentity?.inverseHashRestored === true;
  if (duplicateIdIdentityVerified) duplicateIdFixtureCount += 1;
  const instructionCrudVerified = structured.instructionCrud?.identityMismatchBlocked === true
    && structured.instructionCrud?.addDeleteHashRestored === true
    && structured.instructionCrud?.duplicateDeleteHashRestored === true
    && structured.instructionCrud?.reorderInverseHashRestored === true
    && structured.instructionCrud?.hashScope === 'emevd-document-payload';
  const parameterRemapVerified = instructionCrudVerified
    && structured.instructionCrud?.parameterSubstitutionRemapCovered === true
    && structured.instructionCrud?.parameterCount > 0
    && structured.instructionCrud?.clonedParameterCount > 0;
  if (instructionCrudVerified) instructionCrudFixtureCount += 1;
  if (parameterRemapVerified) parameterRemapFixtureCount += 1;
  verifiedFixtures.push({
    fixtureId: fixture.fixtureId,
    sha256: fixture.actualSha256,
    variant: fixture.variant,
    authority: structured.authority,
    eventCount,
    instructionCount,
    layerCount,
    containerKind: structured.containerKind,
    compressionFormat: structured.compressionFormat,
    containerByteIdenticalNoop: structured.containerByteIdenticalNoop === true,
    duplicateIdIdentityVerified,
    instructionCrudVerified,
    parameterRemapVerified,
    assertionsVerified: fixture.expectedAssertions
  });
}

const ok = verifiedFixtures.length === fixtures.length && failures.length === 0;
console.log(JSON.stringify({
  ok,
  status: ok ? 'passed' : 'failed',
  message: ok
    ? '登记 EMEVD corpus 的无修改往返与 writer 断言全部通过。'
    : '登记 EMEVD corpus 存在失败；不得提升发布 authority。',
  corpusSampled: fixtures.length,
  corpusVerified: verifiedFixtures.length,
  corpusFailed: failures.length,
  totalEvents,
  totalInstructions,
  layerCountZero,
  layerCountNonZero,
  duplicateIdFixtureCount,
  instructionCrudFixtureCount,
  parameterRemapFixtureCount,
  dfltWrapperCount,
  containerByteIdenticalCount,
  fixtures: verifiedFixtures.slice(0, 200),
  fixturesTruncated: verifiedFixtures.length > 200,
  failures: failures.slice(0, 20),
  failuresTruncated: failures.length > 20,
  nonClaim: layerCountNonZero === 0
    ? 'registered corpus has no layer table; layerCount>0 remains unverified'
    : undefined
}, null, 2));
process.exitCode = ok ? 0 : 1;

function assessAssertions(fixture, report) {
  if (!report || typeof report !== "object") return ["emevd-structured-report-missing"];
  const reasons = [];
  if (!authorityAtLeast(report.authority, fixture.expectedAuthority)) {
    reasons.push("authority-below-" + fixture.expectedAuthority);
  }
  const checks = {
    "emevd-byte-roundtrip": report.byteIdenticalNoop === true,
    "emevd-semantic-roundtrip": report.semanticIdenticalNoop === true,
    "emevd-rest-behavior-roundtrip": report.restMutationVerified === true,
    "emevd-instruction-args-roundtrip": report.instructionArgsMutationVerified === true,
    "emevd-variable-args-roundtrip": report.variableLengthArgsMutationVerified === true,
    "emevd-instruction-crud": report.instructionCrudVerified === true,
    "instruction-crud": report.instructionCrudVerified === true,
    "emevd-event-crud": report.eventCrudVerified === true,
    "emevd-duplicate-id-identity": report.duplicateIdIdentityVerified === true,
    "emevd-parameter-substitution-remap": report.parameterRemapVerified === true,
    "emevd-document": report.ok === true
      && report.eventCount > 0
      && report.instructionCount > 0
      && report.positiveInstructionCountVerified === true,
    "emevd-dflt-wrapper-staging-roundtrip": report.containerKind === "dcx"
      && report.compressionFormat === "DFLT"
      && report.containerByteIdenticalNoop === true
      && report.containerPayloadIdenticalNoop === true,
    "emevd-layer-count-zero": report.layerCount === 0,
    "path-exists": report.ok === true,
    "sha256-match": report.ok === true,
    "format-declared": report.ok === true
  };
  for (const assertion of fixture.expectedAssertions) {
    if (checks[assertion] !== true) reasons.push("assertion-" + assertion + "-missing");
  }
  return reasons;
}
function authorityAtLeast(actual, expected) {
  const rank = { candidate: 0, 'fixture-confirmed': 1, 'native-verified': 2 };
  return Number.isInteger(rank[actual]) && rank[actual] >= rank[expected];
}

function fail(code, message, exitCode) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code, message }));
  process.exit(exitCode);
}
