/**
 * Contract tests for native gates that depend on private/local assets.
 * A missing environment must fail closed unless --allow-skip is explicit.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessNativeGateStep, extractLastJsonObject } from './native-gate-report.mjs';
import { runNativeGateCommand } from './native-gate-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanEnv = { ...process.env };
delete cleanEnv.SOULFORGE_SEKIRO_GAME_ROOT;
delete cleanEnv.SOULFORGE_NATIVE_FIXTURE_ROOT;
delete cleanEnv.SOULFORGE_NATIVE_FIXTURE_REGISTRY;

const checks = [];

assertRealGateMissingEnvironment();
assertEmevdCorpusMissingEnvironment();
assertDcxCorpusMissingEnvironment();
assertSkippableGate('scripts/verify-private-native-gate.mjs', 'private-native');
assertPrivateGateRejectsPartialEnvironment();
assertSkippableGate('scripts/verify-section28-sekiro-gate.mjs', 'section-28-sekiro-launch-rollback');
assertStructuredAssessment();
await assertGateProcessRunner();
await assertRegistryContract();

console.log(JSON.stringify({
  ok: true,
  status: 'passed',
  checks
}, null, 2));

function assertRealGateMissingEnvironment() {
  const result = run('scripts/verify-real-oodle-krak.mjs');
  const report = parseJson(result.stderr, '真实 Oodle/KRAK 门禁 stderr');
  assert(result.status === 2, `真实 Oodle/KRAK 门禁缺环境时应退出 2，实际为 ${result.status}`);
  assert(report.ok === false && report.code === 'REAL_OODLE_ENVIRONMENT_REQUIRED',
    '真实 Oodle/KRAK 门禁缺环境时必须返回结构化失败。');
  checks.push('real Oodle/KRAK gate fails closed without all private inputs');
}

function assertEmevdCorpusMissingEnvironment() {
  const result = run('scripts/verify-native-emevd-corpus.mjs');
  const report = parseJson(result.stderr, 'EMEVD corpus missing-env stderr');
  assert(result.status === 2
    && report.code === 'EMEVD_CORPUS_ENVIRONMENT_REQUIRED'
    && report.ok === false,
  'EMEVD corpus 缺少 registry/root 时必须失败关闭。');
  checks.push('EMEVD corpus fails closed without private registry inputs');
}

function assertDcxCorpusMissingEnvironment() {
  const result = run('scripts/verify-native-dcx-documents.mjs');
  const report = parseJson(result.stdout, 'DCX corpus missing-env stdout');
  assert(result.status === 2
    && report.ok === false
    && report.status === 'failed'
    && report.failures?.[0]?.diagnostics?.[0]?.code === 'DCX_CORPUS_REGISTRY_ENVIRONMENT_REQUIRED',
  'DCX corpus 缺少 registry/root 时必须失败关闭，不能扫描默认目录。');
  checks.push('DCX corpus fails closed instead of scanning an unregistered directory');
}

function assertSkippableGate(script, expectedGate) {
  const strict = run(script);
  const strictReport = parseJson(strict.stdout, `${expectedGate} strict stdout`);
  assert(strict.status === 2, `${expectedGate} strict 缺环境时应退出 2，实际为 ${strict.status}`);
  assert(strictReport.gate === expectedGate && strictReport.status === 'skipped' && strictReport.ok === false,
    `${expectedGate} strict 缺环境时必须记录 skipped 且不得通过。`);

  const allowed = run(script, ['--allow-skip']);
  const allowedReport = parseJson(allowed.stdout, `${expectedGate} allow-skip stdout`);
  assert(allowed.status === 0, `${expectedGate} allow-skip 应退出 0，实际为 ${allowed.status}`);
  assert(allowedReport.gate === expectedGate && allowedReport.status === 'skipped' && allowedReport.ok === true,
    `${expectedGate} allow-skip 必须保留 skipped 状态。`);
  checks.push(`${expectedGate} distinguishes strict failure from explicit allow-skip`);
}

function assertPrivateGateRejectsPartialEnvironment() {
  const partial = run(
    'scripts/verify-private-native-gate.mjs',
    ['--allow-skip'],
    { SOULFORGE_NATIVE_FIXTURE_ROOT: 'configured-but-incomplete' }
  );
  const report = parseJson(partial.stdout, 'private-native partial stdout');
  assert(partial.status === 2, `private-native 部分配置即使 allow-skip 也应退出 2，实际为 ${partial.status}`);
  assert(report.gate === 'private-native' && report.status === 'failed' && report.ok === false,
    'private-native 部分配置不得被 allow-skip 降级为公开 CI 跳过。');
  assert(report.steps?.[0]?.skipped === false && report.steps?.[0]?.configuration === 'partial',
    'private-native 部分配置必须标为 configuration failure，而不是 skipped step。');
  assert(Array.isArray(report.steps?.[0]?.missing)
    && report.steps[0].missing.includes('SOULFORGE_NATIVE_FIXTURE_REGISTRY'),
  'private-native 部分配置必须明确报告缺失的 registry。');
  checks.push('private-native rejects partial environment even with explicit allow-skip');
}

function assertStructuredAssessment() {
  const mixedOutput = 'npm banner\n{"ok":true,"status":"passed","nested":{"value":"}"}}\nnpm trailer';
  const extracted = extractLastJsonObject(mixedOutput);
  assert(extracted?.nested?.value === '}', '必须从 npm 混合输出中提取完整结构化结果。');
  assert(assessNativeGateStep(0, extracted).ok, '完整 passed 结构化结果应通过。');
  assert(!assessNativeGateStep(0, { ok: true, corpusFailed: 2, failures: [] }).ok,
    'corpusFailed 非零时不得通过。');
  assert(!assessNativeGateStep(0, { ok: true, authority: 'candidate' }).ok,
    'candidate authority 不得通过。');
  assert(!assessNativeGateStep(0, { ok: true, status: 'partial' }).ok,
    'partial status 不得通过。');
  assert(!assessNativeGateStep(0, undefined).ok, '缺少结构化结果不得通过。');
  checks.push('private native gate rejects partial/candidate/corpus failures even with exit code 0');
}

async function assertGateProcessRunner() {
  const result = await runNativeGateCommand('npm', ['--version'], {
    cwd: root,
    env: cleanEnv
  });
  assert(result.code === 0 && /^\d+\.\d+\.\d+$/.test(result.stdout.trim()),
    `native gate npm 子进程必须可启动，实际 code=${result.code} error=${result.spawnErrorCode ?? 'none'}。`);
  checks.push('native gate launches npm through a Windows-safe process boundary');
}

async function assertRegistryContract() {
  const schema = JSON.parse(await readFile(
    resolve(root, 'schemas/native-fixture-registry.schema.json'),
    'utf8'
  ));
  const requiredFields = [
    'fixtureId', 'localPath', 'sha256', 'game', 'format', 'variant',
    'expectedAuthority', 'expectedCapabilities', 'expectedAssertions'
  ];
  assert(requiredFields.every((field) => schema.$defs?.fixture?.required?.includes(field)),
    '提交的 registry schema 必须包含交接书规定的全部必填字段。');
  const localPathPattern = new RegExp(schema.$defs.fixture.properties.localPath.pattern);
  assert(localPathPattern.test('param/synthetic.param')
    && !localPathPattern.test('../outside.param')
    && !localPathPattern.test('param//synthetic.param')
    && !localPathPattern.test('param/./synthetic.param')
    && !localPathPattern.test('param\\synthetic.param'),
  'registry schema 与 runner 必须一致拒绝越界、空段、点段和反斜杠路径。');
  const nativeFixtureResolver = await readFile(
    resolve(root, 'packages/core/src/testing/nativeFixturePaths.ts'),
    'utf8'
  );
  assert(nativeFixtureResolver.includes('NATIVE_FIXTURE_REGISTRY_ENVIRONMENT_REQUIRED')
    && nativeFixtureResolver.includes('loadNativeFixtureRegistry')
    && !nativeFixtureResolver.includes("resolve(repositoryRoot, 'mods')")
    && !nativeFixtureResolver.includes("process.argv[argumentIndex]?.trim();\n  const registered"),
  'typed native runner 必须先校验 registry/hash，且不能保留仓库 mods 或未校验路径回退。');

  const base = await mkdtemp(join(tmpdir(), 'soulforge-native-registry-contract-'));
  const fixtureRoot = join(base, 'fixtures');
  const registryPath = join(base, 'registry.json');
  const fixtureBytes = Buffer.from('SoulForge synthetic native registry contract', 'utf8');
  const fixturePath = join(fixtureRoot, 'param', 'synthetic.param');
  const entry = {
    fixtureId: 'synthetic-param-primary',
    localPath: 'param/synthetic.param',
    sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
    game: 'sekiro',
    format: 'PARAM',
    variant: 'synthetic-contract-only',
    expectedAuthority: 'fixture-confirmed',
    expectedCapabilities: ['parse', 'roundtrip-byte'],
    expectedAssertions: ['param-byte-roundtrip'],
    testRole: 'param-primary'
  };
  try {
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, fixtureBytes);
    await writeFile(registryPath, JSON.stringify({ schemaVersion: '1.0.0', fixtures: [entry] }));

    const valid = run('scripts/verify-native-fixture-registry.mjs', [registryPath, fixtureRoot]);
    const validReport = parseJson(valid.stdout, 'native registry valid stdout');
    assert(valid.status === 0 && validReport.ok === true && validReport.fixtureCount === 1,
      '合法 registry 必须完成文件/hash 校验。');
    assert(!valid.stdout.includes('localPath') && !valid.stdout.includes(fixtureRoot),
      'registry 公共输出不得泄漏 localPath 或 fixture root。');
    assert(Object.keys(validReport.fixtures[0]).every((key) =>
      ['fixtureId', 'sha256', 'variant', 'assertions'].includes(key)),
    'registry fixture 摘要只能输出 id、hash、variant 和断言。');

    await writeFile(registryPath, JSON.stringify({
      schemaVersion: '1.0.0',
      fixtures: [{
        ...entry,
        expectedAssertions: [...entry.expectedAssertions, 'param-semantic-roundtrip']
      }]
    }));
    const changedSemantics = run('scripts/verify-native-fixture-registry.mjs', [registryPath, fixtureRoot]);
    const changedSemanticsReport = parseJson(changedSemantics.stdout, 'native registry semantic digest stdout');
    assert(changedSemantics.status === 0
      && changedSemanticsReport.registryDigest !== validReport.registryDigest,
    'registry digest 必须绑定 authority/capability/assertion 等验收语义，不能只绑定 fixture hash。');
    await writeFile(registryPath, JSON.stringify({ schemaVersion: '1.0.0', fixtures: [entry] }));

    const incompleteGate = run('scripts/verify-private-native-gate.mjs', [], {
      SOULFORGE_SEKIRO_GAME_ROOT: fixtureRoot,
      SOULFORGE_NATIVE_FIXTURE_ROOT: fixtureRoot,
      SOULFORGE_NATIVE_FIXTURE_REGISTRY: registryPath,
      SOULFORGE_SCRATCH: join(base, 'scratch')
    });
    const incompleteGateReport = parseJson(incompleteGate.stdout, 'private native incomplete registry stdout');
    assert(incompleteGate.status === 1
      && incompleteGateReport.status === 'failed'
      && incompleteGateReport.steps?.[0]?.code === 'NATIVE_FIXTURE_SUITE_INCOMPLETE',
    '严格私有门禁必须在运行 native 命令前拒绝角色或 DCX 断言不完整的 registry。');
    assert(!incompleteGate.stdout.includes(fixtureRoot),
      '严格私有门禁的 registry 失败报告不得泄漏 fixture root。');

    await writeFile(registryPath, JSON.stringify({
      schemaVersion: '1.0.0',
      fixtures: [{ ...entry, sha256: '0'.repeat(64) }]
    }));
    const wrongHash = run('scripts/verify-native-fixture-registry.mjs', [registryPath, fixtureRoot]);
    const wrongHashReport = parseJson(wrongHash.stderr, 'native registry hash stderr');
    assert(wrongHash.status === 1 && wrongHashReport.code === 'NATIVE_FIXTURE_HASH_MISMATCH',
      'registry hash 不匹配必须结构化失败。');
    assert(!wrongHash.stderr.includes(fixtureRoot), 'registry 失败输出不得泄漏 fixture root。');

    await writeFile(registryPath, JSON.stringify({
      schemaVersion: '1.0.0',
      fixtures: [{ ...entry, localPath: '../outside.param' }]
    }));
    const traversal = run('scripts/verify-native-fixture-registry.mjs', [registryPath, fixtureRoot]);
    const traversalReport = parseJson(traversal.stderr, 'native registry traversal stderr');
    assert(traversal.status === 1 && traversalReport.code === 'NATIVE_FIXTURE_LOCAL_PATH_INVALID',
      'registry 路径穿越必须在文件访问前拒绝。');
    checks.push('private native registry validates schema/path/hash/suite, binds assertion semantics, and redacts local paths');
    checks.push('typed native runners require registry/hash-bound fixture resolution');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function run(script, args = [], extraEnv = {}) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    env: { ...cleanEnv, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) throw result.error;
  return result;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
