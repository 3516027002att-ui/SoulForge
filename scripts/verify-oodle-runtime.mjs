import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const executable = resolve(
  process.argv[2] ?? 'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'
);
const root = await mkdtemp(join(tmpdir(), 'soulforge-oodle-runtime-'));
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const systemX64Dll = join(systemRoot, 'System32', 'version.dll');
const systemX86Dll = join(systemRoot, 'SysWOW64', 'version.dll');
const checks = [];

try {
  const krakPath = join(root, 'sample.krak.dcx');
  await writeFile(krakPath, buildKrakDcx());
  const krakWithoutRuntime = invoke('inspect', krakPath);
  requireDiagnostic(krakWithoutRuntime, 'OODLE_RUNTIME_ROOT_NOT_CONFIGURED');
  checks.push('KRAK without configured runtime is blocked');

  const notGame = await gameDirectory('not-game', false);
  requireDiagnostic(invoke('probe-oodle', notGame), 'OODLE_GAME_EXECUTABLE_MISSING');
  checks.push('non-Sekiro directory rejected');

  const missing = await gameDirectory('missing-runtime');
  requireDiagnostic(invoke('probe-oodle', missing), 'OODLE_RUNTIME_MISSING');
  checks.push('missing runtime diagnosed');

  const wrongVersion = await gameDirectory('wrong-version');
  await writeFile(join(wrongVersion, 'oo2core_8_win64.dll'), 'not-loaded');
  requireDiagnostic(invoke('probe-oodle', wrongVersion), 'OODLE_RUNTIME_VERSION_MISMATCH');
  checks.push('unexpected runtime major rejected');

  const invalidPe = await gameDirectory('invalid-pe');
  await writeFile(join(invalidPe, 'oo2core_6_win64.dll'), 'not-a-pe');
  requireDiagnostic(invoke('probe-oodle', invalidPe), 'OODLE_RUNTIME_INVALID_PE');
  checks.push('invalid PE rejected before load');

  if (process.arch === 'x64') {
    const wrongArchitecture = await gameDirectory('wrong-architecture');
    await copyFile(systemX86Dll, join(wrongArchitecture, 'oo2core_6_win64.dll'));
    requireDiagnostic(invoke('probe-oodle', wrongArchitecture), 'OODLE_RUNTIME_ARCHITECTURE_MISMATCH');
    checks.push('x86 runtime rejected');
  }

  const loadFailure = await gameDirectory('load-failure');
  const x64Bytes = await readFile(systemX64Dll);
  await writeFile(
    join(loadFailure, 'oo2core_6_win64.dll'),
    x64Bytes.subarray(0, Math.min(x64Bytes.length, 4096))
  );
  requireDiagnostic(invoke('probe-oodle', loadFailure), 'OODLE_RUNTIME_LOAD_FAILED');
  checks.push('unloadable x64 PE diagnosed');

  const missingExport = await gameDirectory('missing-export');
  await copyFile(systemX64Dll, join(missingExport, 'oo2core_6_win64.dll'));
  const exportResult = invoke('probe-oodle', missingExport);
  requireDiagnostic(exportResult, 'OODLE_RUNTIME_EXPORT_MISSING');
  const publicRuntime = exportResult.data?.runtime;
  if (JSON.stringify(publicRuntime).toLowerCase().includes(root.toLowerCase())) {
    throw new Error('Oodle public capability data leaked an absolute runtime path.');
  }
  checks.push('required export validation and path redaction');

  const krakWithInvalidRuntime = invoke('inspect', krakPath, {
    SOULFORGE_SEKIRO_GAME_ROOT: missingExport
  });
  requireDiagnostic(krakWithInvalidRuntime, 'OODLE_RUNTIME_EXPORT_MISSING');
  if (findDiagnostic(krakWithInvalidRuntime, 'DCX_KRAK_DECOMPRESSED_PREVIEW_READY')) {
    throw new Error('KRAK preview claimed success with an incompatible runtime.');
  }
  checks.push('KRAK remains blocked when runtime exports are incompatible');

  let realRuntimeSuccessPath = 'unverified-no-local-sekiro-runtime';
  const configuredGameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (configuredGameRoot) {
    const probe = invoke('probe-oodle', configuredGameRoot, {
      SOULFORGE_SEKIRO_GAME_ROOT: configuredGameRoot
    });
    requireDiagnostic(probe, 'OODLE_RUNTIME_READY');
    checks.push('configured Sekiro runtime exposes compatible compress/decompress exports');
    realRuntimeSuccessPath = 'runtime-ready';

    const configuredKrak = await resolveConfiguredKrakFixture();
    if (configuredKrak) {
      const preview = invoke('inspect', configuredKrak, {
        SOULFORGE_SEKIRO_GAME_ROOT: configuredGameRoot
      });
      requireDiagnostic(preview, 'DCX_KRAK_DECOMPRESSED_PREVIEW_READY');
      checks.push('registered KRAK fixture decompresses with configured Sekiro runtime');
      realRuntimeSuccessPath = 'krak-decompress-preview-verified';
    }
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'Oodle/KRAK 运行库失败关闭与可用成功路径验证通过',
    checks,
    realRuntimeSuccessPath
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function resolveConfiguredKrakFixture() {
  const registryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!registryPath || !fixtureRoot) return undefined;
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  if (registry.schemaVersion !== '1.0.0' || !Array.isArray(registry.fixtures)) {
    throw new Error('NATIVE_FIXTURE_REGISTRY_INVALID: schemaVersion/fixtures 不符合 1.0.0 契约。');
  }
  const matches = registry.fixtures.filter((item) => item.format === 'DCX-KRAK');
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new Error('NATIVE_FIXTURE_KRAK_AMBIGUOUS: registry 中 DCX-KRAK fixture 不唯一。');
  }
  const fixture = matches[0];
  if (fixture.game !== 'sekiro'
    || typeof fixture.fixtureId !== 'string' || !fixture.fixtureId.trim()
    || typeof fixture.localPath !== 'string' || !fixture.localPath.trim()
    || !/^[a-f0-9]{64}$/i.test(fixture.sha256 ?? '')) {
    throw new Error('NATIVE_FIXTURE_KRAK_INVALID: KRAK fixture 元数据不完整。');
  }

  const root = await realpath(resolve(fixtureRoot));
  const candidate = isAbsolute(fixture.localPath)
    ? resolve(fixture.localPath)
    : resolve(root, fixture.localPath);
  const path = await realpath(candidate);
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('NATIVE_FIXTURE_OUTSIDE_ROOT: KRAK fixture 越出 fixture root。');
  }
  if (await sha256File(path) !== fixture.sha256.toLowerCase()) {
    throw new Error('NATIVE_FIXTURE_HASH_MISMATCH: KRAK fixture 注册哈希与文件不一致。');
  }
  return path;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function gameDirectory(name, includeExecutable = true) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  if (includeExecutable) await writeFile(join(directory, 'sekiro.exe'), 'synthetic-marker');
  return directory;
}

