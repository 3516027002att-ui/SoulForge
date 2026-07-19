/**
 * Strict real-runtime gate for Sekiro Oodle/KRAK.
 * The KRAK document must be explicitly registered and hash-bound. The gate
 * never scans for a convenient file and never falls back to synthetic bytes.
 */
import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadNativeFixtureRegistry,
  NativeFixtureRegistryError
} from './native-fixture-registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executableInput =
  process.argv[2] ?? 'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe';
const executable = isAbsolute(executableInput) ? executableInput : resolve(root, executableInput);
const sekiroRootInput = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
const fixtureRootInput = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() || '';
const registryInput = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() || '';

const missingEnvironment = [
  ...(!sekiroRootInput ? ['SOULFORGE_SEKIRO_GAME_ROOT'] : []),
  ...(!fixtureRootInput ? ['SOULFORGE_NATIVE_FIXTURE_ROOT'] : []),
  ...(!registryInput ? ['SOULFORGE_NATIVE_FIXTURE_REGISTRY'] : [])
];
if (missingEnvironment.length > 0) {
  fail(
    'REAL_OODLE_ENVIRONMENT_REQUIRED',
    '真实 Oodle/KRAK 门禁要求游戏目录、私有语料目录和 registry 同时存在。',
    2,
    missingEnvironment.map((name) => ({ code: 'ENVIRONMENT_MISSING', name }))
  );
}

const sekiroRoot = await resolveSafeDirectory(
  sekiroRootInput,
  'REAL_OODLE_GAME_ROOT_UNSAFE',
  'Sekiro 游戏目录'
);

let registry;
try {
  registry = await loadNativeFixtureRegistry({
    registryPath: registryInput,
    fixtureRoot: fixtureRootInput
  });
} catch (error) {
  const known = error instanceof NativeFixtureRegistryError;
  fail(
    known ? error.code : 'NATIVE_FIXTURE_REGISTRY_UNEXPECTED',
    known ? error.message : '私有 native registry 校验发生未预期错误。',
    1,
    [{
      code: known ? error.code : 'NATIVE_FIXTURE_REGISTRY_UNEXPECTED',
      ...(known && error.fixtureId ? { fixtureId: error.fixtureId } : {})
    }]
  );
}

const krakFixture = registry.fixtures.find((fixture) =>
  fixture.format === 'DCX-KRAK'
  && fixture.expectedAssertions.includes('dcx-document'));
if (!krakFixture) {
  fail(
    'REAL_KRAK_FIXTURE_NOT_REGISTERED',
    'registry 没有登记带 dcx-document 断言的 KRAK fixture。',
    2,
    [{ code: 'REQUIRED_FIXTURE_MISSING', assertion: 'dcx-document' }]
  );
}

const probe = invoke('probe-oodle', sekiroRoot);
const runtime = probe.data?.runtime;
if (runtime?.status !== 'ready'
  || !['decompress-only', 'compress-decompress'].includes(runtime?.capability)) {
  fail(
    'REAL_OODLE_RUNTIME_NOT_READY',
    'Sekiro Oodle runtime 未达到真实解压就绪状态。',
    1,
    [
      {
        code: 'OODLE_RUNTIME_NOT_READY',
        status: runtime?.status ?? 'unknown',
        capability: runtime?.capability ?? 'none'
      },
      ...diagnosticCodes(probe)
    ]
  );
}

const document = invoke('read-dcx-document', krakFixture.absolutePath, {
  SOULFORGE_SEKIRO_GAME_ROOT: sekiroRoot
});
const sourceHashMatchesRegistry = document.data?.sourceHash === krakFixture.actualSha256;
if (document.parseStatus === 'failed'
  || document.data?.compressionFormat !== 'KRAK'
  || !sourceHashMatchesRegistry
  || !/^[a-f0-9]{64}$/.test(document.data?.payloadHash ?? '')
  || !(document.data?.uncompressedSize > 0)
  || typeof document.data?.payloadPrefixHex !== 'string') {
  fail(
    'REAL_KRAK_DECOMPRESSION_NOT_VERIFIED',
    '登记的真实 KRAK 文档没有完成可验证解压。',
    1,
    [
      {
        code: 'KRAK_DOCUMENT_ASSERTION_FAILED',
        fixtureId: krakFixture.fixtureId,
        parseStatus: document.parseStatus,
        compressionFormat: document.data?.compressionFormat ?? 'unknown',
        sourceHashMatchesRegistry
      },
      ...diagnosticCodes(document)
    ]
  );
}

console.log(JSON.stringify({
  ok: true,
  status: 'passed',
  message: '合法 Sekiro Oodle runtime 与已登记真实 KRAK 解压验证通过',
  fixture: {
    fixtureId: krakFixture.fixtureId,
    sha256: krakFixture.actualSha256,
    variant: krakFixture.variant,
    assertions: [...new Set([
      ...krakFixture.expectedAssertions,
      'source-hash-matches-registry',
      'krak-decompression-complete'
    ])]
  },
  diagnostics: [
    {
      code: 'OODLE_RUNTIME_VERIFIED',
      runtimeHash: runtime.sha256,
      runtimeMajor: runtime.runtimeMajor,
      architecture: runtime.architecture,
      capability: runtime.capability
    },
    {
      code: 'KRAK_DECOMPRESSION_VERIFIED',
      sourceHash: document.data.sourceHash,
      payloadHash: document.data.payloadHash,
      compressedSize: document.data.compressedSize,
      uncompressedSize: document.data.uncompressedSize
    },
    {
      code: 'SCOPE_NON_CLAIM',
      message: '本门禁只证明真实 KRAK 解压，不证明 KRAK 重压或完整 P2。'
    }
  ]
}, null, 2));

async function resolveSafeDirectory(input, code, label) {
  const lexicalPath = resolve(input);
  try {
    const lexicalStat = await lstat(lexicalPath);
    if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) {
      fail(code, `${label}必须是已存在的真实目录，不能是符号链接。`, 2, [{ code }]);
    }
    return await realpath(lexicalPath);
  } catch (error) {
    fail(code, `${label}不可访问或不是合法目录。`, 2, [{
      code,
      errorCode: error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'UNKNOWN'
    }]);
  }
}

function invoke(command, targetPath, extraEnv = {}) {
  const result = spawnSync(executable, [command, targetPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv }
  });
  if (result.error) {
    fail('REAL_OODLE_BRIDGE_START_FAILED', `${command} 无法启动。`, 1, [{
      code: 'BRIDGE_START_FAILED',
      errorCode: result.error.code ?? 'UNKNOWN'
    }]);
  }
  if (result.status !== 0) {
    let structured;
    try {
      structured = JSON.parse(result.stdout);
    } catch {
      structured = undefined;
    }
    fail('REAL_OODLE_BRIDGE_FAILED', `${command} 执行失败。`, 1, [
      { code: 'BRIDGE_EXIT_NONZERO', exitCode: result.status },
      ...diagnosticCodes(structured)
    ]);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('REAL_OODLE_BRIDGE_INVALID_JSON', `${command} 没有返回合法 JSON。`, 1, [
      { code: 'BRIDGE_INVALID_JSON' }
    ]);
  }
}

function diagnosticCodes(report) {
  if (!Array.isArray(report?.diagnostics)) return [];
  return report.diagnostics.slice(0, 50).map((diagnostic) => ({
    code: typeof diagnostic?.code === 'string' ? diagnostic.code : 'UNKNOWN_DIAGNOSTIC',
    ...(typeof diagnostic?.severity === 'string' ? { severity: diagnostic.severity } : {})
  }));
}

function fail(code, message, exitCode = 1, diagnostics = []) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code, message, diagnostics }, null, 2));
  process.exit(exitCode);
}