function invoke(command, targetPath, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!Object.hasOwn(extraEnv, 'SOULFORGE_SEKIRO_GAME_ROOT')) {
    delete env.SOULFORGE_SEKIRO_GAME_ROOT;
  }
  const result = spawnSync(executable, [command, targetPath], {
    encoding: 'utf8',
    windowsHide: true,
    env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.status}: ${result.stderr}\n${result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Bridge returned invalid JSON for ${command}: ${error.message}\n${result.stdout}`);
  }
}

function requireDiagnostic(result, code) {
  if (!findDiagnostic(result, code)) {
    throw new Error(`Expected diagnostic ${code}, got ${JSON.stringify(result.diagnostics)}`);
  }
}

function findDiagnostic(result, code) {
  return Array.isArray(result.diagnostics)
    && result.diagnostics.some((diagnostic) => diagnostic?.code === code);
}

function buildKrakDcx() {
  const compressed = Buffer.from('synthetic-not-oodle', 'ascii');
  const uncompressedSize = 64;
  return Buffer.concat([
    Buffer.from([0x44, 0x43, 0x58, 0x00]),
    beU32(0x00011000),
    beU32(0x18),
    beU32(0x24),
    beU32(0x44),
    beU32(0x4c),
    Buffer.from([0x44, 0x43, 0x53, 0x00]),
    beU32(uncompressedSize),
    beU32(compressed.length),
    Buffer.from([0x44, 0x43, 0x50, 0x00]),
    Buffer.from('KRAK', 'ascii'),
    beU32(0x20),
    Buffer.from([0x06, 0x00, 0x00, 0x00]),
    beU32(0),
    beU32(0),
    beU32(0),
    beU32(0x00010100),
    Buffer.from([0x44, 0x43, 0x41, 0x00]),
    beU32(0x08),
    compressed
  ]);
}

function beU32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}
